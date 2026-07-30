// View: 3D Force Graph (3d-force-graph via CDN)
let _graphInstance = null;

window.renderGraph = async function(projectId) {
  const el = document.getElementById('viewGraph');
  el.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Grafo 3D Risorse</h1>
      <div class="page-actions">
        <select class="form-select" id="filterType" style="width:160px">
          <option value="">Tutti i nodi</option>
          <option value="status:pending">Stato: pending</option>
          <option value="status:tagged">Stato: tagged</option>
          <option value="status:uncertain">Stato: uncertain</option>
          <option value="status:confirmed">Stato: confirmed</option>
        </select>
        <button class="btn-secondary" id="btnReload">↺ Ricarica</button>
        <button class="btn-secondary" id="btnFitView">⊡ Centra</button>
      </div>
    </div>

    <div class="graph-container" id="graphContainer">
      <div id="graphCanvas"></div>

      <div class="graph-legend">
        <div class="legend-row"><span class="legend-dot" style="background:#8b949e"></span> Pending</div>
        <div class="legend-row"><span class="legend-dot" style="background:#58a6ff"></span> Tagged</div>
        <div class="legend-row"><span class="legend-dot" style="background:#d29922"></span> Uncertain</div>
        <div class="legend-row"><span class="legend-dot" style="background:#3fb950"></span> Confirmed</div>
      </div>
    </div>

    <div class="node-tooltip hidden" id="nodeTooltip"></div>`;

  // Carica 3d-force-graph da CDN se non già caricato
  if (!window.ForceGraph3D) {
    await loadScript('https://unpkg.com/3d-force-graph@1.73.4/dist/3d-force-graph.min.js');
  }

  await drawGraph(projectId);

  document.getElementById('filterType').addEventListener('change', () => drawGraph(projectId));
  document.getElementById('btnReload').addEventListener('click', () => drawGraph(projectId));
  document.getElementById('btnFitView').addEventListener('click', () => _graphInstance?.zoomToFit(400));
};

async function drawGraph(projectId) {
  const canvas = document.getElementById('graphCanvas');
  const container = document.getElementById('graphContainer');
  const filterVal = document.getElementById('filterType')?.value || '';
  canvas.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)"><span class="spinner"></span></div>';

  try {
    const [filter, filterValue] = filterVal.split(':');
    const data = await window.api.getGraph(projectId, filter && filterValue ? { filter, filterValue } : {});

    if (!data.nodes.length) {
      canvas.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🕸</div><p>Nessuna risorsa nel grafo. Carica un documento di tipo "Estrazione AWS".</p></div>';
      return;
    }

    canvas.innerHTML = '';
    const w = container.clientWidth;
    const h = container.clientHeight;

    _graphInstance = window.ForceGraph3D()(canvas)
      .width(w).height(h)
      .backgroundColor('#060a0f')
      .graphData(data)
      .nodeLabel(n => `${n.name}\n${n.type}`)
      .nodeColor(n => nodeColor(n.status))
      .nodeVal(n => Math.max(1, Object.keys(n.proposedTags || {}).length * 1.5 + 2))
      .nodeOpacity(0.9)
      .linkColor(() => '#30363d')
      .linkWidth(0.8)
      .linkOpacity(0.5)
      .linkDirectionalArrowLength(4)
      .linkDirectionalArrowRelPos(1)
      .linkLabel(l => l.type)
      .onNodeClick(node => openNodePanel(node, projectId))
      .onNodeHover(node => showTooltip(node));

    // Dopo 2s stabilizza il grafo
    setTimeout(() => _graphInstance?.d3Force('charge')?.strength(-120), 2000);
  } catch (e) {
    canvas.innerHTML = `<div class="empty-state" style="color:var(--danger)">Errore: ${e.message}</div>`;
  }
}

function nodeColor(status) {
  return { pending: '#8b949e', tagged: '#58a6ff', uncertain: '#d29922', confirmed: '#3fb950' }[status] || '#8b949e';
}

function showTooltip(node) {
  const el = document.getElementById('nodeTooltip');
  if (!node) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.style.left = '50%'; el.style.top = '60px';
  const tags = node.proposedTags || {};
  el.innerHTML = `
    <strong>${node.name}</strong><br>
    <span class="text-muted">${node.type}</span><br>
    Stato: <strong style="color:${nodeColor(node.status)}">${node.status}</strong>
    · Confidence: ${Math.round((node.confidence||0)*100)}%
    ${Object.keys(tags).length ? `<hr style="border-color:var(--border);margin:6px 0">
    ${Object.entries(tags).map(([k,v]) => `<code>${k}</code>: ${v}`).join('<br>')}` : ''}`;
}

function openNodePanel(node, projectId) {
  const existing = document.getElementById('nodePanelOverlay');
  if (existing) existing.remove();

  const tags = node.proposedTags || {};
  const overlay = document.createElement('div');
  overlay.id = 'nodePanelOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:560px;max-height:80vh;overflow-y:auto">
      <div class="modal-title">${node.name}</div>
      <div class="flex-col" style="font-size:.85rem">
        <div><span class="text-muted">ARN:</span> <code style="font-size:.78rem">${node.id}</code></div>
        <div><span class="text-muted">Tipo:</span> ${node.type} · <span class="text-muted">Servizio:</span> ${node.service}</div>
        <div><span class="text-muted">Stato:</span> <strong style="color:${nodeColor(node.status)}">${node.status}</strong>
          · <span class="text-muted">Confidence:</span> ${Math.round((node.confidence||0)*100)}%</div>
        ${node.notes ? `<div><span class="text-muted">Note:</span> ${node.notes}</div>` : ''}
      </div>

      <div class="card-title mt-4">Tag proposti</div>
      <div id="tagEditor" class="flex-col">
        ${Object.entries(tags).map(([k,v]) => tagRow(k, v)).join('')}
        <button class="btn-secondary" id="btnAddTag">+ Aggiungi tag</button>
      </div>

      <div class="modal-footer">
        <button class="btn-secondary" id="npClose">Chiudi</button>
        <button class="btn-secondary" id="npRetag">↺ Ri-tagga con LLM</button>
        <button class="btn-primary"   id="npConfirm">✓ Conferma Tag</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#npClose').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#btnAddTag').addEventListener('click', () => {
    const row = document.createElement('div');
    row.innerHTML = tagRow('cineca:', '');
    overlay.querySelector('#tagEditor').insertBefore(row.firstChild, overlay.querySelector('#btnAddTag'));
  });

  overlay.querySelector('#npRetag').addEventListener('click', async () => {
    const guidance = prompt('Indicazione opzionale per il LLM (lascia vuoto per usare solo il contesto):') || '';
    try {
      await window.api.retagResource(projectId, node.id, guidance);
      window.toast('Ri-tagging completato', 'success');
      overlay.remove();
      drawGraph(projectId);
    } catch (e) { window.toast('Errore: ' + e.message, 'error'); }
  });

  overlay.querySelector('#npConfirm').addEventListener('click', async () => {
    const rows = overlay.querySelectorAll('.tag-row');
    const confirmedTags = {};
    rows.forEach(r => {
      const k = r.querySelector('.tag-key').value.trim();
      const v = r.querySelector('.tag-val').value.trim();
      if (k && v) confirmedTags[k] = v;
    });
    try {
      await window.api.confirmTags(projectId, node.id, confirmedTags);
      window.toast('Tag confermati', 'success');
      overlay.remove();
      drawGraph(projectId);
    } catch (e) { window.toast('Errore: ' + e.message, 'error'); }
  });
}

function tagRow(k, v) {
  return `<div class="tag-row" style="display:flex;gap:8px">
    <input class="form-input tag-key" value="${k}" placeholder="cineca:env" style="flex:1">
    <input class="form-input tag-val" value="${v}" placeholder="prod" style="flex:1">
  </div>`;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
