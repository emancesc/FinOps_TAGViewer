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
// B) Run XLSX tagging
// ---------------------------------------------------------------------------
export async function runXlsxTagging(projectId, config, llmProvider, promptTemplate, contextDocTexts) {
  const {
    filePath,
    sheetName,
    taggableColumn,
    taggableValue,
    identifierColumns = [],
    contextColumns = [],
    tagColumns = [],
    noteColumns = [],
  } = config;

  setXlsxProgress(projectId, {
    status: 'running',
    total: 0,
    processed: 0,
    batch: 0,
    batchTotal: 0,
    errors: [],
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

    // Leggi con SheetJS (tollerante a tutte le estensioni Excel)
    const wb = XLSX.readFile(filePath, { cellDates: false, cellNF: false, cellText: false });
    if (!wb.SheetNames.includes(sheetName)) throw new Error(`Sheet "${sheetName}" non trovato`);
    const wsRaw = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(wsRaw, { header: 1, defval: '' });
    if (aoa.length < 2) throw new Error('Foglio vuoto o senza dati');

    // Build column index map (0-based)
    const headers = aoa[0].map(h => String(h ?? '').trim());
    const colMap = {};
    headers.forEach((h, i) => { if (h) colMap[h] = i; });

    // Collect taggable rows
    const taggableColIdx = colMap[taggableColumn] ?? -1;
    const taggableRows = [];
    for (let r = 1; r < aoa.length; r++) {
      const row = aoa[r];
      if (taggableColIdx < 0) continue;
      const cellVal = String(row[taggableColIdx] ?? '').trim();
      if (cellVal.toLowerCase() !== (taggableValue || 'Y').toLowerCase()) continue;
      const cells = {};
      [...identifierColumns, ...contextColumns, ...tagColumns, ...noteColumns].forEach(colName => {
        const idx = colMap[colName];
        if (idx !== undefined) cells[colName] = String(row[idx] ?? '');
      });
      taggableRows.push({ rowNumber: r + 1, cells }); // rowNumber è 1-indexed come Excel
    }

    const total = taggableRows.length;
    const batchTotal = Math.ceil(total / BATCH_SIZE);
    setXlsxProgress(projectId, { total, batchTotal });

    if (total === 0) {
      setXlsxProgress(projectId, { status: 'done', endedAt: Date.now() });
      setTimeout(() => _xlsxJobs.delete(projectId), 15 * 60 * 1000);
      return;
    }

    // Build tag columns descriptor for prompt
    const tagColsList = tagColumns.map(tc => {
      const tagName = tc.replace(/^Tag:/i, '');
      const note = noteColumns.find(nc => nc.toLowerCase() === `${tagName}_note`.toLowerCase()) || '';
      return note ? { tag: tc, note } : { tag: tc };
    });

    const llm = getLLM(llmProvider);

    for (let i = 0; i < taggableRows.length; i += BATCH_SIZE) {
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const batch = taggableRows.slice(i, i + BATCH_SIZE);
      setXlsxProgress(projectId, { batch: batchNum });

      // Row objects: identifiers + context only
      const rowsJson = batch.map(r => {
        const obj = { rowNumber: r.rowNumber };
        [...identifierColumns, ...contextColumns].forEach(col => {
          if (r.cells[col] !== undefined) obj[col] = r.cells[col];
        });
        return obj;
      });

      const tagColsListStr = JSON.stringify(tagColsList, null, 2);
      const resourcesJsonStr = JSON.stringify(rowsJson, null, 2);

      let userPrompt = (promptTemplate || '')
        .replace('{{tag_columns_list}}', tagColsListStr)
        .replace('{{context_documents}}', contextStr);

      if (userPrompt.includes('{{resources_json}}')) {
        userPrompt = userPrompt.replace('{{resources_json}}', resourcesJsonStr);
      } else {
        userPrompt += `\n\nCOLONNE TAG DA VALORIZZARE:\n${tagColsListStr}\n\nRISORSE DA TAGGARE (valorizza TUTTI i tag per ogni risorsa; usa "[?]" per valori incerti e spiega le opzioni nella colonna _note):\n${resourcesJsonStr}\n\nRestituisci un array JSON con questa struttura:\n[{"rowNumber": <N>, "tags": {"Tag:cineca:BusinessUnit": "valore", "cineca:BusinessUnit_note": "motivo", ...}}, ...]`;
      }

      let responseText;
      try {
        responseText = await llm.complete(SYSTEM_PROMPT, userPrompt);
      } catch (err) {
        console.error(`[xlsxTagger] batch ${batchNum}/${batchTotal} LLM error:`, err.message);
        const job = _xlsxJobs.get(projectId);
        setXlsxProgress(projectId, { errors: [...(job?.errors || []), `Batch ${batchNum}: ${err.message}`] });
        continue;
      }

      const results = extractJsonArray(responseText);
      for (const result of results) {
        if (!result.rowNumber || !result.tags) continue;
        const rowIdx = result.rowNumber - 1; // 0-based
        for (const [colName, value] of Object.entries(result.tags)) {
          const colIdx = colMap[colName];
          if (colIdx === undefined) continue;
          const cellRef = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
          wsRaw[cellRef] = { t: 's', v: String(value) };
        }
      }

      setXlsxProgress(projectId, { processed: Math.min(i + BATCH_SIZE, total) });
    }

    // Aggiorna il range del foglio dopo le modifiche
    XLSX.utils.sheet_add_aoa(wsRaw, [], { origin: -1 });
    XLSX.writeFile(wb, getXlsxOutputPath(projectId));

    // Marca le risorse delivery nel grafo Neo4j
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

    const job = _xlsxJobs.get(projectId);
    setXlsxProgress(projectId, {
      status: job?.errors?.length > 0 ? 'done_with_errors' : 'done',
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
