import { Router } from 'express';
import { runQuery } from '../services/db.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// Le strategie sono memorizzate come JSON nel nodo Project (p.tagStrategies)

// GET /api/strategies/:projectId — lista strategie
router.get('/:projectId', async (req, res) => {
  try {
    const records = await runQuery(
      `MATCH (p:Project {id: $projectId}) RETURN p.tagStrategies AS strategies`,
      { projectId: req.params.projectId }
    );
    if (!records.length) return res.status(404).json({ error: 'Progetto non trovato' });
    const raw = records[0].get('strategies');
    res.json(raw ? JSON.parse(raw) : []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/strategies/:projectId — crea strategia
// body: { name, conditionField, conditionOp ('equals'|'contains'|'startsWith'), conditionValue, tagColumn, tagValue }
router.post('/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const { name, conditionField, conditionOp, conditionValue, tagColumn, tagValue } = req.body;
  if (!name || !conditionField || !conditionOp || !conditionValue || !tagColumn || !tagValue) {
    return res.status(400).json({ error: 'Tutti i campi sono obbligatori' });
  }
  try {
    const records = await runQuery(
      `MATCH (p:Project {id: $projectId}) RETURN p.tagStrategies AS strategies`,
      { projectId }
    );
    if (!records.length) return res.status(404).json({ error: 'Progetto non trovato' });

    const raw = records[0].get('strategies');
    const strategies = raw ? JSON.parse(raw) : [];
    const newStrategy = {
      id: uuidv4(),
      name,
      conditionField,
      conditionOp,
      conditionValue,
      tagColumn,
      tagValue,
      enabled: true,
      createdAt: Date.now(),
    };
    strategies.push(newStrategy);

    await runQuery(
      `MATCH (p:Project {id: $projectId}) SET p.tagStrategies = $strategies`,
      { projectId, strategies: JSON.stringify(strategies) }
    );
    res.json(newStrategy);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/strategies/:projectId/:strategyId — aggiorna (toggle enabled)
router.patch('/:projectId/:strategyId', async (req, res) => {
  const { projectId, strategyId } = req.params;
  const { enabled } = req.body;
  try {
    const records = await runQuery(
      `MATCH (p:Project {id: $projectId}) RETURN p.tagStrategies AS strategies`,
      { projectId }
    );
    if (!records.length) return res.status(404).json({ error: 'Progetto non trovato' });
    const raw = records[0].get('strategies');
    const strategies = raw ? JSON.parse(raw) : [];
    const idx = strategies.findIndex(s => s.id === strategyId);
    if (idx < 0) return res.status(404).json({ error: 'Strategia non trovata' });
    strategies[idx].enabled = enabled !== undefined ? enabled : !strategies[idx].enabled;
    await runQuery(
      `MATCH (p:Project {id: $projectId}) SET p.tagStrategies = $strategies`,
      { projectId, strategies: JSON.stringify(strategies) }
    );
    res.json(strategies[idx]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/strategies/:projectId/:strategyId — elimina strategia
router.delete('/:projectId/:strategyId', async (req, res) => {
  const { projectId, strategyId } = req.params;
  try {
    const records = await runQuery(
      `MATCH (p:Project {id: $projectId}) RETURN p.tagStrategies AS strategies`,
      { projectId }
    );
    if (!records.length) return res.status(404).json({ error: 'Progetto non trovato' });
    const raw = records[0].get('strategies');
    const strategies = (raw ? JSON.parse(raw) : []).filter(s => s.id !== strategyId);
    await runQuery(
      `MATCH (p:Project {id: $projectId}) SET p.tagStrategies = $strategies`,
      { projectId, strategies: JSON.stringify(strategies) }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/strategies/:projectId/apply — applica tutte le strategie abilitate
// Per ogni strategia: trova risorse delivery dove la condizione matcha e il tag è '[?]' o vuoto,
// aggiorna il valore del tag e imposta status = 'tagged' se era uncertain/pending.
router.post('/:projectId/apply', async (req, res) => {
  const { projectId } = req.params;
  try {
    const projRecords = await runQuery(
      `MATCH (p:Project {id: $projectId}) RETURN p.tagStrategies AS strategies`,
      { projectId }
    );
    if (!projRecords.length) return res.status(404).json({ error: 'Progetto non trovato' });

    const raw = projRecords[0].get('strategies');
    const strategies = raw ? JSON.parse(raw) : [];
    const enabledStrategies = strategies.filter(s => s.enabled);

    if (!enabledStrategies.length) {
      return res.json({ updated: 0, message: 'Nessuna strategia abilitata' });
    }

    // Carica tutte le risorse delivery del progetto
    const resourceRecords = await runQuery(
      `MATCH (p:Project {id: $projectId})-[:HAS_RESOURCE]->(r:Resource)
       WHERE r.nodeType = 'delivery' OR r.nodeType IS NULL
       RETURN r.id AS id, r.proposedTags AS proposedTags, r.status AS status,
              r.resourceType AS resourceType, r.service AS service,
              r.region AS region, r.name AS name`,
      { projectId }
    );

    let totalUpdated = 0;

    for (const strategy of enabledStrategies) {
      const { conditionField, conditionOp, conditionValue, tagColumn, tagValue } = strategy;

      for (const rec of resourceRecords) {
        const resourceId = rec.get('id');
        const status = rec.get('status');
        const fieldVal = rec.get(conditionField) || '';

        // Valuta condizione
        const cv = String(conditionValue).toLowerCase();
        const fv = String(fieldVal).toLowerCase();
        let matches = false;
        if (conditionOp === 'equals')     matches = fv === cv;
        else if (conditionOp === 'contains')    matches = fv.includes(cv);
        else if (conditionOp === 'startsWith')  matches = fv.startsWith(cv);
        if (!matches) continue;

        // Parsa proposedTags
        let tags = {};
        try { tags = JSON.parse(rec.get('proposedTags') || '{}'); } catch (_) {}

        // Aggiorna solo se il valore è '[?]' o assente
        const currentVal = tags[tagColumn];
        if (currentVal && currentVal !== '[?]') continue;

        tags[tagColumn] = tagValue;
        const newStatus = (status === 'uncertain' || status === 'pending') ? 'tagged' : status;

        await runQuery(
          `MATCH (r:Resource {id: $id}) SET r.proposedTags = $tags, r.status = $newStatus`,
          { id: resourceId, tags: JSON.stringify(tags), newStatus }
        );
        totalUpdated++;
      }
    }

    res.json({ updated: totalUpdated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
