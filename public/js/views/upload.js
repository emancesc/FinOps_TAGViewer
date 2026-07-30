// View: Document upload + tagging control
window.renderUpload = async function(projectId) {
  const el = document.getElementById('viewUpload');
  el.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Documenti & Tagging</h1>
      <div class="page-actions">
        <button class="btn-primary" id="btnRunTagging">▶ Avvia Tagging LLM</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
      <!-- Upload zone -->
      <div class="card">
        <div class="card-title">Carica Documento</div>
        <div class="upload-zone" id="uploadZone">
          <div class="upload-zone-icon">📄</div>
          <div class="upload-zone-text">Trascina qui o clicca per selezionare<br><small>JSON, CSV, PDF, DOCX, XLSX, TXT — max 50 MB</small></div>
          <input type="file" id="fileInput" style="display:none" accept=".json,.csv,.pdf,.docx,.doc,.xlsx,.txt,.md">
        </div>
        <div class="flex-col mt-4">
          <div class="form-group">
            <label class="form-label">Tipo documento</label>
            <select class="form-select" id="docType">
              <option value="resource_export">Estrazione AWS Resource Explorer</option>
              <option value="guideline">Linee guida (HLD / Tagging Strategy)</option>
              <option value="assessment">Assessment (On-prem / Cloud design)</option>
            </select>
          </div>
          <button class="btn-primary" id="btnUpload" disabled>Carica</button>
        </div>
      </div>

      <!-- Tagging status -->
      <div class="card">
        <div class="card-title">Stato Tagging</div>
        <div id="taggingStatus">
          <div class="spinner"></div>
        </div>
      </div>
    </div>

    <!-- Documents list -->
    <div class="card">
      <div class="card-title">Documenti caricati</div>
      <div id="docList" class="doc-list"><div class="spinner"></div></div>
    </div>`;

  setupUpload(projectId);
  await Promise.all([loadDocuments(projectId), loadTaggingStatus(projectId)]);

  document.getElementById('btnRunTagging').addEventListener('click', async () => {
    const btn = document.getElementById('btnRunTagging');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Avvio…';
    try {
      await window.api.runTagging(projectId);
      const project = window.getCurrentProject();
      window.startProgressWatch(projectId, project?.name || projectId);
      window.toast('Tagging avviato — controlla il widget ⚙ in basso', 'success');
      // Aggiorna lo stato nella card ogni 4s finché ci sono pending
      const poll = setInterval(async () => {
        await loadTaggingStatus(projectId);
        const s = await window.api.getTaggingStatus(projectId);
        if ((s.pending || 0) === 0) { clearInterval(poll); btn.disabled = false; btn.innerHTML = '▶ Avvia Tagging LLM'; }
      }, 4000);
    } catch (e) {
      window.toast('Errore: ' + e.message, 'error');
      btn.disabled = false;
      btn.innerHTML = '▶ Avvia Tagging LLM';
    }
  });
};

function setupUpload(projectId) {
  const zone = document.getElementById('uploadZone');
  const fileInput = document.getElementById('fileInput');
  const btnUpload = document.getElementById('btnUpload');
  let selectedFile = null;

  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });

  function setFile(f) {
    selectedFile = f;
    zone.querySelector('.upload-zone-text').innerHTML = `<strong>${f.name}</strong><br><small>${(f.size/1024).toFixed(1)} KB</small>`;
    btnUpload.disabled = false;
  }

  btnUpload.addEventListener('click', async () => {
    if (!selectedFile) return;
    const fd = new FormData();
    fd.append('file', selectedFile);
    fd.append('docType', document.getElementById('docType').value);
    btnUpload.disabled = true;
    btnUpload.innerHTML = '<span class="spinner"></span> Caricamento…';
    try {
      const result = await window.api.uploadDocument(projectId, fd);
      window.toast(`Caricato: ${result.filename} (${result.resourceCount} risorse)`, 'success');
      selectedFile = null;
      zone.querySelector('.upload-zone-text').innerHTML = 'Trascina qui o clicca per selezionare<br><small>JSON, CSV, PDF, DOCX, XLSX, TXT — max 50 MB</small>';
      fileInput.value = '';
      await loadDocuments(projectId);
      await loadTaggingStatus(projectId);
    } catch (e) {
      window.toast('Errore upload: ' + e.message, 'error');
    } finally {
      btnUpload.disabled = false;
      btnUpload.innerHTML = 'Carica';
    }
  });
}

async function loadDocuments(projectId) {
  const el = document.getElementById('docList');
  try {
    const docs = await window.api.getDocuments(projectId);
    if (!docs.length) { el.innerHTML = `<div class="text-muted">Nessun documento ancora.</div>`; return; }
    const icons = { resource_export: '📊', guideline: '📋', assessment: '🔍' };
    el.innerHTML = docs.map(d => `
      <div class="doc-item">
        <div class="doc-icon">${icons[d.type] || '📄'}</div>
        <div class="doc-info">
          <div class="doc-name">${d.filename}</div>
          <div class="doc-meta">
            <span class="doc-type-badge doc-type-${d.type}">${d.type}</span>
            ${d.resourceCount ? `&nbsp;· ${d.resourceCount} risorse` : ''}
          </div>
        </div>
        <button class="btn-icon" data-id="${d.id}" title="Elimina">🗑</button>
      </div>`).join('');
    el.querySelectorAll('[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await window.api.deleteDocument(projectId, btn.dataset.id);
        window.toast('Documento eliminato', 'success');
        await loadDocuments(projectId);
      });
    });
  } catch (e) {
    el.innerHTML = `<div style="color:var(--danger)">Errore: ${e.message}</div>`;
  }
}

async function loadTaggingStatus(projectId) {
  const el = document.getElementById('taggingStatus');
  try {
    const s = await window.api.getTaggingStatus(projectId);
    const total = Object.values(s).reduce((a, b) => a + b, 0);
    const pct = total ? Math.round(((s.tagged||0) + (s.confirmed||0)) / total * 100) : 0;
    el.innerHTML = `
      <div class="stats-bar" style="margin-bottom:12px">
        ${statusChip('pending',   s.pending   || 0, '#8b949e')}
        ${statusChip('tagged',    s.tagged    || 0, '#58a6ff')}
        ${statusChip('uncertain', s.uncertain || 0, '#d29922')}
        ${statusChip('confirmed', s.confirmed || 0, '#3fb950')}
      </div>
      <div class="text-muted" style="font-size:.8rem;margin-bottom:6px">${pct}% taggato (${total} risorse totali)</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
  } catch { el.innerHTML = '<div class="text-muted">Non disponibile</div>'; }
}

function statusChip(label, count, color) {
  return `<span class="stat-chip"><span class="dot" style="background:${color}"></span>${label}: <strong>${count}</strong></span>`;
}
