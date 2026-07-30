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
              <option value="tagging_target">Estrazione AWS da Taggare (XLSX target)</option>
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

  // Load project to set up button and optional config panel
  let project = null;
  try { project = await window.api.getProject(projectId); } catch (_) {}

  setupTaggingButton(projectId, project);

  if (project?.taggingTargetFile) {
    try {
      const detection = await window.api.detectColumns(projectId, project.taggingTargetFile);
      renderColumnConfigPanel(projectId, detection, project.taggingTargetFile, project);
    } catch (e) {
      console.warn('[upload] detectColumns on load failed:', e.message);
      renderColumnConfigPanel(projectId, null, project.taggingTargetFile, project);
    }
  }
};

// ---------------------------------------------------------------------------
// Page-level tagging button
// ---------------------------------------------------------------------------
function setupTaggingButton(projectId, project) {
  const btn = document.getElementById('btnRunTagging');
  if (!btn) return;

  if (project?.taggingTargetFile) {
    btn.textContent = '▶ Avvia Tagging XLSX';
    btn.onclick = async () => {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Avvio…';
      try {
        await window.api.runXlsxTagging(projectId);
        const proj = window.getCurrentProject();
        const sseUrl = window.api.getXlsxProgress(projectId);
        window.startProgressWatch(projectId, proj?.name || projectId, sseUrl);
        window.toast('Tagging XLSX avviato — controlla il widget ⚙ in basso', 'success');
      } catch (e) {
        window.toast('Errore: ' + e.message, 'error');
        btn.disabled = false;
        btn.innerHTML = '▶ Avvia Tagging XLSX';
      }
    };
  } else {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Avvio…';
      try {
        await window.api.runTagging(projectId);
        const proj = window.getCurrentProject();
        window.startProgressWatch(projectId, proj?.name || projectId);
        window.toast('Tagging avviato — controlla il widget ⚙ in basso', 'success');
        const poll = setInterval(async () => {
          await loadTaggingStatus(projectId);
          const s = await window.api.getTaggingStatus(projectId);
          if ((s.pending || 0) === 0) {
            clearInterval(poll);
            btn.disabled = false;
            btn.innerHTML = '▶ Avvia Tagging LLM';
          }
        }, 4000);
      } catch (e) {
        window.toast('Errore: ' + e.message, 'error');
        btn.disabled = false;
        btn.innerHTML = '▶ Avvia Tagging LLM';
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Upload zone
// ---------------------------------------------------------------------------
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
    const docType = document.getElementById('docType').value;
    fd.append('docType', docType);
    btnUpload.disabled = true;
    btnUpload.innerHTML = '<span class="spinner"></span> Caricamento…';
    try {
      const result = await window.api.uploadDocument(projectId, fd);
      const countPart = result.resourceCount ? ` (${result.resourceCount} risorse)` : '';
      window.toast(`Caricato: ${result.filename}${countPart}`, 'success');
      selectedFile = null;
      zone.querySelector('.upload-zone-text').innerHTML = 'Trascina qui o clicca per selezionare<br><small>JSON, CSV, PDF, DOCX, XLSX, TXT — max 50 MB</small>';
      fileInput.value = '';

      // After tagging_target upload: re-render the whole view so the
      // button gets the correct XLSX click handler (not just the text)
      if (docType === 'tagging_target' && result.storedAs) {
        await window.renderUpload(projectId);
        return; // renderUpload calls loadDocuments/loadTaggingStatus internally
      }

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

// ---------------------------------------------------------------------------
// Column configuration panel
// ---------------------------------------------------------------------------
const DEFAULT_PROMPT = `Sei un esperto FinOps AWS per CINECA. Hai accesso ai seguenti documenti di contesto:

{{context_documents}}

STRATEGIA DI TAGGING E COLONNE DA VALORIZZARE:
{{tag_columns_list}}

Analizza ogni risorsa AWS e valorizza TUTTI i tag cineca: secondo la strategia.
- Usa "[?]" per valori incerti e spiega le opzioni nella colonna _note corrispondente
- Non considerare affidabili i tag non-cineca già presenti nelle risorse
- Per ogni tag valorizza anche la colonna _note con una breve spiegazione della scelta

RISORSE DA TAGGARE:
{{resources_json}}

Restituisci SOLO un array JSON (nessun testo prima o dopo):
[{"rowNumber": <N>, "tags": {"Tag:cineca:NomeTag": "valore", "cineca:NomeTag_note": "motivazione", ...}}, ...]`;

function renderColumnConfigPanel(projectId, detection, taggingTargetFile, savedProject) {
  const el = document.getElementById('viewUpload');

  // Remove existing panel
  const existing = document.getElementById('columnConfigPanel');
  if (existing) existing.remove();

  const savedConfig = savedProject?.columnConfig || {};
  const sugg = detection?.suggestedConfig || {};

  // Merge saved over suggested
  const sheetName = savedConfig.sheetName || sugg.sheetName || '';
  const taggableColumn = savedConfig.taggableColumn || sugg.taggableColumn || 'Taggable';
  const taggableValue = savedConfig.taggableValue || sugg.taggableValue || 'Y';
  const parallelWorkers = savedConfig.parallelWorkers || 1;

  const allHeaders = detection?.allHeaders || [];
  const sheets = detection?.sheets || (sheetName ? [sheetName] : []);
  const taggableCount = detection?.taggableCount;

  // Compute column groups from headers
  const tagColsAll = allHeaders.filter(h => /^Tag:cineca:/i.test(h));
  const noteColsAll = allHeaders.filter(h => /^cineca:.+_note$/i.test(h));
  const identColsAll = allHeaders.filter(h => /^(Identifier|ARN|Arn|ResourceARN)$/i.test(h));

  const identifierColumns = savedConfig.identifierColumns?.length
    ? savedConfig.identifierColumns
    : (sugg.identifierColumns?.length ? sugg.identifierColumns : identColsAll);

  const savedTagCols = savedConfig.tagColumns?.length ? savedConfig.tagColumns : (sugg.tagColumns || tagColsAll);
  const savedNoteCols = savedConfig.noteColumns?.length ? savedConfig.noteColumns : (sugg.noteColumns || noteColsAll);
  const savedContextCols = savedConfig.contextColumns?.length ? savedConfig.contextColumns : (sugg.contextColumns || []);

  // Context candidates: everything except tag, note, identifier, taggable
  const contextCandidates = allHeaders.filter(h =>
    !/^Tag:cineca:/i.test(h) &&
    !/^cineca:.+_note$/i.test(h) &&
    !identColsAll.includes(h) &&
    h.toLowerCase() !== taggableColumn.toLowerCase()
  );

  const promptValue = savedProject?.promptTemplate || DEFAULT_PROMPT;

  // Build HTML parts
  const sheetOptions = sheets.map(s =>
    `<option value="${escH(s)}" ${s === sheetName ? 'selected' : ''}>${escH(s)}</option>`
  ).join('') || `<option value="${escH(sheetName)}">${escH(sheetName)}</option>`;

  const contextCheckboxesHtml = contextCandidates.length
    ? contextCandidates.map(h => {
        const checked = savedContextCols.includes(h) ? 'checked' : '';
        return `<label><input type="checkbox" class="ctx-col-cb" value="${escH(h)}" ${checked}> ${escH(h)}</label>`;
      }).join('')
    : '<span style="color:var(--text-muted);font-size:.8rem">Nessuna colonna rilevata</span>';

  const tagCheckboxesHtml = (tagColsAll.length ? tagColsAll : savedTagCols).length
    ? (tagColsAll.length ? tagColsAll : savedTagCols).map(h => {
        const checked = savedTagCols.includes(h) ? 'checked' : '';
        return `<label><input type="checkbox" class="tag-col-cb" value="${escH(h)}" ${checked}> ${escH(h)}</label>`;
      }).join('')
    : '<span style="color:var(--text-muted);font-size:.8rem">Nessuna colonna Tag:cineca: rilevata</span>';

  const noteColsDisplay = (noteColsAll.length ? noteColsAll : savedNoteCols)
    .map(h => `<span style="margin-right:10px">• ${escH(h)}</span>`).join('') || 'Nessuna';

  const taggableCountHtml = taggableCount !== undefined
    ? `<div id="cfgTaggableCount" style="color:var(--text-muted);font-size:.85rem">Righe taggabili: <strong>${taggableCount}</strong></div>`
    : '';

  const panel = document.createElement('div');
  panel.className = 'card';
  panel.id = 'columnConfigPanel';
  panel.innerHTML = `
    <div class="card-title">Configurazione Colonne — <span id="configSheetName">${escH(sheetName)}</span></div>

    <div class="form-group">
      <label class="form-label">Sheet</label>
      <select class="form-select" id="cfgSheet">${sheetOptions}</select>
    </div>

    <div class="form-group" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
      <div>
        <label class="form-label">Colonna filtro (es. Taggable)</label>
        <input type="text" class="form-input" id="cfgTaggableCol" value="${escH(taggableColumn)}">
      </div>
      <div>
        <label class="form-label">Valore da taggare</label>
        <input type="text" class="form-input" id="cfgTaggableVal" value="${escH(taggableValue)}">
      </div>
      <div>
        <label class="form-label">Worker paralleli (1–5)</label>
        <input type="number" class="form-input" id="cfgParallelWorkers" min="1" max="5" value="${parallelWorkers}">
        <small style="color:var(--text-muted)">Segmenti disgiunti in parallelo</small>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Colonne contesto (inviate all'LLM come info sulla risorsa)</label>
      <div id="cfgContextCols" class="checkbox-grid">${contextCheckboxesHtml}</div>
    </div>

    <div class="form-group">
      <label class="form-label">Colonne tag da valorizzare</label>
      <div id="cfgTagCols" class="checkbox-grid">${tagCheckboxesHtml}</div>
    </div>

    <div class="form-group">
      <label class="form-label">Colonne note (auto-rilevate da _note suffix)</label>
      <div id="cfgNoteCols" style="font-size:.8rem;color:var(--text-muted)">${noteColsDisplay}</div>
    </div>

    <div class="form-group">
      <label class="form-label">Prompt template LLM</label>
      <small style="color:var(--text-muted)">Placeholder disponibili: {{context_documents}}, {{tag_columns_list}}, {{resources_json}}</small>
      <textarea id="cfgPromptTemplate" rows="8" style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:var(--radius);padding:10px;font-size:.82rem;font-family:monospace;resize:vertical">${escH(promptValue)}</textarea>
    </div>

    ${taggableCountHtml}

    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="btn-primary" id="btnSaveConfig">💾 Salva Configurazione</button>
      <button class="btn-primary" id="btnRunXlsxTagging" style="background:var(--accent2)">▶ Avvia Tagging XLSX</button>
    </div>`;

  el.appendChild(panel);

  // Capture note cols for the save handler closure
  const noteColsForSave = noteColsAll.length ? noteColsAll : savedNoteCols;

  document.getElementById('btnSaveConfig').addEventListener('click', async () => {
    const columnConfig = {
      sheetName: document.getElementById('cfgSheet').value,
      taggableColumn: document.getElementById('cfgTaggableCol').value,
      taggableValue: document.getElementById('cfgTaggableVal').value,
      parallelWorkers: Math.max(1, Math.min(5, parseInt(document.getElementById('cfgParallelWorkers').value, 10) || 1)),
      identifierColumns,
      contextColumns: [...document.querySelectorAll('#cfgContextCols .ctx-col-cb:checked')].map(c => c.value),
      tagColumns: [...document.querySelectorAll('#cfgTagCols .tag-col-cb:checked')].map(c => c.value),
      noteColumns: (() => {
        const selectedTags = [...document.querySelectorAll('#cfgTagCols .tag-col-cb:checked')].map(c => c.value);
        return selectedTags.map(tc => {
          const tagName = tc.replace(/^Tag:/i, '');
          return noteColsForSave.find(nc => nc.toLowerCase() === `${tagName}_note`.toLowerCase()) || '';
        }).filter(Boolean);
      })(),
    };
    const promptTemplate = document.getElementById('cfgPromptTemplate').value;

    try {
      await window.api.saveColumnConfig(projectId, { columnConfig, promptTemplate, taggingTargetFile });
      window.toast('Configurazione salvata', 'success');
      const btn = document.getElementById('btnRunTagging');
      if (btn) btn.textContent = '▶ Avvia Tagging XLSX';
    } catch (e) {
      window.toast('Errore salvataggio: ' + e.message, 'error');
    }
  });

  document.getElementById('btnRunXlsxTagging').addEventListener('click', async () => {
    const btn2 = document.getElementById('btnRunXlsxTagging');
    btn2.disabled = true;
    btn2.innerHTML = '<span class="spinner"></span> Avvio…';
    try {
      await window.api.runXlsxTagging(projectId);
      const proj = window.getCurrentProject();
      const sseUrl = window.api.getXlsxProgress(projectId);
      window.startProgressWatch(projectId, proj?.name || projectId, sseUrl);
      window.toast('Tagging XLSX avviato — controlla il widget ⚙ in basso', 'success');
    } catch (e) {
      window.toast('Errore: ' + e.message, 'error');
    } finally {
      btn2.disabled = false;
      btn2.innerHTML = '▶ Avvia Tagging XLSX';
    }
  });
}

// ---------------------------------------------------------------------------
// Documents list
// ---------------------------------------------------------------------------
async function loadDocuments(projectId) {
  const el = document.getElementById('docList');
  try {
    const docs = await window.api.getDocuments(projectId);
    if (!docs.length) { el.innerHTML = `<div class="text-muted">Nessun documento ancora.</div>`; return; }
    const icons = { resource_export: '📊', guideline: '📋', assessment: '🔍', tagging_target: '📦' };
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

// ---------------------------------------------------------------------------
// Tagging status
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function escH(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
