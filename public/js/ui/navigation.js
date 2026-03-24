// ===== SIDEBAR & ROUTING =====
function showPage(page) {
  // Update URL hash
  window.location.hash = page;

  // Hide all pages
  document.querySelectorAll('.page-container').forEach(function(p) { p.classList.remove('active'); });

  // Show target page
  var target = document.getElementById('page-' + page);
  if (target) target.classList.add('active');

  // Update sidebar active state
  document.querySelectorAll('.nav-item[data-page]').forEach(function(item) {
    item.classList.toggle('active', item.dataset.page === page);
  });

  // Close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('active');

  // Initialize page data on first visit
  if (page === 'calendar' && !calendarInitialized) {
    calendarInitialized = true;
    calendarToday();
  }
  if (page === 'patients' && !patientsInitialized) {
    patientsInitialized = true;
    loadPatients(1);
  }
  if (page === 'dashboard') {
    loadCallStats();
    loadCallHistory();
    if (typeof loadDashCharts === 'function') loadDashCharts();
  }
  if (page === 'whatsapp') {
    loadWaStats();
    loadWaConversations();
  }
  if (page === 'agents') {
    loadAgents();
  }
}

function toggleSidebar() {
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebarOverlay');
  sidebar.classList.toggle('open');
  overlay.classList.toggle('active');
}

// Hash-based routing
function handleRoute() {
  var hash = window.location.hash.replace('#', '') || 'dashboard';
  var validPages = ['dashboard', 'calendar', 'patients', 'whatsapp', 'agents'];
  showPage(validPages.includes(hash) ? hash : 'dashboard');
}

window.addEventListener('hashchange', handleRoute);
