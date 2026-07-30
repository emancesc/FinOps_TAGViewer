// View: Strategie di Tagging

const CINECA_TAG_COLUMNS = [
  'Tag:cineca:BusinessUnit',
  'Tag:cineca:Environment',
  'Tag:cineca:Application',
  'Tag:cineca:ManagedBy',
  'Tag:cineca:Project',
  'Tag:cineca:Owner',
  'Tag:cineca:CostCenter',
  'Tag:cineca:Service',
  'Tag:cineca:Tier',
  'Tag:cineca:DataClassification',
];

window.renderStrategies = async function(projectId) {
  const el = document.getElementById('viewStrategies');

  el.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Strategie di Tagging</h1>
      <div class="page-actions">
        <button class="btn-primary" id="btnApplyStrategies">▶ Applica Strategie</button>
      </div>
    </div>

    <div id="applyResult" style="display:none;margin-bottom:0" class="card"></div>

    <div class="card">
      <div class="card-title">Nuova Strategia</div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr">
        <div class="form-group">
          <label class="form-label">Nome *</label>
          <input type="text" class="form-input" id="stName" placeholder="es. EC2 → Terraform">
        </div>
        <div class="form-group">
          <label class="form-label">Campo condizione</label>
          <select class="form-select" id="stField">
            <option value="resourceType">Tipo risorsa (resourceType)</option>
            <option value="service">Servizio (service)</option>
            <option value="region">Regione (region)</option>
            <option value="name">Nome (name)</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Operatore</label>
          <select class="form-select" id="stOp">
            <option value="equals">è uguale a</option>
            <option value="contains">contiene</option>
            <option value="startsWith">inizia con</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Valore condizione *</label>
          <input type="text" class="form-input" id="stCondVal" placeholder="es. AWS::EC2::Instance">
        </div>
        <div class="form-group">
          <label class="form-label">Colonna tag da impostare</label>
          <select class="form-select" id="stTagCol">
            ${CINECA_TAG_COLUMNS.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Valore tag *</label>
          <input type="text" class="form-input" id="stTagVal" placeholder="es. Terraform">
        </div>
      </div>
      <div style="margin-top:14px">
        <button class="btn-primary" id="btnSaveStrategy">+ Salva Strategia</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Strategie Esistenti</div>
      <div id="strategiesList"></div>
    </div>`;

  await _refreshList(projectId);

  document.getElementById('btnSaveStrategy').addEventListener('click', async () => {
    const name       = document.getElementById('stName').value.trim();
    const conditionField = document.getElementById('stField').value;
    const conditionOp    = document.getElementById('stOp').value;
    const conditionValue = document.getElementById('stCondVal').value.trim();
    const tagColumn      = document.getElementById('stTagCol').value;
    const tagValue       = document.getElementById('stTagVal').value.trim();

    if (!name || !conditionValue || !tagValue) {
      window.toast('Compila tutti i campi obbligatori (*)', 'error');
      return;
    }
    try {
      await window.api.createStrategy(projectId, {
        name, conditionField, conditionOp, conditionValue, tagColumn, tagValue,
      });
      window.toast('Strategia salvata', 'success');
      document.getElementById('stName').value    = '';
      document.getElementById('stCondVal').value = '';
      document.getElementById('stTagVal').value  = '';
      await _refreshList(projectId);
    } catch (e) {
      window.toast('Errore: ' + e.message, 'error');
    }
  });

  document.getElementById('btnApplyStrategies').addEventListener('click', async () => {
    const btn = document.getElementById('btnApplyStrategies');
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const result = await window.api.applyStrategies(projectId);
      const resultEl = document.getElementById('applyResult');
      resultEl.style.display = '';
      resultEl.innerHTML = `<span style="color:var(--accent2)">Strategie applicate: <strong>${result.updated}</strong> ${result.updated === 1 ? 'risorsa aggiornata' : 'risorse aggiornate'}.</span>`;
      window.toast(`${result.updated} risorse aggiornate`, 'success');
    } catch (e) {
      window.toast('Errore: ' + e.message, 'error');
    } finally {
      const b = document.getElementById('btnApplyStrategies');
      if (b) { b.disabled = false; b.textContent = '▶ Applica Strategie'; }
    }
  });
};

async function _refreshList(projectId) {
  const container = document.getElementById('strategiesList');
  if (!container) return;

  try {
    const strategies = await window.api.getStrategies(projectId);
    if (!strategies.length) {
      container.innerHTML = '<div style="font-size:.85rem;color:var(--text-muted);padding:4px 0">Nessuna strategia definita.</div>';
      return;
    }

    container.innerHTML = strategies.map(s => `
      <div class="strategy-card" data-id="${s.id}">
        <div class="strategy-rule">
          <strong>${_esc(s.name)}</strong>
          <div class="strategy-condition">
            Se <code>${_esc(s.conditionField)}</code> ${_opLabel(s.conditionOp)}
            <code>${_esc(s.conditionValue)}</code>
            → imposta <code>${_esc(s.tagColumn)}</code> = <strong>${_esc(s.tagValue)}</strong>
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-size:.8rem;cursor:pointer;white-space:nowrap">
          <input type="checkbox" class="st-toggle" data-id="${s.id}" ${s.enabled ? 'checked' : ''}>
          Attiva
        </label>
        <button class="btn-danger btn-icon st-delete" data-id="${s.id}"
          style="font-size:.8rem;padding:4px 8px;flex-shrink:0">✕</button>
      </div>
    `).join('');

    container.querySelectorAll('.st-toggle').forEach(cb => {
      cb.addEventListener('change', async () => {
        try {
          await window.api.updateStrategy(projectId, cb.dataset.id, { enabled: cb.checked });
        } catch (e) {
          window.toast('Errore: ' + e.message, 'error');
          cb.checked = !cb.checked;
        }
      });
    });

    container.querySelectorAll('.st-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Eliminare questa strategia?')) return;
        try {
          await window.api.deleteStrategy(projectId, btn.dataset.id);
          await _refreshList(projectId);
        } catch (e) {
          window.toast('Errore: ' + e.message, 'error');
        }
      });
    });
  } catch (e) {
    container.innerHTML = `<div style="color:var(--danger);font-size:.85rem">Errore caricamento: ${e.message}</div>`;
  }
}

function _opLabel(op) {
  return { equals: '=', contains: 'contiene', startsWith: 'inizia con' }[op] || op;
}

function _esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
