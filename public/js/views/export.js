// View: Export
window.renderExport = async function(projectId) {
  const el = document.getElementById('viewExport');
  const proj = window.getCurrentProject();

  el.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Esporta Risultati</h1>
    </div>

    <div id="exportStats" class="card">
      <div class="spinner"></div>
    </div>

    <div class="export-grid">
      <div class="export-card">
        <div class="export-icon">📊</div>
        <div>
          <strong>XLSX — Risorse taggate</strong>
          <div class="export-desc">Foglio Excel con tutte le risorse, i tag proposti e lo stato. Colorato per stato (confermato/incerto/pending).</div>
        </div>
        <a class="btn-primary" href="${window.api.getXlsxUrl(projectId)}" download>⬇ Scarica XLSX</a>
      </div>

      <div class="export-card">
        <div class="export-icon">📝</div>
        <div>
          <strong>Markdown — Riepilogo criteri</strong>
          <div class="export-desc">Documento che riepiloga i criteri applicati per risolvere incertezze, raggruppato per servizio AWS.</div>
        </div>
        <a class="btn-primary" href="${window.api.getSummaryUrl(projectId)}" download>⬇ Scarica Summary</a>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Risorse incerte — revisione finale</div>
      <div id="uncertainTable"><div class="spinner"></div></div>
    </div>`;

  await Promise.all([loadExportStats(projectId), loadUncertainTable(projectId)]);
};

async function loadExportStats(projectId) {
  const el = document.getElementById('exportStats');
  try {
    const s = await window.api.getTaggingStatus(projectId);
    const total = Object.values(s).reduce((a, b) => a + b, 0);
    el.innerHTML = `
      <div class="card-title">Stato complessivo</div>
      <div class="stats-bar">
        ${chip('✓ Confermati', s.confirmed||0, '#3fb950')}
        ${chip('~ Tagged', s.tagged||0, '#58a6ff')}
        ${chip('? Incerti', s.uncertain||0, '#d29922')}
        ${chip('○ Pending', s.pending||0, '#8b949e')}
      </div>
      ${s.uncertain > 0 ? `
        <div style="margin-top:12px;padding:10px 14px;background:rgba(210,153,34,.1);border:1px solid var(--warn);border-radius:var(--radius);font-size:.85rem;color:var(--warn)">
          ⚠ ${s.uncertain} risorse ancora incerte. Usa la chat o il pannello grafo per risolverle prima dell'esportazione.
        </div>` : `
        <div style="margin-top:12px;padding:10px 14px;background:rgba(63,185,80,.1);border:1px solid var(--accent2);border-radius:var(--radius);font-size:.85rem;color:var(--accent2)">
          ✓ Nessuna risorsa incerta. Pronto per l'esportazione.
        </div>`}`;
  } catch { el.innerHTML = '<div class="text-muted">Statistiche non disponibili</div>'; }
}

async function loadUncertainTable(projectId) {
  const el = document.getElementById('uncertainTable');
  try {
    const data = await window.api.getGraph(projectId, { filter: 'status', filterValue: 'uncertain' });
    if (!data.nodes.length) {
      el.innerHTML = '<div class="text-muted">Nessuna risorsa incerta. 🎉</div>';
      return;
    }
    el.innerHTML = `
      <div style="overflow-x:auto">
        <table>
          <thead><tr>
            <th>Nome</th><th>Tipo</th><th>Regione</th><th>Confidence</th><th>Note LLM</th><th>Azioni</th>
          </tr></thead>
          <tbody>
            ${data.nodes.map(n => `
              <tr>
                <td>${n.name}</td>
                <td>${n.type}</td>
                <td>${n.region || '—'}</td>
                <td>${Math.round((n.confidence||0)*100)}%</td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${n.notes||''}">${n.notes || '—'}</td>
                <td>
                  <button class="btn-secondary" style="font-size:.75rem;padding:4px 8px"
                    onclick="window.openChatForResource('${n.id}','${n.name.replace(/'/g,'')}')">
                    💬 Chiarisci
                  </button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) {
    el.innerHTML = `<div style="color:var(--danger)">Errore: ${e.message}</div>`;
  }
}

function chip(label, count, color) {
  return `<span class="stat-chip"><span class="dot" style="background:${color}"></span>${label}: <strong>${count}</strong></span>`;
}

window.openChatForResource = function(resourceId, name) {
  document.getElementById('chatToggle').click();
  document.getElementById('chatInput').value = `Aiutami a decidere i tag per la risorsa "${name}" (id: ${resourceId})`;
  document.getElementById('chatInput').focus();
};
