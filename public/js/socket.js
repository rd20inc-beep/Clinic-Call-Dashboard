// ===== SOCKET.IO CONNECTION =====
var socket = io({ transports: ['websocket'] });

// ===== CONNECTION STATUS =====
socket.on('connect', function() {
  statusDot.classList.add('connected');
  statusText.textContent = 'Connected';
  console.log('[Dashboard] Socket connected. My identity:', myUsername, myRole);
});

// Server confirms which rooms this socket joined
socket.on('join_confirm', function(data) {
  myRooms = data.rooms || [];
  console.log('[Dashboard] Room confirm — user:', data.username, 'role:', data.role, 'rooms:', myRooms.join(', '), 'socketId:', data.socketId);
  if (data.error) {
    console.error('[Dashboard] ROOM JOIN FAILED:', data.error);
    statusText.textContent = 'No Session';
    statusDot.classList.remove('connected');
    // Session is invalid — the socket is connected but receives NO events
    // Force re-login after a short delay
    setTimeout(function() {
      if (confirm('Your session has expired. Click OK to log in again.')) {
        window.location.href = '/login';
      }
    }, 1000);
  } else if (myRooms.length === 0) {
    console.warn('[Dashboard] Connected but joined NO rooms — events will not be received');
    statusText.textContent = 'No Rooms';
  } else {
    statusText.textContent = 'Connected (' + myRooms.join(', ') + ')';
  }
});

socket.on('disconnect', function() {
  statusDot.classList.remove('connected');
  statusText.textContent = 'Disconnected';
  myRooms = [];
});

socket.on('monitor_status', function(data) {
  // STRICT: only update monitor status for events belonging to this agent
  if (!isEventForMe(data)) {
    console.log('[Dashboard] monitor_status REJECTED — event.agent:', data.agent, 'me:', myUsername);
    return;
  }
  console.log('[Dashboard] monitor_status ACCEPTED — event.agent:', data.agent, 'me:', myUsername);
  setMonitorStatus(data.alive);
});

// ===== INCOMING CALL HANDLER =====
socket.on('patient_info', function(data) {
  // STRICT: only process if this event belongs to the logged-in user
  if (!isEventForMe(data)) {
    console.log('[Dashboard] patient_info REJECTED — event.agent:', data.agent, 'me:', myUsername);
    return;
  }
  console.log('[Dashboard] patient_info ACCEPTED — event.agent:', data.agent, 'me:', myUsername);
  if (data.patientName) {
    patientNameBanner.textContent = data.patientName;
    patientNameBanner.style.display = 'block';
  }
  // If server resolved a phone number (from contact name lookup), update the display
  if (data.caller && data.caller.indexOf('contact:') !== 0) {
    callerNumberText.textContent = data.caller;
    callerWhatsapp.href = getWhatsappUrl(data.caller);
  }
  if (data.cliniceaUrl) {
    cliniceaLink.href = data.cliniceaUrl;
  }
  var nameEl = document.getElementById('name-' + data.callId);
  if (nameEl) {
    nameEl.textContent = data.patientName;
    nameEl.className = 'meeting-badge upcoming';
  }
});

socket.on('incoming_call', function(data) {
  console.log('[dashboard] incoming_call RAW received', JSON.stringify(data));
  console.log('[dashboard] identity at receive time', { myUsername: myUsername, myRole: myRole, socketConnected: socket.connected, socketId: socket.id });

  // STRICT OWNERSHIP CHECK: ignore events not belonging to this user
  console.log('[dashboard] ownership check', { eventAgent: data.agent, myUsername: myUsername, myRole: myRole, willPass: myRole === 'admin' || (data.agent && data.agent === myUsername) });
  if (!isEventForMe(data)) {
    console.log('[dashboard] REJECTED by isEventForMe', { eventAgent: data.agent, myUsername: myUsername, myRole: myRole });
    return;
  }
  console.log('[dashboard] ACCEPTED event', { eventAgent: data.agent, myUsername: myUsername, myRole: myRole });

  // Skip if we already handled this exact call
  if (data.callId && data.callId === lastHandledCallId) {
    console.log('[dashboard] SKIPPED — duplicate callId', { callId: data.callId });
    return;
  }
  lastHandledCallId = data.callId;

  patientNameBanner.textContent = '';
  patientNameBanner.style.display = 'none';
  // Strip "contact:" prefix for display — show name cleanly
  var displayCaller = data.caller && data.caller.indexOf('contact:') === 0
    ? data.caller.slice(8)
    : data.caller;
  callerNumberText.textContent = displayCaller;
  callerWhatsapp.href = getWhatsappUrl(data.caller);
  callTime.textContent = 'Received at ' + new Date(data.timestamp).toLocaleTimeString();
  cliniceaLink.href = data.cliniceaUrl;
  notification.classList.add('active');

  playBeep();

  // Auto-open Clinicea profile for any call that passes isEventForMe()
  var shouldAutoOpen = true;
  var lockKey = 'call_opened_' + data.callId;
  console.log('[dashboard] auto-open check', { shouldAutoOpen: shouldAutoOpen, lockKey: lockKey, lockExists: !!localStorage.getItem(lockKey), cliniceaUrl: data.cliniceaUrl });
  if (shouldAutoOpen && !localStorage.getItem(lockKey)) {
    localStorage.setItem(lockKey, '1');
    setTimeout(function() { localStorage.removeItem(lockKey); }, 60000);
    console.log('[dashboard] opening Clinicea', data.cliniceaUrl);
    var win = window.open(data.cliniceaUrl, 'clinicea_patient');
    console.log('[dashboard] window.open result', { success: !!win, blocked: !win || win.closed, url: data.cliniceaUrl });
    // Detect popup blocker — show fallback link if blocked
    if (!win || win.closed) {
      console.warn('[dashboard] Popup BLOCKED! Showing fallback link.');
      cliniceaLink.textContent = '\u26A0 CLICK HERE to open patient profile (popup was blocked)';
      cliniceaLink.style.color = '#e74c3c';
      cliniceaLink.style.fontWeight = 'bold';
      cliniceaLink.style.fontSize = '16px';
    }
  } else {
    console.log('[dashboard] NOT auto-opening', { role: myRole, eventAgent: data.agent, myUsername: myUsername, agentMatch: data.agent === myUsername, untagged: !data.agent, lockExists: !!localStorage.getItem(lockKey) });
  }

  loadCallHistory(1);

  setTimeout(function() {
    notification.classList.remove('active');
  }, 30000);
});

// Only show errors/warnings as toasts, ignore info logs
socket.on('server_log', function(entry) {
  if (entry.type === 'error' || entry.type === 'warn') {
    var msg = entry.message + (entry.details ? ' (' + entry.details + ')' : '');
    showErrorToast(msg, entry.type);
  }
});

// Live WA message updates via socket
socket.on('wa_message', function(data) {
  // Refresh stats if on WhatsApp page
  if (window.location.hash === '#whatsapp') {
    loadWaStats();
    loadWaConversations();
  }
});

// ===== INITIALIZATION =====
checkMonitorStatus();
setInterval(checkMonitorStatus, 15000);
loadCallHistory();
handleRoute();
