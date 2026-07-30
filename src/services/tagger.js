import { runQuery } from './db.js';
import { getLLM } from './llm.js';
import { TAG_RESOURCES_PROMPT } from '../prompts/tag_resources.js';

const BATCH_SIZE = 20; // risorse per chiamata LLM

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
           r.status = $status, r.notes = $notes, r.projectId = $projectId
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
  // Carica risorse pending
  const records = await runQuery(
    `MATCH (p:Project {id: $id})-[:HAS_RESOURCE]->(r:Resource)
     WHERE r.status = 'pending' RETURN r`,
    { id: project.id }
  );
  if (!records.length) return;

  const resources = records.map(rec => {
    const p = rec.get('r').properties;
    return { id: p.id, arn: p.arn, resourceType: p.resourceType, name: p.name,
             region: p.region, service: p.service, rawTags: JSON.parse(p.rawTags || '{}') };
  });

  const { guidelineCtx, assessmentCtx } = await loadDocumentContexts(project.id);
  const llm = getLLM(project.llmProvider);

  // Processa in batch
  for (let i = 0; i < resources.length; i += BATCH_SIZE) {
    const batch = resources.slice(i, i + BATCH_SIZE);
    const prompt = TAG_RESOURCES_PROMPT(project, batch, guidelineCtx, assessmentCtx);
    let responseText;
    try {
      responseText = await llm.complete('Sei un esperto FinOps AWS.', prompt);
    } catch (err) {
      console.error(`[tagger] batch ${i} fallito:`, err.message);
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
  }
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
