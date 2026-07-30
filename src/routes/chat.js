import { Router } from 'express';
import { runQuery } from '../services/db.js';
import { getLLM } from '../services/llm.js';
import { CHAT_SYSTEM } from '../prompts/chat_system.js';

const router = Router();

// POST /api/chat/:projectId — streaming SSE chat
// Body: { message: string, resourceIds?: string[], history?: [{role,content}] }
router.post('/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const { message, resourceIds = [], history = [] } = req.body;

  // Setup SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const proj = await runQuery(`MATCH (p:Project {id: $id}) RETURN p`, { id: projectId });
    if (!proj.length) { send({ error: 'Progetto non trovato' }); return res.end(); }
    const project = proj[0].get('p').properties;

    // Carica contesto: risorse incerte o quelle referenziate
    const query = resourceIds.length
      ? `MATCH (r:Resource) WHERE r.id IN $ids RETURN r`
      : `MATCH (p:Project {id: $pid})-[:HAS_RESOURCE]->(r:Resource) WHERE r.status = 'uncertain' RETURN r LIMIT 20`;
    const resRecords = await runQuery(query, { ids: resourceIds, pid: projectId });
    const resources = resRecords.map(rec => {
      const p = rec.get('r').properties;
      return {
        id: p.id, arn: p.arn, type: p.resourceType, name: p.name,
        rawTags: p.rawTags ? JSON.parse(p.rawTags) : {},
        proposedTags: p.proposedTags ? JSON.parse(p.proposedTags) : {},
        status: p.status, confidence: p.confidence,
      };
    });

    // Carica linee guida dai documenti di tipo guideline
    const docRecords = await runQuery(
      `MATCH (p:Project {id: $pid})-[:HAS_DOCUMENT]->(d:Document) WHERE d.type IN ['guideline','assessment'] RETURN d.filename AS name, d.content AS content LIMIT 5`,
      { pid: projectId }
    );
    const guidelineContext = docRecords
      .map(r => `[${r.get('name')}]: ${(r.get('content') || '').slice(0, 2000)}`)
      .join('\n---\n');

    const systemPrompt = CHAT_SYSTEM(project, resources, guidelineContext);
    const llm = getLLM(project.llmProvider);

    const messages = [
      ...history.slice(-10), // mantieni gli ultimi 10 scambi
      { role: 'user', content: message },
    ];

    const stream = await llm.streamChat(systemPrompt, messages);
    let fullResponse = '';

    for await (const chunk of stream) {
      send({ type: 'chunk', text: chunk });
      fullResponse += chunk;
    }

    // Estrai eventuali aggiornamenti tag dal messaggio (JSON fenced block)
    const tagMatch = fullResponse.match(/```json\s*([\s\S]*?)```/);
    if (tagMatch) {
      try {
        const updates = JSON.parse(tagMatch[1]);
        if (Array.isArray(updates)) {
          for (const upd of updates) {
            if (upd.resourceId && upd.tags) {
              await runQuery(
                `MATCH (r:Resource {id: $id}) SET r.proposedTags = $tags, r.status = $status`,
                {
                  id: upd.resourceId,
                  tags: JSON.stringify(upd.tags),
                  status: upd.confirmed ? 'confirmed' : 'tagged',
                }
              );
            }
          }
          send({ type: 'graph_updated', count: updates.length });
        }
      } catch (_) { /* JSON malformato, ignora */ }
    }

    send({ type: 'done' });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.end();
});

export default router;
