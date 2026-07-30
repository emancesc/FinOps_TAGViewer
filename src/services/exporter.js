import ExcelJS from 'exceljs';

export async function exportToXlsx(project, resources) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TagsViewer';
  wb.created = new Date();

  const ws = wb.addWorksheet('Risorse AWS');

  // Raccoglie tutti i tag key presenti
  const tagKeys = new Set();
  for (const r of resources) {
    const tags = JSON.parse(r.proposedTags || '{}');
    Object.keys(tags).forEach(k => tagKeys.add(k));
  }
  const tagCols = [...tagKeys].sort();

  // Header
  const staticCols = ['ARN', 'Tipo', 'Servizio', 'Nome', 'Regione', 'Account', 'Stato', 'Confidence', 'Note'];
  const headerRow = [...staticCols, ...tagCols];
  ws.addRow(headerRow);

  // Stile header
  const headerStyle = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F497D' } },
    alignment: { vertical: 'middle', horizontal: 'center' },
  };
  ws.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));
  ws.getRow(1).height = 20;

  // Colori per stato
  const statusColor = {
    confirmed: 'FFC6EFCE',
    tagged:    'FFDDEBF7',
    uncertain: 'FFFFEB9C',
    pending:   'FFF2F2F2',
  };

  // Righe dati
  for (const r of resources) {
    const tags = JSON.parse(r.proposedTags || '{}');
    const conf = typeof r.confidence === 'object' ? r.confidence.low : r.confidence;
    const row = [
      r.arn, r.resourceType, r.service, r.name, r.region, r.accountId,
      r.status, Math.round((conf || 0) * 100) + '%', r.notes || '',
      ...tagCols.map(k => tags[k] || ''),
    ];
    const dataRow = ws.addRow(row);
    const bgColor = statusColor[r.status] || statusColor.pending;
    dataRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
    });
  }

  // Auto-width (max 50)
  ws.columns.forEach(col => {
    let max = 10;
    col.eachCell({ includeEmpty: true }, cell => {
      const len = String(cell.value || '').length;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, 50);
  });

  // Freeze prima riga
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // Foglio riepilogo
  const wsSummary = wb.addWorksheet('Riepilogo');
  wsSummary.addRow(['Progetto', project.name]);
  wsSummary.addRow(['Account AWS', project.accountId]);
  wsSummary.addRow(['Regione', project.region]);
  wsSummary.addRow(['Esportato il', new Date().toISOString()]);
  wsSummary.addRow([]);
  wsSummary.addRow(['Stato', 'Conteggio']);
  const counts = {};
  for (const r of resources) counts[r.status] = (counts[r.status] || 0) + 1;
  for (const [s, c] of Object.entries(counts)) wsSummary.addRow([s, c]);

  return wb.xlsx.writeBuffer();
}

export async function exportSummary(project, resources) {
  const date = new Date().toISOString().split('T')[0];
  const lines = [
    `# Riepilogo Tagging AWS — ${project.name}`,
    ``,
    `**Account**: ${project.accountId}  `,
    `**Regione**: ${project.region || 'N/D'}  `,
    `**Data esportazione**: ${date}  `,
    `**Totale risorse taggate**: ${resources.length}`,
    ``,
    `---`,
    ``,
    `## Criteri di tagging applicati`,
    ``,
  ];

  // Raggruppa per servizio
  const byService = {};
  for (const r of resources) {
    (byService[r.service] = byService[r.service] || []).push(r);
  }

  for (const [svc, items] of Object.entries(byService)) {
    lines.push(`### ${svc} (${items.length} risorse)`);
    lines.push('');
    for (const r of items) {
      const tags = JSON.parse(r.proposedTags || '{}');
      const conf = typeof r.confidence === 'object' ? r.confidence.low : r.confidence;
      lines.push(`**${r.name || r.resourceId}** (\`${r.arn || r.resourceType}\`)`);
      lines.push(`- Stato: ${r.status} | Confidence: ${Math.round((conf || 0) * 100)}%`);
      if (r.notes) lines.push(`- Ragionamento: ${r.notes}`);
      lines.push(`- Tag:`);
      for (const [k, v] of Object.entries(tags)) {
        lines.push(`  - \`${k}\`: \`${v}\``);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
