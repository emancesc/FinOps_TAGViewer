import { Router } from 'express';
import { runQuery } from '../services/db.js';
import { tagAllResources, tagSingleResource, getTaggingProgress } from '../services/tagger.js';

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

  const emit = () => {
    const p = getTaggingProgress(req.params.projectId);
    res.write(`data: ${JSON.stringify(p || { status: 'idle' })}\n\n`);
    if (p?.status === 'done' || p?.status === 'done_with_errors' || p?.status === 'error') {
      clearInterval(iv);
      setTimeout(() => res.end(), 2000);
    }
  };

  emit();
  const iv = setInterval(emit, 1500);
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

export default router;
