// View: Projects list + create modal
window.renderProjects = async function() {
  const el = document.getElementById('viewProjects');
  el.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Progetti di Tagging</h1>
      <div class="page-actions">
        <button class="btn-primary" id="btnNewProject">+ Nuovo Progetto</button>
      </div>
    </div>
    <div id="projectGrid" class="project-grid">
      <div class="empty-state"><div class="spinner"></div></div>
    </div>`;

  document.getElementById('btnNewProject').addEventListener('click', openCreateModal);
  await loadProjects();
};

async function loadProjects() {
  const grid = document.getElementById('projectGrid');
  try {
    const projects = await window.api.getProjects();
    if (!projects.length) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <div class="empty-state-icon">📁</div>
          <p>Nessun progetto ancora. Creane uno per iniziare.</p>
        </div>`;
      return;
    }
    // Carica stats per ciascun progetto
    const enriched = await Promise.all(projects.map(async p => {
      try {
        const stats = await window.api.getTaggingStatus(p.id);
        return { ...p, stats };
      } catch { return p; }
    }));
    grid.innerHTML = enriched.map(p => projectCard(p)).join('');
    grid.querySelectorAll('.project-card').forEach(card => {
      card.addEventListener('click', () => selectProject(card.dataset.id));
    });
  } catch (e) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;color:var(--danger)">Errore: ${e.message}</div>`;
  }
}

function projectCard(p) {
  const s = p.stats || {};
  const total = Object.values(s).reduce((a, b) => a + b, 0);
  const confirmed = s.confirmed || 0;
  const uncertain = s.uncertain || 0;
  const pct = total ? Math.round(confirmed / total * 100) : 0;
  return `
    <div class="project-card" data-id="${p.id}">
      <div class="project-card-name">${esc(p.name)}</div>
      <div class="project-card-meta">
        <span>Account: <strong>${esc(p.accountId)}</strong></span>
        <span>Regione: ${esc(p.region || '—')}</span>
        <span>LLM: ${esc(p.llmProvider)}</span>
      </div>
      <div class="project-card-footer">
        <span class="badge badge-confirmed">${confirmed} confermati</span>
        <span class="badge badge-uncertain">${uncertain} incerti</span>
      </div>
      ${total ? `
        <div class="progress-bar mt-4">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="text-muted" style="font-size:.75rem;margin-top:4px">${pct}% taggato (${total} totali)</div>
      ` : ''}
    </div>`;
}

async function selectProject(id) {
  try {
    const project = await window.api.getProject(id);
    window.setCurrentProject(project);
  } catch (e) {
    window.toast('Errore apertura progetto: ' + e.message, 'error');
  }
}

function openCreateModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Nuovo Progetto di Tagging</div>
      <div class="flex-col">
        <div class="form-group">
          <label class="form-label">Nome progetto *</label>
          <input class="form-input" id="mName" placeholder="es. Prod - Account CINECA">
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">Account AWS ID *</label>
            <input class="form-input" id="mAccount" placeholder="123456789012">
          </div>
          <div class="form-group">
            <label class="form-label">Regione principale</label>
            <input class="form-input" id="mRegion" placeholder="eu-west-1">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">LLM provider</label>
          <select class="form-select" id="mLlm">
            <option value="claude">Claude (Anthropic)</option>
            <option value="azure-openai">Azure OpenAI (SSO / API Key)</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" id="mCancel">Annulla</button>
        <button class="btn-primary" id="mConfirm">Crea Progetto</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#mCancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#mConfirm').addEventListener('click', async () => {
    const name = overlay.querySelector('#mName').value.trim();
    const accountId = overlay.querySelector('#mAccount').value.trim();
    const region = overlay.querySelector('#mRegion').value.trim();
    const llmProvider = overlay.querySelector('#mLlm').value;
    if (!name || !accountId) { window.toast('Nome e Account ID obbligatori', 'error'); return; }
    try {
      await window.api.createProject({ name, accountId, region, llmProvider });
      overlay.remove();
      window.toast('Progetto creato', 'success');
      await loadProjects();
    } catch (e) {
      window.toast('Errore: ' + e.message, 'error');
    }
  });
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
