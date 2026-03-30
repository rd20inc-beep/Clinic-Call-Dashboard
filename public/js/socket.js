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
  // Refresh agent cards if on agents page
  if (window.location.hash === '#agents' && typeof loadAgents === 'function') loadAgents();
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
  // STRICT OWNERSHIP CHECK: ignore events not belonging to this user
  if (!isEventForMe(data)) return;

  // Skip if we already handled this exact call
  if (data.callId && data.callId === lastHandledCallId) {
    return;
  }
  lastHandledCallId = data.callId;

  var isOutbound = data.direction === 'outbound';

  // Admin sees call data but NOT the popup notification/beep
  // Only the assigned agent gets the alert
  var isMyCall = data.agent && data.agent === myUsername;

  if (isMyCall || myRole !== 'admin') {
    patientNameBanner.textContent = '';
    patientNameBanner.style.display = 'none';
    var displayCaller = data.caller && data.caller.indexOf('contact:') === 0
      ? data.caller.slice(8)
      : data.caller;
    callerNumberText.textContent = (isOutbound ? '\u2197 Out: ' : '\u2199 In: ') + displayCaller;
    callerWhatsapp.href = getWhatsappUrl(data.caller);
    callTime.textContent = (isOutbound ? 'Outbound at ' : 'Received at ') + new Date(data.timestamp).toLocaleTimeString();
    cliniceaLink.href = data.cliniceaUrl;
    notification.classList.add('active');

    if (!isOutbound) {
      playBeep();
    }
  }

  // Auto-open Clinicea profile — only for the assigned agent, not admin
  if (isMyCall || myRole !== 'admin') {
    var shouldAutoOpen = !isOutbound;
    var lockKey = 'call_opened_' + data.callId;
    if (shouldAutoOpen && !localStorage.getItem(lockKey)) {
      localStorage.setItem(lockKey, '1');
      setTimeout(function() { localStorage.removeItem(lockKey); }, 60000);
      var win = window.open(data.cliniceaUrl, 'clinicea_patient');
      if (!win || win.closed) {
        cliniceaLink.textContent = '\u26A0 CLICK HERE to open patient profile (popup was blocked)';
        cliniceaLink.style.color = '#e74c3c';
        cliniceaLink.style.fontWeight = 'bold';
        cliniceaLink.style.fontSize = '16px';
      }
    }

    setTimeout(function() {
      notification.classList.remove('active');
    }, isOutbound ? 10000 : 30000);
  }

  // Always refresh call history and stats (admin and agents)
  loadCallHistory(1);
  loadCallStats();
});

// Call updated (duration/status arrived after call ended)
socket.on('call_updated', function(data) {
  if (!isEventForMe(data)) return;
  // Update status badge in-place
  if (data.callStatus) {
    var stEl = document.getElementById('status-' + data.callId);
    if (stEl) {
      var cls = data.callStatus === 'answered' ? 'answered' : data.callStatus === 'missed' ? 'missed' : 'unknown';
      var label = data.callStatus === 'answered' ? 'Answered' : data.callStatus === 'missed' ? 'Missed' : data.callStatus === 'rejected' ? 'Rejected' : '--';
      stEl.innerHTML = '<span class="call-st ' + cls + '">' + label + '</span>';
    }
  }
  // Update duration in-place
  if (data.duration !== null && data.duration !== undefined) {
    var durEl = document.getElementById('duration-' + data.callId);
    if (durEl) {
      durEl.textContent = formatCallDuration(data.duration);
    }
  }
  loadCallStats();
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

// Live WA connection status updates via socket
socket.on('wa_connection', function(data) {
  if (typeof waUpdateConnectionUI === 'function') {
    waUpdateConnectionUI(data.status, data.qrDataUrl);
  }
});

// Live agent status updates (admin only) — replaces static "Active"
socket.on('agent_status_update', function(data) {
  if (window.location.hash === '#agents' && typeof loadAgents === 'function') {
    loadAgents();
  }
  // Also refresh dashboard agent snapshot if on dashboard
  if (window.location.hash === '#dashboard' || window.location.hash === '') {
    if (typeof loadCallStats === 'function') loadCallStats();
  }
});

// Legacy event (kept for backward compat)
socket.on('agent_presence', function(data) {
  if (window.location.hash === '#agents' && typeof loadAgents === 'function') {
    loadAgents();
  }
});

// Admin message / broadcast — show as notification on agent dashboard
socket.on('admin_message', function(data) {
  var isBroadcast = data.broadcast ? ' (Broadcast)' : '';
  var msg = (data.from || 'Admin') + isBroadcast + ': ' + (data.message || '');

  // Show as a toast notification
  var toast = document.createElement('div');
  toast.className = 'error-toast';
  toast.style.cssText = 'background:#eff6ff;border-color:#3b82f6;color:#1e40af;';
  toast.innerHTML = '<strong style="display:block;margin-bottom:2px;">Message from ' + escapeHtml(data.from || 'Admin') + isBroadcast + '</strong>' +
    escapeHtml(data.message || '') +
    '<button class="error-toast-close" onclick="dismissToast(this)" style="color:#1e40af;">&times;</button>';
  toastContainer.appendChild(toast);

  // Auto-dismiss after 15 seconds (longer than normal toasts)
  setTimeout(function() {
    if (toast.parentNode) {
      toast.style.animation = 'toastOut 0.3s ease-in forwards';
      setTimeout(function() { toast.remove(); }, 300);
    }
  }, 15000);

  // Also play a notification sound
  try { playBeep(); } catch(e) {}
});

function sendInstantConfirmation(btn, appointmentId, phone, name, date, doctor, service) {
  btn.disabled = true;
  btn.textContent = 'Sending...';
  fetch('/api/calls/send-confirmation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appointmentId: appointmentId,
      patientPhone: phone,
      patientName: name,
      appointmentDate: date,
      doctorName: doctor,
      service: service
    })
  }).then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.ok) {
      btn.textContent = 'Sent ✓';
      btn.style.background = '#64748b';
      // Auto-dismiss after 3 seconds
      setTimeout(function() {
        var toast = btn.closest('.error-toast');
        if (toast) toast.remove();
      }, 3000);
    } else {
      btn.textContent = 'Failed';
      btn.style.background = '#ef4444';
      btn.disabled = false;
    }
  }).catch(function() {
    btn.textContent = 'Error';
    btn.style.background = '#ef4444';
    btn.disabled = false;
  });
}

// Send activity pings every 60 seconds so server knows we're active
setInterval(function() {
  if (socket.connected) socket.emit('activity');
}, 60000);

// ===== INITIALIZATION =====
checkMonitorStatus();
setInterval(checkMonitorStatus, 15000);
loadCallHistory();
loadCallStats();
if (typeof loadDashCharts === 'function') loadDashCharts();
if (typeof loadCallbackBadge === 'function') { loadCallbackBadge(); setInterval(loadCallbackBadge, 60000); }
handleRoute();
