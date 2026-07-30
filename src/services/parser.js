import fs from 'fs/promises';
import path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function parseDocument(filePath, docType, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const raw = await readFile(filePath, ext);

  if (docType === 'resource_export') {
    const resources = parseResourceExport(raw, ext);
    return { content: raw, resources, relationships: inferRelationships(resources) };
  }

  // guideline / assessment: solo testo + nessuna risorsa strutturata
  return { content: raw.slice(0, 50_000), resources: [], relationships: [] };
}

// ---------------------------------------------------------------------------
// Lettura file in testo
// ---------------------------------------------------------------------------
async function readFile(filePath, ext) {
  const buf = await fs.readFile(filePath);
  if (ext === '.pdf') {
    const data = await pdfParse(buf);
    return data.text;
  }
  if (ext === '.docx' || ext === '.doc') {
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value;
  }
  return buf.toString('utf-8');
}

// ---------------------------------------------------------------------------
// Parser AWS Resource Explorer
// ---------------------------------------------------------------------------
function parseResourceExport(raw, ext) {
  if (ext === '.json') return parseResourceJson(raw);
  if (ext === '.csv') return parseResourceCsv(raw);
  // Prova JSON, poi CSV, poi best-effort
  try { return parseResourceJson(raw); } catch (_) {}
  try { return parseResourceCsv(raw); } catch (_) {}
  return [];
}

function parseResourceJson(raw) {
  const data = JSON.parse(raw);
  const items = Array.isArray(data)
    ? data
    : data.Resources ?? data.resources ?? data.items ?? [];
  return items.map(normalizeResource);
}

function parseResourceCsv(raw) {
  const rows = csvParse(raw, { columns: true, skip_empty_lines: true, trim: true });
  return rows.map(normalizeResource);
}

function normalizeResource(item) {
  // Supporta sia il formato AWS Resource Explorer che export custom CINECA
  const arn = item.Arn || item.arn || item.ARN || item.ResourceARN || '';
  const type = item.ResourceType || item.Type || item.type || inferTypeFromArn(arn);
  const name = item.Name || item.name || item.ResourceId || extractNameFromArn(arn) || arn;
  const region = item.Region || item.region || extractRegionFromArn(arn) || '';
  const accountId = item.AccountId || item.account_id || extractAccountFromArn(arn) || '';

  let rawTags = {};
  if (item.Tags && typeof item.Tags === 'object') rawTags = item.Tags;
  else if (typeof item.Tags === 'string') {
    try { rawTags = JSON.parse(item.Tags); } catch (_) { rawTags = parseCsvTags(item.Tags); }
  }

  return {
    id: uuidv4(),
    arn,
    resourceType: type,
    service: extractService(type),
    resourceId: extractResourceId(arn) || name,
    name,
    region,
    accountId,
    rawTags,
    proposedTags: {},
    confidence: 0,
    status: 'pending',
    notes: '',
  };
}

function inferTypeFromArn(arn) {
  if (!arn) return 'Unknown';
  const parts = arn.split(':');
  if (parts.length >= 6) return `AWS::${capitalize(parts[2])}::${capitalize(parts[5]?.split('/')[0] || '')}`;
  return 'Unknown';
}

function extractService(type) {
  const m = type.match(/^AWS::([^:]+)::/);
  return m ? m[1] : type;
}

function extractNameFromArn(arn) {
  if (!arn) return '';
  const parts = arn.split('/');
  return parts[parts.length - 1];
}

function extractRegionFromArn(arn) {
  return arn.split(':')[3] || '';
}

function extractAccountFromArn(arn) {
  return arn.split(':')[4] || '';
}

function extractResourceId(arn) {
  if (!arn) return '';
  const parts = arn.split(':');
  return parts[parts.length - 1]?.split('/').pop() || '';
}

function parseCsvTags(str) {
  const tags = {};
  str.split(',').forEach(pair => {
    const [k, v] = pair.split('=');
    if (k && v) tags[k.trim()] = v.trim();
  });
  return tags;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// ---------------------------------------------------------------------------
// Inferenza relazioni da tipo risorsa (euristica baseline)
// ---------------------------------------------------------------------------
function inferRelationships(resources) {
  const rels = [];
  const byType = {};
  for (const r of resources) {
    (byType[r.service] = byType[r.service] || []).push(r);
  }

  // EC2 → RDS (stessa regione)
  for (const ec2 of byType['EC2'] || []) {
    for (const rds of byType['RDS'] || []) {
      if (ec2.region === rds.region) {
        rels.push({ sourceId: ec2.id, targetId: rds.id, type: 'DEPENDS_ON' });
      }
    }
  }
  // ECS → ELB (stessa regione)
  for (const ecs of byType['ECS'] || []) {
    for (const elb of byType['ElasticLoadBalancingV2'] || []) {
      if (ecs.region === elb.region) {
        rels.push({ sourceId: elb.id, targetId: ecs.id, type: 'DEPENDS_ON' });
      }
    }
  }
  // Lambda → S3 (stessa regione)
  for (const fn of byType['Lambda'] || []) {
    for (const bkt of byType['S3'] || []) {
      if (fn.region === bkt.region) {
        rels.push({ sourceId: fn.id, targetId: bkt.id, type: 'DEPENDS_ON' });
      }
    }
  }
  return rels;
}
