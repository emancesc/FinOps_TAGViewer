// Task Progress Widget — mostra avanzamento tagging in background via SSE
const _activeSources = new Map(); // projectId → EventSource

// Crea la struttura DOM del widget (inserita in index.html)
(function initWidget() {
  const fab = document.createElement('button');
  fab.id = 'taskFab';
  fab.className = 'task-fab hidden';
  fab.title = 'Task in corso';
  fab.innerHTML = '<span class="task-fab-spinner"></span><span id="taskFabLabel">0</span>';
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.id = 'taskPanel';
  panel.className = 'task-panel hidden';
  panel.innerHTML = `
    <div class="task-panel-header">
      <span>⚙ Task in background</span>
      <button id="taskPanelClose" class="btn-icon">✕</button>
    </div>
    <div id="taskPanelBody" class="task-panel-body"></div>`;
  document.body.appendChild(panel);

  fab.addEventListener('click', () => {
    panel.classList.toggle('hidden');
    fab.classList.toggle('open');
  });
  document.getElementById('taskPanelClose').addEventListener('click', () => {
    panel.classList.add('hidden');
    fab.classList.remove('open');
  });
})();

// ---------------------------------------------------------------------------
// API pubblica
// ---------------------------------------------------------------------------
window.startProgressWatch = function(projectId, projectName, sseUrl) {
  if (_activeSources.has(projectId)) return; // già in ascolto

  showFab();
  addJobCard(projectId, projectName);

  const es = new EventSource(sseUrl || `/api/tagging/${projectId}/progress`);
  _activeSources.set(projectId, es);

  es.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    updateJobCard(projectId, projectName, data);

    if (data.status === 'done' || data.status === 'done_with_errors' || data.status === 'error') {
      es.close();
      _activeSources.delete(projectId);
      if (_activeSources.size === 0) scheduleHideFab();
    }
  };

  es.onerror = () => {
    updateJobCard(projectId, projectName, { status: 'error', errors: ['Connessione SSE persa'] });
    es.close();
    _activeSources.delete(projectId);
    if (_activeSources.size === 0) scheduleHideFab();
  };
};

// ---------------------------------------------------------------------------
// Helpers UI
// ---------------------------------------------------------------------------
function showFab() {
  const fab = document.getElementById('taskFab');
  fab.classList.remove('hidden');
  document.getElementById('taskPanel').classList.remove('hidden');
  document.getElementById('taskFab').classList.add('open');
}

function scheduleHideFab() {
  setTimeout(() => {
    if (_activeSources.size === 0) {
      document.getElementById('taskFab').classList.add('hidden');
      document.getElementById('taskFab').classList.remove('open');
    }
  }, 8000);
}

function addJobCard(projectId, projectName) {
  const body = document.getElementById('taskPanelBody');
  const card = document.createElement('div');
  card.className = 'task-card';
  card.id = `task-${projectId}`;
  card.innerHTML = jobCardHtml(projectId, projectName, { status: 'running', processed: 0, total: 0 });
  body.prepend(card);
  updateFabCount();
}

function updateJobCard(projectId, projectName, data) {
  const card = document.getElementById(`task-${projectId}`);
  if (!card) return;
  card.innerHTML = jobCardHtml(projectId, projectName, data);
  attachTaskHandlers(card, projectId);
  updateFabCount();
}

function attachTaskHandlers(card, projectId) {
  const pauseBtn = card.querySelector('.task-pause-btn');
  if (pauseBtn) pauseBtn.addEventListener('click', async () => {
    pauseBtn.disabled = true;
    await window.api.pauseXlsxTagging(projectId).catch(() => {});
  });
  const resumeBtn = card.querySelector('.task-resume-btn');
  if (resumeBtn) resumeBtn.addEventListener('click', async () => {
    resumeBtn.disabled = true;
    await window.api.resumeXlsxTagging(projectId).catch(() => {});
  });
}

function updateFabCount() {
  const running = document.querySelectorAll('.task-card:not(.done)').length;
  document.getElementById('taskFabLabel').textContent = running;
}

function formatEta(ms) {
  if (!ms || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 10) return '< 10 sec';
  if (s < 60) return `~${s} sec`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `~${m}m ${rem}s` : `~${m} min`;
}

function jobCardHtml(projectId, projectName, d) {
  const pct = d.total > 0 ? Math.round(d.processed / d.total * 100) : 0;
  const elapsed = d.startedAt ? Math.round((Date.now() - d.startedAt) / 1000) : 0;
  const eta = formatEta(d.etaMs);

  const statusIcon = {
    running: '<span class="task-spinner"></span>',
    paused: '⏸',
    done: '✅',
    done_with_errors: '⚠',
    error: '❌',
    idle: '○',
  }[d.status] || '⏳';

  const statusColor = {
    running: 'var(--accent)',
    paused: 'var(--warn)',
    done: 'var(--accent2)',
    done_with_errors: 'var(--warn)',
    error: 'var(--danger)',
  }[d.status] || 'var(--text-muted)';

  const doneClass = (d.status === 'done' || d.status === 'done_with_errors' || d.status === 'error') ? 'done' : '';
  const isActive = d.status === 'running' || d.status === 'paused';

  return `
    <div class="task-card-inner ${doneClass}">
      <div class="task-card-title">
        ${statusIcon}
        <span style="flex:1;font-weight:600">${projectName}</span>
        <span style="color:${statusColor};font-size:.75rem">${d.status || 'avvio…'}</span>
      </div>

      ${isActive ? `
        <div style="font-size:.78rem;color:var(--text-muted);margin:4px 0">
          Batch ${d.batch || 0}/${d.batchTotal || '?'} — ${d.processed || 0}/${d.total} risorse
          ${d.workers > 1 ? `<span style="color:var(--accent);margin-left:6px">⚡ ${d.workers} worker paralleli</span>` : ''}
          ${d.currentNames?.length ? `<br><span style="opacity:.7">▸ ${d.currentNames.join(', ')}</span>` : ''}
        </div>
        <div class="task-progress-bar">
          <div class="task-progress-fill" style="width:${pct}%"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">
          <span style="font-size:.72rem;color:var(--text-muted)">
            ${pct}% · ${elapsed}s trascorsi
            ${eta ? ` · ETA: <strong>${eta}</strong>` : ''}
          </span>
          ${d.status === 'running'
            ? `<button class="task-pause-btn" style="font-size:.7rem;padding:2px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text);cursor:pointer">⏸ Pausa</button>`
            : `<button class="task-resume-btn" style="font-size:.7rem;padding:2px 8px;background:var(--accent);border:none;border-radius:4px;color:#fff;cursor:pointer">▶ Riprendi</button>`
          }
        </div>
      ` : ''}

      ${d.status === 'done' ? `
        <div style="font-size:.8rem;color:var(--accent2);margin-top:4px">
          ✓ ${d.total} risorse taggate in ${Math.round((d.endedAt - d.startedAt)/1000)}s
        </div>
      ` : ''}

      ${d.status === 'done_with_errors' ? `
        <div style="font-size:.8rem;color:var(--warn);margin-top:4px">
          ${d.processed}/${d.total} taggate — ${d.errors?.length} batch falliti
        </div>
      ` : ''}

      ${d.errors?.length > 0 ? `
        <details style="margin-top:6px">
          <summary style="font-size:.75rem;color:var(--danger);cursor:pointer">
            ${d.errors.length} errore/i
          </summary>
          <div style="font-size:.72rem;color:var(--danger);margin-top:4px;max-height:120px;overflow-y:auto">
            ${d.errors.map(e => `<div style="margin:2px 0;opacity:.85">• ${e}</div>`).join('')}
          </div>
        </details>
      ` : ''}
    </div>`;
}
