import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runQuery } from '../services/db.js';

const router = Router();

// GET /api/projects
router.get('/', async (_req, res) => {
  try {
    const records = await runQuery(
      `MATCH (p:Project) RETURN p ORDER BY p.createdAt DESC`
    );
    res.json(records.map(r => r.get('p').properties));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/projects
router.post('/', async (req, res) => {
  const { name, accountId, region, llmProvider = process.env.LLM_PROVIDER || 'bedrock', ollamaModel = '' } = req.body;
  if (!name || !accountId) return res.status(400).json({ error: 'name e accountId obbligatori' });

  const id = uuidv4();
  try {
    const records = await runQuery(
      `CREATE (p:Project {
         id: $id, name: $name, accountId: $accountId,
         region: $region, llmProvider: $llmProvider, ollamaModel: $ollamaModel,
         createdAt: datetime(), status: 'active'
       }) RETURN p`,
      { id, name, accountId, region: region || '', llmProvider, ollamaModel }
    );
    res.status(201).json(records[0].get('p').properties);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/projects/:id
router.get('/:id', async (req, res) => {
  try {
    const records = await runQuery(
      `MATCH (p:Project {id: $id})
       OPTIONAL MATCH (p)-[:HAS_RESOURCE]->(r:Resource)
       OPTIONAL MATCH (p)-[:HAS_DOCUMENT]->(d:Document)
       RETURN p,
         count(DISTINCT r) AS resourceCount,
         count(DISTINCT d) AS documentCount`,
      { id: req.params.id }
    );
    if (!records.length) return res.status(404).json({ error: 'Progetto non trovato' });
    const rec = records[0];
    const props = rec.get('p').properties;
    let columnConfig = null;
    if (props.columnConfig) {
      try { columnConfig = JSON.parse(props.columnConfig); } catch (_) {}
    }
    res.json({
      ...props,
      columnConfig,
      promptTemplate: props.promptTemplate || null,
      taggingTargetFile: props.taggingTargetFile || null,
      resourceCount: rec.get('resourceCount').toNumber(),
      documentCount: rec.get('documentCount').toNumber(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/projects/:id
router.patch('/:id', async (req, res) => {
  const allowed = ['name', 'llmProvider', 'status', 'ollamaModel'];
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nessun campo aggiornabile' });

  const setClauses = Object.keys(updates).map(k => `p.${k} = $${k}`).join(', ');
  try {
    const records = await runQuery(
      `MATCH (p:Project {id: $id}) SET ${setClauses} RETURN p`,
      { id: req.params.id, ...updates }
    );
    if (!records.length) return res.status(404).json({ error: 'Progetto non trovato' });
    res.json(records[0].get('p').properties);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/projects/:id/column-config
router.patch('/:id/column-config', async (req, res) => {
  const { columnConfig, promptTemplate, taggingTargetFile } = req.body;
  if (!columnConfig && !promptTemplate && !taggingTargetFile) {
    return res.status(400).json({ error: 'Nessun campo da aggiornare' });
  }
  try {
    const records = await runQuery(
      `MATCH (p:Project {id: $id})
       SET p.columnConfig = $columnConfig,
           p.promptTemplate = $promptTemplate,
           p.taggingTargetFile = $taggingTargetFile
       RETURN p`,
      {
        id: req.params.id,
        columnConfig: columnConfig ? JSON.stringify(columnConfig) : null,
        promptTemplate: promptTemplate || null,
        taggingTargetFile: taggingTargetFile || null,
      }
    );
    if (!records.length) return res.status(404).json({ error: 'Progetto non trovato' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/projects/:id
router.delete('/:id', async (req, res) => {
  try {
    await runQuery(
      `MATCH (p:Project {id: $id})
       OPTIONAL MATCH (p)-[:HAS_RESOURCE]->(r:Resource)
       OPTIONAL MATCH (p)-[:HAS_DOCUMENT]->(d:Document)
       DETACH DELETE p, r, d`,
      { id: req.params.id }
    );
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
