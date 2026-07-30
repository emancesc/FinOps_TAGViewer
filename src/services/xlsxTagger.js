import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import fs from 'fs/promises';
import path from 'path';
import { getLLM } from './llm.js';
import { runQuery } from './db.js';

const BATCH_SIZE = 15;
const SYSTEM_PROMPT = `Sei un esperto FinOps AWS. Analizzi risorse AWS e assegni tag secondo la strategia di tagging CINECA. Rispondi SOLO con un array JSON valido, senza markdown, senza spiegazioni extra.`;

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------
const _xlsxJobs = new Map();

export function getXlsxTaggingProgress(projectId) {
  return _xlsxJobs.get(projectId) || null;
}

function setXlsxProgress(projectId, patch) {
  const current = _xlsxJobs.get(projectId) || {};
  _xlsxJobs.set(projectId, { ...current, ...patch });
}

// ---------------------------------------------------------------------------
// Pause / Resume
// ---------------------------------------------------------------------------
export function pauseXlsxTagging(projectId) {
  const job = _xlsxJobs.get(projectId);
  if (job && job.status === 'running') setXlsxProgress(projectId, { status: 'paused' });
}

export function resumeXlsxTagging(projectId) {
  const job = _xlsxJobs.get(projectId);
  if (job && job.status === 'paused') setXlsxProgress(projectId, { status: 'running' });
}

function waitIfPaused(projectId) {
  return new Promise(resolve => {
    const check = () => {
      const job = _xlsxJobs.get(projectId);
      if (!job || job.status !== 'paused') return resolve();
      setTimeout(check, 400);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// A) Detect columns
// ---------------------------------------------------------------------------
export async function detectXlsxColumns(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false, cellNF: false, cellText: false });
  const sheets = wb.SheetNames;

  // Scegli il foglio più rilevante
  let defaultSheet = sheets[0] || '';
  for (const name of sheets) {
    if (name.toLowerCase().includes('resource')) { defaultSheet = name; break; }
  }

  const ws = wb.Sheets[defaultSheet];
  const aoa = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) : [];
  const allHeaders = (aoa[0] || []).map(h => String(h ?? '').trim()).filter(Boolean);

  const tagColumns    = allHeaders.filter(h => /^Tag:cineca:/i.test(h));
  const noteColumns   = allHeaders.filter(h => /^cineca:.+_note$/i.test(h));
  const taggableCol   = allHeaders.find(h => h.toLowerCase() === 'taggable') || 'Taggable';
  const identifierColumns = allHeaders.filter(h => /^(Identifier|ARN|Arn|ResourceARN)$/i.test(h));

  const CONTEXT_CANDIDATES = ['resource type', 'region', 'aws account', 'service',
    'cfnresourcetype', 'application', 'tags'];
  const contextColumns = allHeaders.filter(h => {
    if (/^Tag:cineca:/i.test(h) || /^cineca:.+_note$/i.test(h)) return false;
    return CONTEXT_CANDIDATES.includes(h.toLowerCase());
  });

  // Conta righe Taggable=Y
  let taggableCount = 0;
  const taggableColIdx = allHeaders.indexOf(taggableCol);
  if (taggableColIdx >= 0) {
    for (let r = 1; r < aoa.length; r++) {
      if (String(aoa[r][taggableColIdx] ?? '').toLowerCase() === 'y') taggableCount++;
    }
  }

  return {
    sheets,
    defaultSheet,
    allHeaders,
    taggableCount,
    suggestedConfig: {
      sheetName: defaultSheet,
      taggableColumn: taggableCol,
      taggableValue: 'Y',
      identifierColumns,
      contextColumns,
      tagColumns,
      noteColumns,
    },
  };
}

// ---------------------------------------------------------------------------
// B) Run XLSX tagging — parallel workers
// ---------------------------------------------------------------------------
export async function runXlsxTagging(projectId, config, llmProvider, promptTemplate, contextDocTexts, ollamaModel) {
  const {
    filePath,
    sheetName,
    taggableColumn,
    taggableValue,
    identifierColumns = [],
    contextColumns = [],
    tagColumns = [],
    noteColumns = [],
    parallelWorkers: cfgWorkers,
  } = config;

  const WORKERS = Math.max(1, Math.min(5,
    parseInt(cfgWorkers ?? process.env.XLSX_PARALLEL_WORKERS ?? '1', 10) || 1
  ));

  setXlsxProgress(projectId, {
    status: 'running',
    total: 0, processed: 0, batch: 0, batchTotal: 0,
    workers: WORKERS, errors: [],
    startedAt: Date.now(),
    llmProvider,
  });

  try {
    // Build context string (max 8000 chars/doc, 60000 total)
    let contextStr = '';
    let totalLen = 0;
    for (const text of (contextDocTexts || [])) {
      const chunk = (text || '').slice(0, 8000);
      if (totalLen + chunk.length > 60000) break;
      contextStr += `\n---\n${chunk}\n`;
      totalLen += chunk.length;
    }

    // Leggi con SheetJS
    const wb = XLSX.readFile(filePath, { cellDates: false, cellNF: false, cellText: false });
    if (!wb.SheetNames.includes(sheetName)) throw new Error(`Sheet "${sheetName}" non trovato`);
    const wsRaw = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(wsRaw, { header: 1, defval: '' });
    if (aoa.length < 2) throw new Error('Foglio vuoto o senza dati');

    const headers = aoa[0].map(h => String(h ?? '').trim());
    const colMap = {};
    headers.forEach((h, i) => { if (h) colMap[h] = i; });

    // Collect taggable rows
    const taggableColIdx = colMap[taggableColumn] ?? -1;
    const taggableRows = [];
    for (let r = 1; r < aoa.length; r++) {
      const row = aoa[r];
      if (taggableColIdx < 0) continue;
      if (String(row[taggableColIdx] ?? '').trim().toLowerCase() !== (taggableValue || 'Y').toLowerCase()) continue;
      const cells = {};
      [...identifierColumns, ...contextColumns, ...tagColumns, ...noteColumns].forEach(colName => {
        const idx = colMap[colName];
        if (idx !== undefined) cells[colName] = String(row[idx] ?? '');
      });
      taggableRows.push({ rowNumber: r + 1, cells });
    }

    const total = taggableRows.length;
    const totalBatches = Math.ceil(total / BATCH_SIZE);
    setXlsxProgress(projectId, { total, batchTotal: totalBatches });

    if (total === 0) {
      setXlsxProgress(projectId, { status: 'done', endedAt: Date.now() });
      setTimeout(() => _xlsxJobs.delete(projectId), 15 * 60 * 1000);
      return;
    }

    // Prompt building helpers
    const tagColsList = tagColumns.map(tc => {
      const tagName = tc.replace(/^Tag:/i, '');
      const note = noteColumns.find(nc => nc.toLowerCase() === `${tagName}_note`.toLowerCase()) || '';
      return note ? { tag: tc, note } : { tag: tc };
    });
    const tagColsListStr = JSON.stringify(tagColsList, null, 2);

    const llm = getLLM(llmProvider, ollamaModel);

    // Divide rows into WORKERS disjoint segments
    const segments = Array.from({ length: WORKERS }, (_, w) => {
      const start = Math.floor(w * total / WORKERS);
      const end   = Math.floor((w + 1) * total / WORKERS);
      return taggableRows.slice(start, end);
    });

    // Shared counters — safe without mutex (JS single-thread event loop)
    let globalProcessed = 0;
    let globalBatchesDone = 0;

    // Worker: processes its segment, returns [{rowIdx, colIdx, value}]
    const runWorker = async (wId, segment) => {
      const updates = [];
      let consecErrors = 0;

      for (let i = 0; i < segment.length; i += BATCH_SIZE) {
        await waitIfPaused(projectId);
        if (_xlsxJobs.get(projectId)?.status === 'error') return updates; // aborted by another worker

        const batch = segment.slice(i, i + BATCH_SIZE);

        const rowsJson = batch.map(r => {
          const obj = { rowNumber: r.rowNumber };
          [...identifierColumns, ...contextColumns].forEach(col => {
            if (r.cells[col] !== undefined) obj[col] = r.cells[col];
          });
          return obj;
        });

        const resourcesJsonStr = JSON.stringify(rowsJson, null, 2);
        let userPrompt = (promptTemplate || '')
          .replace('{{tag_columns_list}}', tagColsListStr)
          .replace('{{context_documents}}', contextStr);

        if (userPrompt.includes('{{resources_json}}')) {
          userPrompt = userPrompt.replace('{{resources_json}}', resourcesJsonStr);
        } else {
          userPrompt += `\n\nCOLONNE TAG DA VALORIZZARE:\n${tagColsListStr}\n\nRISORSE DA TAGGARE (usa "[?]" per valori incerti, spiega nella _note):\n${resourcesJsonStr}\n\nRestituisci SOLO un array JSON:\n[{"rowNumber":<N>,"tags":{"Tag:cineca:X":"val","cineca:X_note":"motivo",...}},...]`;
        }

        let responseText;
        try {
          responseText = await llm.complete(SYSTEM_PROMPT, userPrompt);
          consecErrors = 0;
        } catch (err) {
          consecErrors++;
          const job = _xlsxJobs.get(projectId);
          const errs = [...(job?.errors || []), `W${wId}:${err.message.slice(0, 120)}`];
          console.error(`[xlsxTagger] worker ${wId} err #${consecErrors}:`, err.message);
          setXlsxProgress(projectId, { errors: errs });
          // Abort the entire job after 3 consecutive failures (permanent errors)
          if (consecErrors >= 3) {
            setXlsxProgress(projectId, {
              status: 'error',
              errors: [...errs, `Abort dopo 3 errori consecutivi (worker ${wId})`],
              endedAt: Date.now(),
            });
          }
          globalBatchesDone++;
          continue;
        }

        const results = extractJsonArray(responseText);
        for (const result of results) {
          if (!result.rowNumber || !result.tags) continue;
          for (const [colName, value] of Object.entries(result.tags)) {
            const colIdx = colMap[colName];
            if (colIdx !== undefined)
              updates.push({ rowIdx: result.rowNumber - 1, colIdx, value: String(value) });
          }
        }

        globalProcessed = Math.min(globalProcessed + batch.length, total);
        globalBatchesDone++;

        const job2 = _xlsxJobs.get(projectId);
        const elapsed = job2?.startedAt ? Date.now() - job2.startedAt : 1;
        const rate = elapsed > 0 ? globalProcessed / elapsed : 0;
        const etaMs = rate > 0 && globalProcessed < total ? Math.round((total - globalProcessed) / rate) : null;
        setXlsxProgress(projectId, { processed: globalProcessed, batch: globalBatchesDone, etaMs });
      }
      return updates;
    };

    // Launch all workers in parallel
    const allUpdates = await Promise.all(segments.map((seg, wId) => runWorker(wId, seg)));

    // Check if aborted during parallel execution
    if (_xlsxJobs.get(projectId)?.status === 'error') {
      setTimeout(() => _xlsxJobs.delete(projectId), 15 * 60 * 1000);
      return;
    }

    // Merge all cell updates into wsRaw (sequential — no conflicts)
    for (const updates of allUpdates) {
      for (const { rowIdx, colIdx, value } of updates) {
        const cellRef = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
        wsRaw[cellRef] = { t: 's', v: value };
      }
    }
    XLSX.utils.sheet_add_aoa(wsRaw, [], { origin: -1 });
    XLSX.writeFile(wb, getXlsxOutputPath(projectId));

    // Mark delivery resources in Neo4j
    try {
      await runQuery(
        `MATCH (p:Project {id: $projectId})-[:HAS_RESOURCE]->(r:Resource)
         WHERE r.nodeType IS NULL OR r.nodeType = 'delivery'
         SET r.nodeType = 'delivery'`,
        { projectId }
      );
    } catch (dbErr) {
      console.warn('[xlsxTagger] nodeType update warning:', dbErr.message);
    }

    const finalJob = _xlsxJobs.get(projectId);
    setXlsxProgress(projectId, {
      status: finalJob?.errors?.length > 0 ? 'done_with_errors' : 'done',
      endedAt: Date.now(),
    });

  } catch (err) {
    console.error('[xlsxTagger] fatal error:', err.message);
    setXlsxProgress(projectId, { status: 'error', errors: [err.message], endedAt: Date.now() });
  }

  setTimeout(() => _xlsxJobs.delete(projectId), 15 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// C) Output path
// ---------------------------------------------------------------------------
export function getXlsxOutputPath(projectId) {
  return `uploads/${projectId}_tagged.xlsx`;
}

// ---------------------------------------------------------------------------
// Helper: extract text from a context doc file
// ---------------------------------------------------------------------------
export async function extractFileText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') {
    const wb = XLSX.readFile(filePath, { cellDates: false, cellNF: false, cellText: false });
    const lines = [];
    for (const name of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      for (const row of aoa) {
        const vals = row.map(v => String(v ?? '')).filter(Boolean);
        if (vals.length) lines.push(vals.join('\t'));
      }
    }
    return lines.join('\n');
  }
  const buf = await fs.readFile(filePath);
  return buf.toString('utf-8');
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------
function extractJsonArray(text) {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try { return JSON.parse(match[0]); } catch (_) { return []; }
}
