import { runQuery } from './db.js';
import { getLLM } from './llm.js';
import { TAG_RESOURCES_PROMPT } from '../prompts/tag_resources.js';

const BATCH_SIZE = 20;

// ---------------------------------------------------------------------------
// Progress tracking (in-memory, per-project)
// ---------------------------------------------------------------------------
const _jobs = new Map();

export function getTaggingProgress(projectId) {
  return _jobs.get(projectId) || null;
}

function setProgress(projectId, patch) {
  const current = _jobs.get(projectId) || {};
  _jobs.set(projectId, { ...current, ...patch });
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------
export async function ingestResources(projectId, resources) {
  for (const r of resources) {
    await runQuery(
      `MATCH (p:Project {id: $projectId})
       MERGE (r:Resource {id: $id})
       SET r.arn = $arn, r.resourceType = $resourceType, r.service = $service,
           r.resourceId = $resourceId, r.name = $name, r.region = $region,
           r.accountId = $accountId, r.rawTags = $rawTags,
           r.proposedTags = $proposedTags, r.confidence = $confidence,
           r.status = $status, r.notes = $notes, r.projectId = $projectId,
           r.nodeType = $nodeType
       MERGE (p)-[:HAS_RESOURCE]->(r)`,
      {
        projectId,
        id: r.id,
        arn: r.arn || '',
        resourceType: r.resourceType || '',
        service: r.service || '',
        resourceId: r.resourceId || '',
        name: r.name || '',
        region: r.region || '',
        accountId: r.accountId || '',
        rawTags: JSON.stringify(r.rawTags || {}),
        proposedTags: JSON.stringify(r.proposedTags || {}),
        confidence: r.confidence || 0,
        status: r.status || 'pending',
        notes: r.notes || '',
        nodeType: r.nodeType || 'delivery',
      }
    );
  }
}

export async function ingestRelationships(projectId, relationships) {
  for (const rel of relationships) {
    await runQuery(
      `MATCH (a:Resource {id: $sourceId})<-[:HAS_RESOURCE]-(p:Project {id: $pid})
       MATCH (b:Resource {id: $targetId})<-[:HAS_RESOURCE]-(p)
       MERGE (a)-[:${rel.type}]->(b)`,
      { sourceId: rel.sourceId, targetId: rel.targetId, pid: projectId }
    );
  }
}

// ---------------------------------------------------------------------------
// Tagging LLM
// ---------------------------------------------------------------------------
export async function tagAllResources(project) {
  const projectId = project.id;

  const records = await runQuery(
    `MATCH (p:Project {id: $id})-[:HAS_RESOURCE]->(r:Resource)
     WHERE r.status = 'pending' RETURN r`,
    { id: projectId }
  );
  if (!records.length) {
    setProgress(projectId, { status: 'done', total: 0, processed: 0, errors: [], startedAt: Date.now(), endedAt: Date.now() });
    return;
  }

  const resources = records.map(rec => {
    const p = rec.get('r').properties;
    return { id: p.id, arn: p.arn, resourceType: p.resourceType, name: p.name,
             region: p.region, service: p.service, rawTags: JSON.parse(p.rawTags || '{}') };
  });

  const batchTotal = Math.ceil(resources.length / BATCH_SIZE);
  setProgress(projectId, {
    status: 'running',
    total: resources.length,
    processed: 0,
    batch: 0,
    batchTotal,
    errors: [],
    startedAt: Date.now(),
    llmProvider: project.llmProvider,
  });

  const { guidelineCtx, assessmentCtx } = await loadDocumentContexts(projectId);
  const llm = getLLM(project.llmProvider);

  for (let i = 0; i < resources.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = resources.slice(i, i + BATCH_SIZE);
    setProgress(projectId, { batch: batchNum, currentNames: batch.map(r => r.name || r.id).slice(0, 5) });

    const prompt = TAG_RESOURCES_PROMPT(project, batch, guidelineCtx, assessmentCtx);
    let responseText;
    try {
      responseText = await llm.complete('Sei un esperto FinOps AWS.', prompt);
    } catch (err) {
      console.error(`[tagger] batch ${batchNum}/${batchTotal} fallito:`, err.message);
      const job = _jobs.get(projectId);
      const errors = [...(job?.errors || []), `Batch ${batchNum}: ${err.message}`];
      setProgress(projectId, { errors });
      continue;
    }

    const updates = extractJsonArray(responseText);
    for (const upd of updates) {
      if (!upd.resourceId) continue;
      await runQuery(
        `MATCH (r:Resource {id: $id})
         SET r.proposedTags = $tags, r.confidence = $confidence,
             r.status = $status, r.notes = $notes`,
        {
          id: upd.resourceId,
          tags: JSON.stringify(upd.tags || {}),
          confidence: upd.confidence || 0,
          status: upd.status || 'pending',
          notes: upd.reasoning || '',
        }
      );
    }
    setProgress(projectId, { processed: Math.min(i + BATCH_SIZE, resources.length) });
  }

  const job = _jobs.get(projectId);
  setProgress(projectId, {
    status: job?.errors?.length > 0 ? 'done_with_errors' : 'done',
    endedAt: Date.now(),
  });

  // Auto-pulizia dopo 10 minuti
  setTimeout(() => _jobs.delete(projectId), 10 * 60 * 1000);
}

export async function tagSingleResource(project, resourceId, guidance = '') {
  const records = await runQuery(
    `MATCH (r:Resource {id: $id}) RETURN r`, { id: resourceId }
  );
  if (!records.length) throw new Error('Risorsa non trovata');
  const props = records[0].get('r').properties;
  const resource = {
    id: props.id, arn: props.arn, resourceType: props.resourceType,
    name: props.name, region: props.region, service: props.service,
    rawTags: JSON.parse(props.rawTags || '{}'),
  };

  const { guidelineCtx, assessmentCtx } = await loadDocumentContexts(project.id);
  const prompt = TAG_RESOURCES_PROMPT(
    project, [resource],
    guidelineCtx + (guidance ? `\n\nIndicazione utente: ${guidance}` : ''),
    assessmentCtx
  );

  const llm = getLLM(project.llmProvider);
  const responseText = await llm.complete('Sei un esperto FinOps AWS.', prompt);
  const updates = extractJsonArray(responseText);
  const upd = updates[0];
  if (!upd) throw new Error('LLM non ha restituito risultati');

  await runQuery(
    `MATCH (r:Resource {id: $id})
     SET r.proposedTags = $tags, r.confidence = $confidence,
         r.status = $status, r.notes = $notes`,
    {
      id: resourceId,
      tags: JSON.stringify(upd.tags || {}),
      confidence: upd.confidence || 0,
      status: upd.status || 'pending',
      notes: upd.reasoning || '',
    }
  );
  return { ...upd, resourceId };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function loadDocumentContexts(projectId) {
  const records = await runQuery(
    `MATCH (p:Project {id: $id})-[:HAS_DOCUMENT]->(d:Document) RETURN d`,
    { id: projectId }
  );
  let guidelineCtx = '', assessmentCtx = '';
  for (const rec of records) {
    const d = rec.get('d').properties;
    const snippet = (d.content || '').slice(0, 3000);
    if (d.type === 'guideline') guidelineCtx += `\n[${d.filename}]\n${snippet}\n`;
    else if (d.type === 'assessment') assessmentCtx += `\n[${d.filename}]\n${snippet}\n`;
  }
  return { guidelineCtx, assessmentCtx };
}

function extractJsonArray(text) {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try { return JSON.parse(match[0]); } catch (_) { return []; }
}
