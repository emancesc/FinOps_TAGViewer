import fs from 'fs/promises';
import path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { v4 as uuidv4 } from 'uuid';
import ExcelJS from 'exceljs';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function parseDocument(filePath, docType, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  // assessment + XLSX: parse rows as assessment nodes (skip binary readFile)
  if (docType === 'assessment' && ext === '.xlsx') {
    return await parseAssessmentXlsx(filePath);
  }

  const raw = await readFile(filePath, ext);

  if (docType === 'resource_export') {
    const resources = parseResourceExport(raw, ext);
    return { content: raw, resources, relationships: inferRelationships(resources) };
  }

  // guideline / assessment (non-XLSX): solo testo + nessuna risorsa strutturata
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

// Mappa campi AWS CLI → tipo risorsa
const AWS_CLI_FORMATS = [
  { key: 'VolumeId',            type: 'AWS::EC2::Volume',          service: 'EC2' },
  { key: 'SnapshotId',          type: 'AWS::EC2::Snapshot',         service: 'EC2' },
  { key: 'SecurityGroupId',     type: 'AWS::EC2::SecurityGroup',    service: 'EC2' },
  { key: 'SubnetId',            type: 'AWS::EC2::Subnet',           service: 'EC2' },
  { key: 'VpcId',               type: 'AWS::EC2::VPC',              service: 'EC2' },
  { key: 'ImageId',             type: 'AWS::EC2::Image',            service: 'EC2' },
  { key: 'DBInstanceIdentifier',type: 'AWS::RDS::DBInstance',       service: 'RDS' },
  { key: 'DBClusterIdentifier', type: 'AWS::RDS::DBCluster',        service: 'RDS' },
  { key: 'FunctionName',        type: 'AWS::Lambda::Function',      service: 'Lambda' },
  { key: 'BucketName',          type: 'AWS::S3::Bucket',            service: 'S3' },
  { key: 'ClusterName',         type: 'AWS::ECS::Cluster',          service: 'ECS' },
  { key: 'ServiceName',         type: 'AWS::ECS::Service',          service: 'ECS' },
  { key: 'TableName',           type: 'AWS::DynamoDB::Table',       service: 'DynamoDB' },
  { key: 'QueueUrl',            type: 'AWS::SQS::Queue',            service: 'SQS' },
  { key: 'TopicArn',            type: 'AWS::SNS::Topic',            service: 'SNS' },
  { key: 'DistributionId',      type: 'AWS::CloudFront::Distribution', service: 'CloudFront' },
  { key: 'HostedZoneId',        type: 'AWS::Route53::HostedZone',   service: 'Route53' },
  { key: 'CacheClusterId',      type: 'AWS::ElastiCache::CacheCluster', service: 'ElastiCache' },
  { key: 'FileSystemId',        type: 'AWS::EFS::FileSystem',       service: 'EFS' },
  { key: 'NatGatewayId',        type: 'AWS::EC2::NatGateway',       service: 'EC2' },
  { key: 'InternetGatewayId',   type: 'AWS::EC2::InternetGateway',  service: 'EC2' },
  { key: 'RouteTableId',        type: 'AWS::EC2::RouteTable',       service: 'EC2' },
  { key: 'NetworkInterfaceId',  type: 'AWS::EC2::NetworkInterface', service: 'EC2' },
  { key: 'AllocationId',        type: 'AWS::EC2::EIP',              service: 'EC2' },
  { key: 'KeyName',             type: 'AWS::EC2::KeyPair',          service: 'EC2' },
];

function extractTagsFromItem(item) {
  let rawTags = {};
  if (!item.Tags) return rawTags;
  if (Array.isArray(item.Tags)) {
    item.Tags.forEach(t => { if (t.Key && t.Value !== undefined) rawTags[t.Key] = t.Value; });
  } else if (typeof item.Tags === 'object') {
    rawTags = item.Tags;
  } else if (typeof item.Tags === 'string') {
    try { rawTags = JSON.parse(item.Tags); } catch (_) { rawTags = parseCsvTags(item.Tags); }
  }
  return rawTags;
}

function nameFromTags(tags) {
  return tags?.Name || tags?.name || tags?.['aws:cloudformation:stack-name'] || '';
}

function normalizeResource(item) {
  // ── Formato AWS Resource Explorer (ha campo ARN) ──────────────────────────
  const arn = item.Arn || item.arn || item.ARN || item.ResourceARN
           || item.LoadBalancerArn || item.TargetGroupArn || item.TopicArn
           || item.StreamARN || item.RoleArn || item.PolicyArn || '';

  if (arn && arn.startsWith('arn:')) {
    const type = item.ResourceType || item.Type || item.type || inferTypeFromArn(arn);
    const rawTags = extractTagsFromItem(item);
    const name = item.Name || item.name || nameFromTags(rawTags) || extractNameFromArn(arn);
    return {
      id: uuidv4(), arn,
      resourceType: type, service: extractService(type),
      resourceId: extractResourceId(arn) || name,
      name: name || arn,
      region: item.Region || item.region || extractRegionFromArn(arn),
      accountId: item.AccountId || item.account_id || extractAccountFromArn(arn),
      rawTags, proposedTags: {}, confidence: 0, status: 'pending', notes: '',
    };
  }

  // ── Formati AWS CLI (export di servizi specifici) ─────────────────────────
  for (const fmt of AWS_CLI_FORMATS) {
    if (!item[fmt.key]) continue;
    const resourceId = item[fmt.key];
    const rawTags = extractTagsFromItem(item);
    const name = item.Name || item.name || nameFromTags(rawTags) || resourceId;
    const region = item.Region || item.region
      || (item.AvailabilityZone ? item.AvailabilityZone.slice(0, -1) : '')
      || (item.Endpoint?.Address ? '' : '');
    const accountId = item.OwnerId || item.AccountId || item.account_id || '';

    // Metadati extra rilevanti da includere nelle note
    const extra = {};
    ['State', 'Status', 'InstanceId', 'VpcId', 'SubnetId', 'CreateTime',
     'InstanceType', 'Engine', 'EngineVersion', 'Runtime', 'Handler'].forEach(k => {
      if (item[k]) extra[k] = typeof item[k] === 'object' ? item[k].Name || JSON.stringify(item[k]) : item[k];
    });

    return {
      id: uuidv4(), arn: '',
      resourceType: fmt.type, service: fmt.service,
      resourceId, name: name || resourceId,
      region, accountId,
      rawTags, proposedTags: {}, confidence: 0, status: 'pending',
      notes: Object.keys(extra).length ? JSON.stringify(extra) : '',
    };
  }

  // ── EC2 Instance (InstanceId senza VolumeId) ──────────────────────────────
  if (item.InstanceId) {
    const rawTags = extractTagsFromItem(item);
    const name = nameFromTags(rawTags) || item.InstanceId;
    return {
      id: uuidv4(), arn: '',
      resourceType: 'AWS::EC2::Instance', service: 'EC2',
      resourceId: item.InstanceId, name,
      region: item.Placement?.AvailabilityZone?.slice(0, -1) || item.Region || '',
      accountId: item.OwnerId || '',
      rawTags, proposedTags: {}, confidence: 0, status: 'pending',
      notes: JSON.stringify({ State: item.State?.Name, InstanceType: item.InstanceType }),
    };
  }

  // ── Fallback generico: cerca qualsiasi campo *Id o *Name ─────────────────
  const idKey = Object.keys(item).find(k => /Id$/.test(k) && typeof item[k] === 'string' && item[k]);
  const nameKey = Object.keys(item).find(k => /Name$/.test(k) && typeof item[k] === 'string' && item[k]);
  const resourceId = idKey ? item[idKey] : (nameKey ? item[nameKey] : uuidv4());
  const rawTags = extractTagsFromItem(item);
  return {
    id: uuidv4(), arn: '',
    resourceType: 'Unknown', service: 'Unknown',
    resourceId, name: (nameKey ? item[nameKey] : resourceId),
    region: item.Region || item.region || '',
    accountId: item.AccountId || item.OwnerId || '',
    rawTags, proposedTags: {}, confidence: 0, status: 'pending', notes: '',
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
// Assessment XLSX parser — converte righe in nodi assessment
// ---------------------------------------------------------------------------
async function parseAssessmentXlsx(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  // Seleziona il foglio più rilevante
  let ws = null;
  let maxRows = 0;
  for (const sheet of workbook.worksheets) {
    const lname = sheet.name.toLowerCase();
    if (lname.includes('resource') || lname.includes('server') ||
        lname.includes('component') || lname.includes('assessment') ||
        lname.includes('inventory')) {
      ws = sheet;
      break;
    }
    if (sheet.rowCount > maxRows) {
      maxRows = sheet.rowCount;
      ws = sheet;
    }
  }
  if (!ws) return { content: '', resources: [], relationships: [] };

  // Leggi intestazioni dalla prima riga
  const headers = {};
  ws.getRow(1).eachCell((cell, colIdx) => {
    if (cell.value !== null && cell.value !== undefined) {
      headers[colIdx] = String(cell.value).trim();
    }
  });

  const colIndices = Object.keys(headers).map(Number);
  if (!colIndices.length) return { content: '', resources: [], relationships: [] };

  // Auto-detect colonna nome e tipo
  const NAME_CANDIDATES = ['name', 'nome', 'resource', 'server', 'component',
                           'hostname', 'host', 'instance', 'service'];
  const TYPE_CANDIDATES = ['type', 'resourcetype', 'resource type', 'tipo', 'kind', 'categoria'];

  let nameColIdx = Math.min(...colIndices);
  let typeColIdx = -1;

  for (const [idx, hdr] of Object.entries(headers)) {
    const lower = hdr.toLowerCase();
    if (NAME_CANDIDATES.some(c => lower === c || lower.includes(c))) {
      nameColIdx = Number(idx);
      break;
    }
  }
  for (const [idx, hdr] of Object.entries(headers)) {
    const lower = hdr.toLowerCase();
    if (TYPE_CANDIDATES.some(c => lower === c)) {
      typeColIdx = Number(idx);
      break;
    }
  }

  const assessmentResources = [];
  const textLines = [Object.values(headers).join('\t')];

  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return;

    const cells = {};
    let hasData = false;
    row.eachCell((cell, colIdx) => {
      if (headers[colIdx] !== undefined && cell.value !== null && cell.value !== undefined) {
        const strVal = String(cell.value).trim();
        if (strVal) { cells[headers[colIdx]] = strVal; hasData = true; }
      }
    });
    if (!hasData) return;

    const nameRaw = row.getCell(nameColIdx).value;
    const nameVal = nameRaw !== null && nameRaw !== undefined ? String(nameRaw).trim() : '';
    if (!nameVal) return;

    const typeRaw = typeColIdx > 0 ? row.getCell(typeColIdx).value : null;
    const typeVal = typeRaw !== null && typeRaw !== undefined ? String(typeRaw).trim() : '';

    const resId = uuidv4();
    assessmentResources.push({
      id: resId,
      arn: `assessment:${resId}`,
      resourceType: typeVal || 'OnPrem::Resource',
      service: typeVal ? (typeVal.split('::')[0] || 'OnPrem') : 'OnPrem',
      resourceId: nameVal,
      name: nameVal,
      region: cells['Region'] || cells['region'] || cells['Regione'] || '',
      accountId: '',
      rawTags: {},
      proposedTags: {},
      confidence: 0,
      status: 'assessment',
      nodeType: 'assessment',
      notes: JSON.stringify(cells),
    });

    textLines.push(Object.values(cells).join('\t'));
  });

  return {
    content: textLines.join('\n').slice(0, 50_000),
    resources: assessmentResources,
    relationships: [],
  };
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
