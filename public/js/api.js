// Thin fetch wrapper — available globally as window.api
const BASE = '';

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function del(path) {
  const res = await fetch(BASE + path, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function upload(path, formData) {
  const res = await fetch(BASE + path, { method: 'POST', body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

window.api = {
  // Projects
  getProjects:       ()        => req('GET',    '/api/projects'),
  getProject:        (id)      => req('GET',    `/api/projects/${id}`),
  createProject:     (data)    => req('POST',   '/api/projects', data),
  updateProject:     (id, d)   => req('PATCH',  `/api/projects/${id}`, d),
  deleteProject:     (id)      => req('DELETE', `/api/projects/${id}`),

  // Documents
  getDocuments:      (pid)     => req('GET',    `/api/documents/${pid}`),
  deleteDocument:    (pid, id) => req('DELETE', `/api/documents/${pid}/${id}`),
  uploadDocument:    (pid, fd) => upload(`/api/documents/${pid}`, fd),

  // Graph
  getGraph:          (pid, q)  => req('GET',    `/api/graph/${pid}?${new URLSearchParams(q || {})}`),
  getGraphStats:     (pid)     => req('GET',    `/api/graph/${pid}/stats`),
  updateResource:    (pid, rid, d) => req('PATCH', `/api/graph/${pid}/resource/${rid}`, d),

  // Tagging
  runTagging:        (pid)     => req('POST',   `/api/tagging/${pid}/run`),
  getTaggingStatus:  (pid)     => req('GET',    `/api/tagging/${pid}/status`),
  retagResource:     (pid, rid, guidance) => req('POST', `/api/tagging/${pid}/resource/${rid}`, { guidance }),
  confirmTags:       (pid, rid, tags)     => req('PATCH', `/api/tagging/${pid}/resource/${rid}/confirm`, { tags }),

  // XLSX Tagging
  detectColumns:     (pid, storedAs) => req('POST', `/api/tagging/${pid}/detect-columns`, { storedAs }),
  saveColumnConfig:  (pid, data) => fetch(`/api/projects/${pid}/column-config`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }).then(r => r.json()),
  runXlsxTagging:    (pid)     => req('POST', `/api/tagging/${pid}/run-xlsx`, {}),
  getXlsxProgress:   (pid)     => `/api/tagging/${pid}/progress-xlsx`,
  getXlsxResultUrl:  (pid)     => `/api/tagging/${pid}/result-xlsx`,

  // Export
  getXlsxUrl:        (pid)     => `/api/export/${pid}/xlsx`,
  getSummaryUrl:     (pid)     => `/api/export/${pid}/summary`,

  // Auth Azure
  startAzureAuth:    ()        => req('POST',   '/api/auth/azure/start'),
  getAzureAuthStatus:()        => req('GET',    '/api/auth/azure/status'),

  // Strategies
  getStrategies:   (pid)              => req('GET',   `/api/strategies/${pid}`),
  createStrategy:  (pid, strategy)    => req('POST',  `/api/strategies/${pid}`, strategy),
  updateStrategy:  (pid, sid, data)   => req('PATCH', `/api/strategies/${pid}/${sid}`, data),
  deleteStrategy:  (pid, sid)         => del(`/api/strategies/${pid}/${sid}`),
  applyStrategies: (pid)              => req('POST',  `/api/strategies/${pid}/apply`, {}),
};

// Toast helper
window.toast = function(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3500);
};
