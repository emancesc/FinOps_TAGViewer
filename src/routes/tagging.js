import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { runQuery } from '../services/db.js';
import { tagAllResources, tagSingleResource, getTaggingProgress } from '../services/tagger.js';
import {
  detectXlsxColumns,
  runXlsxTagging,
  getXlsxTaggingProgress,
  getXlsxOutputPath,
  extractFileText,
  pauseXlsxTagging,
  resumeXlsxTagging,
} from '../services/xlsxTagger.js';

const router = Router();

// POST /api/tagging/:projectId/run — avvia tagging automatico LLM su tutte le risorse pending
router.post('/:projectId/run', async (req, res) => {
  const { projectId } = req.params;
  try {
    const proj = await runQuery(`MATCH (p:Project {id: $id}) RETURN p`, { id: projectId });
    if (!proj.length) return res.status(404).json({ error: 'Progetto non trovato' });

    const project = proj[0].get('p').properties;

    // Risponde subito, poi esegue in background (SSE per lo stato)
    res.json({ status: 'started', message: 'Tagging avviato. Monitora /api/tagging/:projectId/status' });

    // Fire-and-forget con gestione errori silenziosa
    tagAllResources(project).catch(err =>
      console.error(`[tagging] errore progetto ${projectId}:`, err.message)
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tagging/:projectId/progress — SSE stream progresso real-time
router.get('/:projectId/progress', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(': connected\n\n');

  let iv;
  const emit = () => {
    const p = getTaggingProgress(req.params.projectId);
    res.write(`data: ${JSON.stringify(p || { status: 'idle' })}\n\n`);
    if (p?.status === 'done' || p?.status === 'done_with_errors' || p?.status === 'error') {
      clearInterval(iv);
      setTimeout(() => res.end(), 2000);
    }
  };

  emit();
  iv = setInterval(emit, 1500);
  req.on('close', () => clearInterval(iv));
});

// GET /api/tagging/:projectId/status — stato aggregato del tagging
router.get('/:projectId/status', async (req, res) => {
  try {
    const records = await runQuery(
      `MATCH (p:Project {id: $id})-[:HAS_RESOURCE]->(r:Resource)
       RETURN r.status AS status, count(*) AS cnt`,
      { id: req.params.projectId }
    );
    const counts = { pending: 0, tagged: 0, uncertain: 0, confirmed: 0 };
    for (const rec of records) {
      const s = rec.get('status');
      counts[s] = (counts[s] || 0) + rec.get('cnt').toNumber();
    }
    res.json(counts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tagging/:projectId/resource/:resourceId — ritag una singola risorsa
router.post('/:projectId/resource/:resourceId', async (req, res) => {
  const { projectId, resourceId } = req.params;
  const { guidance } = req.body; // hint aggiuntivo dall'utente
  try {
    const proj = await runQuery(`MATCH (p:Project {id: $id}) RETURN p`, { id: projectId });
    if (!proj.length) return res.status(404).json({ error: 'Progetto non trovato' });
    const project = proj[0].get('p').properties;

    const result = await tagSingleResource(project, resourceId, guidance);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/tagging/:projectId/resource/:resourceId/confirm — conferma manuale dei tag
router.patch('/:projectId/resource/:resourceId/confirm', async (req, res) => {
  const { resourceId } = req.params;
  const { tags } = req.body;
  try {
    const records = await runQuery(
      `MATCH (r:Resource {id: $id})
       SET r.proposedTags = $tags, r.status = 'confirmed'
       RETURN r`,
      { id: resourceId, tags: JSON.stringify(tags) }
    );
    if (!records.length) return res.status(404).json({ error: 'Risorsa non trovata' });
    res.json(records[0].get('r').properties);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tagging/:projectId/detect-columns
router.post('/:projectId/detect-columns', async (req, res) => {
  const { storedAs } = req.body;
  if (!storedAs) return res.status(400).json({ error: 'storedAs obbligatorio' });
  try {
    const result = await detectXlsxColumns(`uploads/${storedAs}`);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tagging/:projectId/run-xlsx — avvia tagging XLSX
router.post('/:projectId/run-xlsx', async (req, res) => {
  const { projectId } = req.params;
  try {
    const projRecords = await runQuery(`MATCH (p:Project {id: $id}) RETURN p`, { id: projectId });
    if (!projRecords.length) return res.status(404).json({ error: 'Progetto non trovato' });

    const proj = projRecords[0].get('p').properties;
    let columnConfig = {};
    try { columnConfig = JSON.parse(proj.columnConfig || '{}'); } catch (_) {}
    const promptTemplate = proj.promptTemplate || '';
    const llmProvider = proj.llmProvider || process.env.LLM_PROVIDER || 'claude';
    const ollamaModel = proj.ollamaModel || '';
    const taggingTargetFile = proj.taggingTargetFile || '';

    if (!taggingTargetFile) return res.status(400).json({ error: 'Nessun file XLSX target configurato' });

    // Auto-detect columns if config is missing or incomplete
    if (!columnConfig.sheetName || !columnConfig.tagColumns?.length) {
      try {
        const detected = await detectXlsxColumns(`uploads/${taggingTargetFile}`);
        columnConfig = { ...detected.suggestedConfig, ...columnConfig };
        console.log(`[tagging] auto-detect colonne: sheet="${columnConfig.sheetName}", ${columnConfig.tagColumns?.length} tag cols`);
      } catch (detectErr) {
        console.warn('[tagging] auto-detect colonne fallito:', detectErr.message);
      }
    }

    // Load context documents
    const docRecords = await runQuery(
      `MATCH (p:Project {id: $id})-[:HAS_DOCUMENT]->(d:Document)
       WHERE d.type IN ['guideline', 'assessment'] RETURN d`,
      { id: projectId }
    );

    const contextDocTexts = [];
    for (const rec of docRecords) {
      const doc = rec.get('d').properties;
      if (!doc.storedAs) continue;
      try {
        const text = await extractFileText(`uploads/${doc.storedAs}`);
        contextDocTexts.push(`[${doc.filename}]\n${text}`);
      } catch (err) {
        console.warn(`[tagging] Errore lettura doc ${doc.storedAs}:`, err.message);
      }
    }

    const config = { ...columnConfig, filePath: `uploads/${taggingTargetFile}` };

    res.json({ status: 'started' });

    runXlsxTagging(projectId, config, llmProvider, promptTemplate, contextDocTexts, ollamaModel)
      .catch(err => console.error(`[xlsxTagger] error per ${projectId}:`, err.message));

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tagging/:projectId/progress-xlsx-status — snapshot JSON (non SSE)
router.get('/:projectId/progress-xlsx-status', (req, res) => {
  const p = getXlsxTaggingProgress(req.params.projectId);
  res.json(p || { status: 'idle' });
});

// GET /api/tagging/:projectId/progress-xlsx — SSE stream progresso XLSX
router.get('/:projectId/progress-xlsx', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(': connected\n\n');

  let iv;
  const emit = () => {
    const p = getXlsxTaggingProgress(req.params.projectId);
    res.write(`data: ${JSON.stringify(p || { status: 'idle' })}\n\n`);
    if (p?.status === 'done' || p?.status === 'done_with_errors' || p?.status === 'error') {
      clearInterval(iv);
      setTimeout(() => res.end(), 2000);
    }
  };

  emit();
  iv = setInterval(emit, 1500);
  req.on('close', () => clearInterval(iv));
});

// POST /api/tagging/:projectId/pause-xlsx
router.post('/:projectId/pause-xlsx', (req, res) => {
  pauseXlsxTagging(req.params.projectId);
  res.json({ status: 'paused' });
});

// POST /api/tagging/:projectId/resume-xlsx
router.post('/:projectId/resume-xlsx', (req, res) => {
  resumeXlsxTagging(req.params.projectId);
  res.json({ status: 'running' });
});

// GET /api/tagging/:projectId/result-xlsx — scarica il file XLSX taggato
router.get('/:projectId/result-xlsx', async (req, res) => {
  const filePath = getXlsxOutputPath(req.params.projectId);
  try {
    await fs.access(filePath);
    res.download(path.resolve(filePath));
  } catch {
    res.status(404).json({ error: 'File non trovato' });
  }
});

export default router;
