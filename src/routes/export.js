import { Router } from 'express';
import { runQuery } from '../services/db.js';
import { exportToXlsx, exportSummary } from '../services/exporter.js';

const router = Router();

// GET /api/export/:projectId/xlsx
router.get('/:projectId/xlsx', async (req, res) => {
  try {
    const proj = await runQuery(`MATCH (p:Project {id: $id}) RETURN p`, { id: req.params.projectId });
    if (!proj.length) return res.status(404).json({ error: 'Progetto non trovato' });
    const project = proj[0].get('p').properties;

    const records = await runQuery(
      `MATCH (p:Project {id: $id})-[:HAS_RESOURCE]->(r:Resource) RETURN r ORDER BY r.service, r.name`,
      { id: req.params.projectId }
    );
    const resources = records.map(rec => rec.get('r').properties);

    const buffer = await exportToXlsx(project, resources);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${project.name}_tags.xlsx"`);
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/export/:projectId/summary
router.get('/:projectId/summary', async (req, res) => {
  try {
    const proj = await runQuery(`MATCH (p:Project {id: $id}) RETURN p`, { id: req.params.projectId });
    if (!proj.length) return res.status(404).json({ error: 'Progetto non trovato' });
    const project = proj[0].get('p').properties;

    const records = await runQuery(
      `MATCH (p:Project {id: $id})-[:HAS_RESOURCE]->(r:Resource)
       WHERE r.status IN ['confirmed','tagged']
       RETURN r ORDER BY r.service`,
      { id: req.params.projectId }
    );
    const resources = records.map(rec => rec.get('r').properties);

    const markdown = await exportSummary(project, resources);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${project.name}_summary.md"`);
    res.send(markdown);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
