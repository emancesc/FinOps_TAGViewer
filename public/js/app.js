// SPA router — manages active view and current project
const views = {
  projects: document.getElementById('viewProjects'),
  upload:   document.getElementById('viewUpload'),
  graph:    document.getElementById('viewGraph'),
  export:   document.getElementById('viewExport'),
};
const navItems = document.querySelectorAll('.nav-item');

let _currentProject = null;

function navigate(viewName) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('active', k === viewName));
  navItems.forEach(li => li.classList.toggle('active', li.dataset.view === viewName));

  if (viewName === 'graph'  && _currentProject) window.renderGraph(_currentProject.id);
  if (viewName === 'upload' && _currentProject) window.renderUpload(_currentProject.id);
  if (viewName === 'export' && _currentProject) window.renderExport(_currentProject.id);
}

navItems.forEach(li => {
  if (!li.classList.contains('disabled')) {
    li.addEventListener('click', () => navigate(li.dataset.view));
  }
});

window.setCurrentProject = function(project) {
  _currentProject = project;

  // Unlock nav items
  ['upload','graph','export'].forEach(v => {
    document.querySelector(`.nav-item[data-view="${v}"]`).classList.remove('disabled');
  });

  document.getElementById('sidebarProject').style.display = '';
  document.getElementById('sidebarProjectName').textContent = project.name;
  document.getElementById('sidebarProjectStats').textContent =
    `Account: ${project.accountId}`;

  document.getElementById('chatToggle').classList.remove('hidden');

  window.initChat(project.id);
  navigate('upload');
};

window.getCurrentProject = () => _currentProject;

// Initial render
window.renderProjects();
