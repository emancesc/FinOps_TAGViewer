import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { runQuery } from '../services/db.js';
import { parseDocument } from '../services/parser.js';
import { ingestResources, ingestRelationships } from '../services/tagger.js';

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, 'uploads/'),
  filename: (_req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const router = Router();

// GET /api/documents/:projectId
router.get('/:projectId', async (req, res) => {
  try {
    const records = await runQuery(
      `MATCH (p:Project {id: $projectId})-[:HAS_DOCUMENT]->(d:Document) RETURN d ORDER BY d.uploadedAt DESC`,
      { projectId: req.params.projectId }
    );
    res.json(records.map(r => r.get('d').properties));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/documents/:projectId
// Field: file (multipart), docType: 'resource_export' | 'guideline' | 'assessment'
router.post('/:projectId', upload.single('file'), async (req, res) => {
  const { projectId } = req.params;
  const { docType } = req.body;

  if (!req.file) return res.status(400).json({ error: 'File mancante' });
  if (!['resource_export', 'guideline', 'assessment', 'tagging_target'].includes(docType))
    return res.status(400).json({ error: 'docType non valido' });

  try {
    // Verifica progetto
    const proj = await runQuery(`MATCH (p:Project {id: $id}) RETURN p`, { id: projectId });
    if (!proj.length) return res.status(404).json({ error: 'Progetto non trovato' });

    let content = '', resources = [], relationships = [];
    if (docType !== 'tagging_target') {
      const parsed = await parseDocument(req.file.path, docType, req.file.originalname);
      content = parsed.content || '';
      resources = parsed.resources || [];
      relationships = parsed.relationships || [];
    }

    const docId = uuidv4();
    await runQuery(
      `MATCH (p:Project {id: $projectId})
       CREATE (d:Document {
         id: $docId, projectId: $projectId, type: $docType,
         filename: $filename, storedAs: $storedAs,
         content: $content,
         resourceCount: $resourceCount, uploadedAt: datetime()
       })
       CREATE (p)-[:HAS_DOCUMENT]->(d)`,
      {
        projectId, docId, docType,
        filename: req.file.originalname,
        storedAs: req.file.filename,
        content: content.slice(0, 50_000),
        resourceCount: resources?.length ?? 0,
      }
    );

    if (resources?.length) {
      await ingestResources(projectId, resources);
    }
    if (relationships?.length) {
      await ingestRelationships(projectId, relationships);
    }

    res.status(201).json({
      id: docId,
      filename: req.file.originalname,
      storedAs: req.file.filename,
      docType,
      resourceCount: resources?.length ?? 0,
      contentLength: content?.length ?? 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/documents/:projectId/:docId
router.delete('/:projectId/:docId', async (req, res) => {
  try {
    await runQuery(
      `MATCH (d:Document {id: $docId, projectId: $projectId}) DETACH DELETE d`,
      { docId: req.params.docId, projectId: req.params.projectId }
    );
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
