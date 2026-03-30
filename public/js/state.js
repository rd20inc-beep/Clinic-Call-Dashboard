// ===== GLOBAL STATE =====
var myUsername = null;
var myRole = null;
var currentPage = 1;
var profileData = null;
var myRooms = [];
var lastHandledCallId = null;
var calendarInitialized = false;
var patientsInitialized = false;
var patientsPage = 1;
var patientsLoading = false;
var searchTimeout = null;
var waPausedChats = new Set();
var waCurrentChatPhone = null;

// DOM element references
var statusDot = document.getElementById('statusDot');
var statusText = document.getElementById('statusText');
var monitorDot = document.getElementById('monitorDot');
var monitorText = document.getElementById('monitorText');
var notification = document.getElementById('notification');
var callerNumberText = document.getElementById('callerNumberText');
var callerWhatsapp = document.getElementById('callerWhatsapp');
var callTime = document.getElementById('callTime');
var cliniceaLink = document.getElementById('cliniceaLink');
var callHistory = document.getElementById('callHistory');
var patientNameBanner = document.getElementById('patientNameBanner');
var profileModal = document.getElementById('profileModal');
var modalBody = document.getElementById('modalBody');
var modalTitle = document.getElementById('modalTitle');
var modalClinicaLink = document.getElementById('modalClinicaLink');
var modalTabs = document.getElementById('modalTabs');
var toastContainer = document.getElementById('errorToastContainer');

var whatsappSvg = '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><path d="M16.004 0h-.008C7.174 0 0 7.176 0 16c0 3.5 1.128 6.744 3.046 9.378L1.054 31.29l6.118-1.962A15.91 15.91 0 0016.004 32C24.826 32 32 24.822 32 16S24.826 0 16.004 0zm9.334 22.594c-.39 1.1-1.932 2.014-3.164 2.28-.844.18-1.946.324-5.66-1.216-4.752-1.97-7.812-6.79-8.046-7.104-.226-.314-1.886-2.512-1.886-4.79s1.194-3.4 1.618-3.866c.424-.466.924-.582 1.232-.582.308 0 .616.002.884.016.284.014.664-.108 1.04.792.39.93 1.326 3.232 1.442 3.466.116.234.194.508.038.82-.156.314-.234.508-.466.784-.232.276-.488.616-.698.826-.232.232-.474.484-.204.95.27.466 1.2 1.98 2.578 3.208 1.772 1.578 3.266 2.068 3.732 2.302.466.234.738.194 1.01-.116.27-.312 1.16-1.35 1.468-1.816.308-.466.616-.39 1.04-.234.424.156 2.692 1.27 3.156 1.5.466.234.774.35.89.54.116.194.116 1.1-.274 2.2z"/></svg>';

// --- AGENT IDENTITY (loaded eagerly to guard socket events) ---
fetch('/api/me').then(function(r) { return r.json(); }).then(function(data) {
  if (data.username) {
    myUsername = data.username;
    myRole = data.role;
    console.log('[Dashboard] Identity loaded:', myUsername, 'role:', myRole);
    // Update agent info display
    var el = document.getElementById('agentInfo');
    if (el) el.textContent = data.role === 'admin' ? 'Admin' : data.username.charAt(0).toUpperCase() + data.username.slice(1);
    // Show admin-only elements
    if (data.role === 'admin') {
      var items = document.querySelectorAll('.admin-only');
      for (var i = 0; i < items.length; i++) {
        items[i].style.display = items[i].dataset.display || '';
      }
    }
  }
}).catch(function() { console.warn('[Dashboard] Failed to load /api/me'); });
