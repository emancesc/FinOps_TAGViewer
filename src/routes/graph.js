import { Router } from 'express';
import { runQuery } from '../services/db.js';

const router = Router();

// GET /api/graph/:projectId — restituisce nodi + archi per il grafo 3D
router.get('/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const { filter, filterValue } = req.query;

  try {
    // Tutti i nodi risorsa del progetto
    let nodeCypher = `MATCH (p:Project {id: $projectId})-[:HAS_RESOURCE]->(r:Resource)`;
    if (filter === 'status' && filterValue)
      nodeCypher += ` WHERE r.status = $filterValue`;
    else if (filter === 'service' && filterValue)
      nodeCypher += ` WHERE r.service = $filterValue`;
    nodeCypher += ` RETURN r`;

    const nodeRecords = await runQuery(nodeCypher, { projectId, filterValue });
    const nodes = nodeRecords.map(rec => {
      const props = rec.get('r').properties;
      return {
        id: props.id,
        name: props.name || props.resourceId,
        type: props.resourceType,
        service: props.service,
        region: props.region,
        status: props.status,
        confidence: props.confidence || 0,
        proposedTags: props.proposedTags ? JSON.parse(props.proposedTags) : {},
        rawTags: props.rawTags ? JSON.parse(props.rawTags) : {},
        notes: props.notes || '',
      };
    });

    const nodeIds = new Set(nodes.map(n => n.id));

    // Tutti gli archi tra risorse del progetto
    const relRecords = await runQuery(
      `MATCH (p:Project {id: $projectId})-[:HAS_RESOURCE]->(a:Resource)
       MATCH (a)-[rel]->(b:Resource)<-[:HAS_RESOURCE]-(p)
       WHERE type(rel) IN ['DEPENDS_ON','PART_OF','SAME_APP','SAME_ENV']
       RETURN a.id AS source, b.id AS target, type(rel) AS relType`,
      { projectId }
    );
    const links = relRecords
      .map(r => ({
        source: r.get('source'),
        target: r.get('target'),
        type: r.get('relType'),
      }))
      .filter(l => nodeIds.has(l.source) && nodeIds.has(l.target));

    res.json({ nodes, links });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/graph/:projectId/resource/:resourceId — aggiorna tag confermati o note
router.patch('/:projectId/resource/:resourceId', async (req, res) => {
  const { resourceId } = req.params;
  const { confirmedTags, status, notes } = req.body;
  try {
    const updates = {};
    if (confirmedTags !== undefined) updates.proposedTags = JSON.stringify(confirmedTags);
    if (status) updates.status = status;
    if (notes !== undefined) updates.notes = notes;

    const setClauses = Object.keys(updates).map(k => `r.${k} = $${k}`).join(', ');
    const records = await runQuery(
      `MATCH (r:Resource {id: $resourceId}) SET ${setClauses} RETURN r`,
      { resourceId, ...updates }
    );
    if (!records.length) return res.status(404).json({ error: 'Risorsa non trovata' });
    res.json(records[0].get('r').properties);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/graph/:projectId/stats
router.get('/:projectId/stats', async (req, res) => {
  try {
    const records = await runQuery(
      `MATCH (p:Project {id: $projectId})-[:HAS_RESOURCE]->(r:Resource)
       RETURN r.status AS status, r.service AS service, count(*) AS cnt`,
      { projectId: req.params.projectId }
    );
    const byStatus = {}, byService = {};
    for (const rec of records) {
      const s = rec.get('status'), svc = rec.get('service');
      const cnt = rec.get('cnt').toNumber();
      byStatus[s] = (byStatus[s] || 0) + cnt;
      byService[svc] = (byService[svc] || 0) + cnt;
    }
    res.json({ byStatus, byService });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
