// View: 3D Force Graph (3d-force-graph via CDN)
let _graphInstance = null;
let _currentNodeTypeFilter = 'all';
let _currentPropFilter = null;

const STATUS_COLORS = {
  pending:     '#8b949e',
  tagged:      '#58a6ff',
  uncertain:   '#d29922',
  confirmed:   '#3fb950',
  tagged_xlsx: '#c084fc',
  assessment:  '#a78bfa',
};

window.renderGraph = async function(projectId) {
  const el = document.getElementById('viewGraph');
  _currentNodeTypeFilter = 'all';
  _currentPropFilter = null;

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

      <div class="graph-controls" id="graphControls">
        <div class="graph-filter-group">
          <label class="graph-filter-label">Tipo nodo</label>
          <div class="btn-group">
            <button class="filter-btn active" data-nodetype="all">Tutti</button>
            <button class="filter-btn" data-nodetype="delivery">Delivery</button>
            <button class="filter-btn" data-nodetype="assessment">Assessment</button>
          </div>
        </div>
        <div class="graph-filter-group">
          <label class="graph-filter-label">Proprietà</label>
          <input type="text" id="propFilterInput" placeholder="es. cineca:Service=LDAP"
            style="background:var(--bg3);border:1px solid var(--border);color:var(--text);
                   border-radius:4px;padding:4px 8px;font-size:.75rem;width:100%">
          <button id="btnApplyPropFilter" class="btn-secondary" style="font-size:.75rem;padding:4px 8px">Applica</button>
        </div>
      </div>

      <div class="graph-legend">
        <div class="legend-row"><span class="legend-dot" style="background:#8b949e"></span> Pending</div>
        <div class="legend-row"><span class="legend-dot" style="background:#58a6ff"></span> Tagged</div>
        <div class="legend-row"><span class="legend-dot" style="background:#d29922"></span> Uncertain</div>
        <div class="legend-row"><span class="legend-dot" style="background:#3fb950"></span> Confirmed</div>
        <div class="legend-row"><span class="legend-dot" style="background:#c084fc"></span> XLSX Tagged</div>
        <div class="legend-row"><span class="legend-dot" style="background:#a78bfa;border-radius:2px"></span> Assessment</div>
      </div>
    </div>

    <div class="node-tooltip hidden" id="nodeTooltip"></div>`;

  // Carica THREE.js (peer dep richiesta da 3d-force-graph) poi il grafo
  if (!window.THREE) {
    await loadScript('https://unpkg.com/three@0.155.0/build/three.min.js');
  }
  if (!window.ForceGraph3D) {
    await loadScript('https://unpkg.com/3d-force-graph@1.73.4/dist/3d-force-graph.min.js');
  }

  await drawGraph(projectId);

  document.getElementById('filterType').addEventListener('change', () => {
    _currentPropFilter = null;
    const inp = document.getElementById('propFilterInput');
    if (inp) inp.value = '';
    drawGraph(projectId);
  });
  document.getElementById('btnReload').addEventListener('click', () => {
    _currentPropFilter = null;
    drawGraph(projectId);
  });
  document.getElementById('btnFitView').addEventListener('click', () => _graphInstance?.zoomToFit(400));

  // Filtri per tipo nodo
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _currentNodeTypeFilter = btn.dataset.nodetype;
      drawGraph(projectId);
    });
  });

  // Filtro per proprietà
  document.getElementById('btnApplyPropFilter')?.addEventListener('click', () => {
    const val = document.getElementById('propFilterInput')?.value?.trim() || '';
    _currentPropFilter = val || null;
    drawGraph(projectId);
  });
  document.getElementById('propFilterInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnApplyPropFilter')?.click();
  });
};

async function drawGraph(projectId) {
  const canvas = document.getElementById('graphCanvas');
  const container = document.getElementById('graphContainer');
  const filterVal = document.getElementById('filterType')?.value || '';
  canvas.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)"><span class="spinner"></span></div>';

  try {
    const params = {};
    if (filterVal) {
      const [f, fv] = filterVal.split(':');
      if (f && fv) { params.filter = f; params.filterValue = fv; }
    }
    if (_currentNodeTypeFilter !== 'all') params.nodeType = _currentNodeTypeFilter;

    let data = await window.api.getGraph(projectId, params);

    // Applica filtro proprietà lato client
    if (_currentPropFilter) {
      data = applyPropFilter(data, _currentPropFilter);
    }

    if (!data.nodes.length) {
      canvas.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🕸</div><p>Nessuna risorsa nel grafo. Carica un documento di tipo "Estrazione AWS".</p></div>';
      return;
    }

    canvas.innerHTML = '';
    const w = container.clientWidth;
    const h = container.clientHeight;

    const g = window.ForceGraph3D()(canvas)
      .width(w).height(h)
      .backgroundColor('#060a0f')
      .graphData(data)
      .nodeLabel(n => `${n.name}\n${n.type}`)
      .nodeColor(n => nodeColor(n))
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

    // Nodi assessment come cubi (box geometry)
    if (window.THREE) {
      g.nodeThreeObject(node => {
        if (node.nodeType !== 'assessment') return null; // usa sfera di default
        const size = Math.max(2, Object.keys(node.proposedTags || {}).length * 0.5 + 3);
        const geo = new window.THREE.BoxGeometry(size, size, size);
        const mat = new window.THREE.MeshLambertMaterial({
          color: 0xa78bfa,
          transparent: true,
          opacity: 0.85,
        });
        return new window.THREE.Mesh(geo, mat);
      }).nodeThreeObjectExtend(false);
    }

    _graphInstance = g;

    // Stabilizza il grafo dopo 2s
    setTimeout(() => _graphInstance?.d3Force('charge')?.strength(-120), 2000);
  } catch (e) {
    canvas.innerHTML = `<div class="empty-state" style="color:var(--danger)">Errore: ${e.message}</div>`;
  }
}

// Colore nodo: viola per assessment, colori status per delivery
function nodeColor(statusOrNode) {
  if (typeof statusOrNode === 'string') {
    return STATUS_COLORS[statusOrNode] || '#8b949e';
  }
  if (statusOrNode?.nodeType === 'assessment') return STATUS_COLORS.assessment;
  return STATUS_COLORS[statusOrNode?.status] || '#8b949e';
}

// Filtro proprietà client-side: "key=value" o "key~=partial"
function applyPropFilter(data, filterStr) {
  let key, op, val;
  if (filterStr.includes('~=')) {
    [key, val] = filterStr.split('~=');
    op = 'contains';
  } else if (filterStr.includes('=')) {
    [key, val] = filterStr.split('=');
    op = 'equals';
  } else {
    return data;
  }
  key = key?.trim();
  val = val?.trim()?.toLowerCase();
  if (!key || !val) return data;

  const filteredNodes = data.nodes.filter(node => {
    // Cerca nei proposedTags (con e senza prefisso Tag:)
    const tags = node.proposedTags || {};
    const tagVal = tags[key] ?? tags['Tag:' + key] ?? tags[key.replace(/^Tag:/, '')];
    if (tagVal !== undefined) {
      const sv = String(tagVal).toLowerCase();
      return op === 'contains' ? sv.includes(val) : sv === val;
    }
    // Cerca nelle proprietà dirette del nodo
    const propVal = node[key];
    if (propVal !== undefined) {
      const sv = String(propVal).toLowerCase();
      return op === 'contains' ? sv.includes(val) : sv === val;
    }
    return false;
  });

  const filteredIds = new Set(filteredNodes.map(n => n.id));
  return {
    nodes: filteredNodes,
    links: data.links.filter(l => filteredIds.has(l.source) && filteredIds.has(l.target)),
  };
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
        ${node.nodeType ? `<div><span class="text-muted">Node type:</span> <code>${node.nodeType}</code></div>` : ''}
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
