// ===== HELPER FUNCTIONS =====
function getWhatsappUrl(phone) {
  return 'https://wa.me/' + phone.replace(/[\s\-\+]/g, '');
}

function escapeHtml(str) {
  var d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatCallDuration(seconds) {
  if (!seconds && seconds !== 0) return '--';
  if (seconds < 60) return seconds + 's';
  var m = Math.floor(seconds / 60);
  var s = seconds % 60;
  return m + ':' + String(s).padStart(2, '0');
}

// ===== ALERT DISMISS =====
function dismissAlert(btn, text) {
  var dismissed = JSON.parse(sessionStorage.getItem('dismissedAlerts') || '[]');
  if (dismissed.indexOf(text) === -1) dismissed.push(text);
  sessionStorage.setItem('dismissedAlerts', JSON.stringify(dismissed));
  var alertDiv = btn.parentNode;
  alertDiv.style.transition = 'opacity 0.3s';
  alertDiv.style.opacity = '0';
  setTimeout(function() { alertDiv.remove(); }, 300);
}

// ===== FORCE LOGOUT ALL =====
function forceLogoutAll() {
  if (!confirm('Force logout ALL agents from dashboard and mobile app?\n\nThis will disconnect everyone immediately.')) return;
  waFetch('/api/force-logout-all', { method: 'POST' })
    .then(function(data) {
      if (data.ok) {
        alert('Logged out ' + data.dashboardDisconnected + ' dashboard session(s) and ' + data.mobileInvalidated + ' mobile session(s).');
      } else {
        alert('Error: ' + (data.error || 'Unknown'));
      }
    })
    .catch(function(err) { alert('Error: ' + err.message); });
}

// ===== QUICK MESSAGE AGENT (contextual from call history) =====
function quickMessageAgent(agent, caller, status, patient) {
  // Remove existing modal
  var old = document.getElementById('quickMsgModal'); if (old) old.remove();

  var name = patient || caller;
  var templates = [];

  if (status === 'missed') {
    templates.push({ label: 'Ask about missed call', text: 'Hi, patient ' + name + ' (' + caller + ') called and was missed. Can you please call them back?' });
    templates.push({ label: 'Urgent callback', text: 'URGENT: Please call back ' + name + ' (' + caller + ') immediately — missed call needs follow-up.' });
  }
  if (status === 'answered') {
    templates.push({ label: 'Ask for update', text: 'Hi, how did the call with ' + name + ' (' + caller + ') go? Was an appointment booked?' });
    templates.push({ label: 'Appointment reminder', text: 'Please make sure to book an appointment for ' + name + ' (' + caller + ') if not done already.' });
  }
  templates.push({ label: 'Follow up', text: 'Please follow up with ' + name + ' (' + caller + ') regarding their inquiry.' });
  templates.push({ label: 'Custom message', text: '' });

  var ov = document.createElement('div');
  ov.id = 'quickMsgModal';
  ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  ov.onclick = function(e) { if (e.target === ov) ov.remove(); };

  var html = '<div style="background:#fff;border-radius:12px;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.15);padding:24px;">';
  html += '<h3 style="margin:0 0 4px;font-size:16px;color:#0f172a;">Message to ' + escapeHtml(agent) + '</h3>';
  html += '<p style="margin:0 0 16px;font-size:12px;color:#94a3b8;">About: ' + escapeHtml(name) + ' (' + escapeHtml(caller) + ')</p>';

  // Template buttons
  html += '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">';
  templates.forEach(function(t, i) {
    if (t.text) {
      html += '<button data-tpl-idx="' + i + '" style="text-align:left;padding:8px 12px;border:1px solid #e2e8f0;border-radius:6px;background:#f8fafc;color:#334155;font-size:12px;cursor:pointer;font-family:inherit;">' + escapeHtml(t.label) + '</button>';
    }
  });
  html += '</div>';

  html += '<textarea id="qmText" rows="3" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;resize:vertical;box-sizing:border-box;font-family:inherit;" placeholder="Type or select a template above..."></textarea>';
  html += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">';
  html += '<button onclick="document.getElementById(\'quickMsgModal\').remove()" style="padding:8px 16px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#64748b;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>';
  html += '<button id="qmSendBtn" style="padding:8px 16px;border:none;border-radius:6px;background:#3b82f6;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">Send</button>';
  html += '</div></div>';

  ov.innerHTML = html;
  // Bind template buttons safely (avoid inline onclick with user data)
  ov.querySelectorAll('[data-tpl-idx]').forEach(function(btn) {
    var idx = parseInt(btn.getAttribute('data-tpl-idx'), 10);
    if (templates[idx] && templates[idx].text) {
      btn.addEventListener('click', function() {
        document.getElementById('qmText').value = templates[idx].text;
      });
    }
  });
  // Bind send button safely (avoid inline onclick with user data)
  ov.querySelector('#qmSendBtn').addEventListener('click', function() {
    sendQuickMessage(agent);
  });
  document.body.appendChild(ov);
}

function sendQuickMessage(agent) {
  var msg = document.getElementById('qmText').value.trim();
  if (!msg) return;
  waFetch('/admin/message-agent', { method: 'POST', body: JSON.stringify({ agent: agent, message: msg }) })
    .then(function(d) {
      if (d.success) {
        document.getElementById('quickMsgModal').remove();
        // Show success toast
        var toast = document.createElement('div');
        toast.className = 'error-toast success';
        toast.innerHTML = 'Message sent to ' + escapeHtml(agent) + '<button class="error-toast-close" onclick="dismissToast(this)">&times;</button>';
        toastContainer.appendChild(toast);
        setTimeout(function() { if (toast.parentNode) { toast.style.animation = 'toastOut 0.3s ease-in forwards'; setTimeout(function() { toast.remove(); }, 300); } }, 4000);
      } else {
        alert('Error: ' + (d.error || 'Failed'));
      }
    })
    .catch(function(err) { alert('Error: ' + err.message); });
}

// ===== CLEAR PATIENT FILTERS =====
function clearPatientFilters() {
  document.getElementById('patientSearch').value = '';
  var docSel = document.getElementById('patientDoctorFilter'); if (docSel) docSel.value = '';
  var svcSel = document.getElementById('patientServiceFilter'); if (svcSel) svcSel.value = '';
  var sortSel = document.getElementById('patientSort'); if (sortSel) sortSel.value = 'recent';
  loadPatients(1);
}

// ===== EDIT PATIENT =====
function editPatient(id, name, phone, email) {
  var old = document.getElementById('editPatientModal'); if (old) old.remove();
  var ov = document.createElement('div');
  ov.id = 'editPatientModal';
  ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  ov.onclick = function(e) { if (e.target === ov) ov.remove(); };
  ov.innerHTML = '<div style="background:#fff;border-radius:12px;max-width:420px;width:100%;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,0.15);">' +
    '<h3 style="margin:0 0 16px;font-size:16px;color:#0f172a;">Edit Patient</h3>' +
    '<div style="display:grid;gap:10px;">' +
      '<div><label style="font-size:12px;color:#64748b;font-weight:600;display:block;margin-bottom:3px;">Name</label><input id="epName" type="text" value="' + escapeHtml(name) + '" style="width:100%;padding:7px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;box-sizing:border-box;"></div>' +
      '<div><label style="font-size:12px;color:#64748b;font-weight:600;display:block;margin-bottom:3px;">Phone</label><input id="epPhone" type="text" value="' + escapeHtml(phone) + '" style="width:100%;padding:7px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;box-sizing:border-box;"></div>' +
      '<div><label style="font-size:12px;color:#64748b;font-weight:600;display:block;margin-bottom:3px;">Email</label><input id="epEmail" type="text" value="' + escapeHtml(email) + '" style="width:100%;padding:7px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;box-sizing:border-box;"></div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">' +
      '<button onclick="document.getElementById(\'editPatientModal\').remove()" style="padding:8px 16px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#64748b;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>' +
      '<button onclick="savePatientEdit(' + id + ')" style="padding:8px 16px;border:none;border-radius:6px;background:#3b82f6;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">Save</button>' +
    '</div></div>';
  document.body.appendChild(ov);
}

function savePatientEdit(id) {
  var name = document.getElementById('epName').value.trim();
  var phone = document.getElementById('epPhone').value.trim();
  var email = document.getElementById('epEmail').value.trim();
  if (!name) return alert('Name is required');
  fetch('/api/patients/edit', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ id: id, name: name, phone: phone, email: email }) })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) { document.getElementById('editPatientModal').remove(); loadPatients(patientsPage); }
      else alert('Error: ' + (d.error || 'Unknown'));
    }).catch(function(e) { alert('Error: ' + e.message); });
}

// ===== TOGGLE CALL DIRECTION =====
function toggleCallDirection(callId, newDirection) {
  fetch('/api/calls/' + callId + '/direction', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ direction: newDirection }) })
    .then(function() { loadCallHistory(); })
    .catch(function() {});
}

// ===== CALL DISPOSITION =====
function setCallDisposition(callId, disposition) {
  if (!disposition) return;

  // If appointment booked, show confirmation dialog FIRST
  if (disposition === 'appointment_booked') {
    showAppointmentBookedDialog(callId, disposition);
    return;
  }

  fetch('/api/calls/' + callId + '/disposition', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ disposition: disposition }) }).catch(function() {});
}

function showAppointmentBookedDialog(callId, disposition) {
  // Save disposition and fetch call + appointment data from server
  fetch('/api/calls/' + callId + '/disposition', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ disposition: disposition })
  }).then(function(r) { return r.json(); }).then(function() {
    // Get the call details from server to find phone number
    return safeFetch('/api/calls/' + callId);
  }).then(function(callData) {
    var call = callData.call || callData;
    var phone = (call.caller_number || '').replace(/[\s\-()]/g, '');
    var patientName = call.patient_name || '';
    console.log('[Appt] Call data:', call.id, phone, patientName);

    if (!phone || phone === 'Unknown') {
      showErrorToast('Appointment booked (no phone to send confirmation)');
      return;
    }
    // Fetch the patient's upcoming appointment
    safeFetch('/api/calls/check-appointment?phone=' + encodeURIComponent(phone)).then(function(aptData) {
      if (!aptData || !aptData.appointment) {
        showErrorToast('Appointment booked! No upcoming appointment found to confirm.');
        return;
      }
      var apt = aptData.appointment;
      var alreadySent = aptData.confirmationAlreadySent;
      var dateStr = apt.appointment_date || '';
      var formattedDate = dateStr;
      try {
        if (dateStr.indexOf('T') >= 0) {
          var parts = dateStr.split('T');
          var timeParts = parts[1].split(':');
          var h = parseInt(timeParts[0]);
          var m = timeParts[1];
          var ampm = h >= 12 ? 'PM' : 'AM';
          var h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
          formattedDate = parts[0] + ' at ' + h12 + ':' + m + ' ' + ampm;
        }
      } catch(e) {}

      // Show confirmation dialog
      var popup = document.createElement('div');
      popup.className = 'error-toast';
      popup.style.cssText = 'background:#f0fdf4;border:2px solid #10b981;color:#064e3b;max-width:420px;box-shadow:0 8px 30px rgba(0,0,0,0.15);';
      popup.innerHTML =
        '<strong style="display:block;margin-bottom:8px;font-size:15px;">Appointment Booked</strong>' +
        '<div style="margin-bottom:12px;font-size:13px;line-height:1.6;">' +
          '<div style="font-weight:700;font-size:15px;">' + escapeHtml(apt.patient_name || patientName || 'Patient') + '</div>' +
          '<div style="color:#3b82f6;font-weight:600;">' + escapeHtml(formattedDate) + '</div>' +
          (apt.service ? '<div>' + escapeHtml(apt.service) + '</div>' : '') +
          (apt.doctor_name ? '<div style="color:#64748b;">' + escapeHtml(apt.doctor_name) + '</div>' : '') +
          '<div style="color:#94a3b8;font-size:12px;">' + escapeHtml(apt.patient_phone || phone) + '</div>' +
        '</div>' +
        (alreadySent
          ? '<div style="display:flex;gap:8px;align-items:center;">' +
              '<span style="flex:1;padding:10px 16px;border-radius:8px;background:#64748b;color:white;font-weight:700;font-size:14px;text-align:center;">Confirmation Already Sent</span>' +
              '<button onclick="this.closest(\'.error-toast\').remove()" style="padding:10px 16px;border:1px solid #e2e8f0;border-radius:8px;background:white;color:#64748b;font-size:13px;cursor:pointer;">OK</button>' +
            '</div>'
          : '<div style="display:flex;gap:8px;">' +
              '<button id="confirmSendBtn_' + callId + '" onclick="sendInstantConfirmation(this,' + (apt.id || 0) + ')" ' +
                'style="flex:1;padding:10px 16px;border:none;border-radius:8px;background:#10b981;color:white;font-weight:700;font-size:14px;cursor:pointer;">Queue Confirmation for Approval</button>' +
              '<button onclick="this.closest(\'.error-toast\').remove()" style="padding:10px 16px;border:1px solid #e2e8f0;border-radius:8px;background:white;color:#64748b;font-size:13px;cursor:pointer;">Skip</button>' +
            '</div>'
        ) +
        '<button class="error-toast-close" onclick="dismissToast(this)" style="color:#064e3b;">&times;</button>';
      toastContainer.appendChild(popup);
      try { playBeep(); } catch(e) {}
    }).catch(function() {
      showErrorToast('Appointment booked!', 'success');
    });
  }).catch(function() {});
}

// ===== CONFIRMATIONS PAGE =====
var _allConfirmations = [];
var _confFilter = 'all';

function filterConfirmations(filter) {
  _confFilter = filter;
  var filterBar = document.getElementById('confActiveFilter');
  var filterLabel = document.getElementById('confFilterLabel');
  if (filter === 'all') {
    filterBar.style.display = 'none';
  } else {
    filterBar.style.display = '';
    filterLabel.textContent = filter === 'sent' ? 'Delivered by WhatsApp' : filter === 'pending' ? 'Awaiting delivery' : 'With reminders';
  }
  renderConfirmations(_allConfirmations, filter);
}

function loadConfirmations() {
  var period = (document.getElementById('confirmationPeriod') || {}).value || 'today';
  var container = document.getElementById('confirmationList');
  if (!container) return;
  container.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
  _confFilter = 'all';
  var filterBar = document.getElementById('confActiveFilter');
  if (filterBar) filterBar.style.display = 'none';

  safeFetch('/api/calls/confirmations?period=' + period).then(function(data) {
    var confs = data.confirmations || [];
    _allConfirmations = confs;

    // Count by type
    // "Confirmed" = confirmation was queued/sent (confirmation_sent=1 in tracking)
    // "Awaiting Delivery" = message queued but not yet delivered by WhatsApp
    // "Reminders" = also got a reminder
    var confirmed = 0, awaitingDelivery = 0, reminders = 0;
    confs.forEach(function(c) {
      var ms = c.message_status || '';
      if (ms === 'sent') confirmed++;
      else awaitingDelivery++; // pending, approved, or unknown = not yet delivered
      if (c.reminder_sent) reminders++;
    });
    document.getElementById('confSentCount').textContent = confs.length; // total confirmations queued
    document.getElementById('confPendingCount').textContent = awaitingDelivery;
    document.getElementById('confReminderCount').textContent = reminders;

    renderConfirmations(confs, 'all');
  }).catch(function(e) {
    container.innerHTML = '<div class="empty-state"><p style="color:#ef4444;">Failed to load: ' + (e.message || 'unknown error') + '</p></div>';
  });
}

function renderConfirmations(confs, filter) {
  var container = document.getElementById('confirmationList');
  if (!container) return;

  // Apply filter
  var filtered = confs;
  if (filter === 'sent') {
    filtered = confs.filter(function(c) { return (c.message_status || 'sent') === 'sent'; });
  } else if (filter === 'pending') {
    filtered = confs.filter(function(c) { var ms = c.message_status || ''; return ms === 'pending' || ms === 'approved'; });
  } else if (filter === 'reminder') {
    filtered = confs.filter(function(c) { return !!c.reminder_sent; });
  }

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No confirmations match this filter.</p></div>';
    return;
  }

  var html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
      '<thead><tr style="background:#f8fafc;text-align:left;">' +
        '<th style="padding:10px 8px;border-bottom:1px solid #e2e8f0;">Patient</th>' +
        '<th style="padding:10px 8px;border-bottom:1px solid #e2e8f0;">Phone</th>' +
        '<th style="padding:10px 8px;border-bottom:1px solid #e2e8f0;">Appointment</th>' +
        '<th style="padding:10px 8px;border-bottom:1px solid #e2e8f0;">Service</th>' +
        '<th style="padding:10px 8px;border-bottom:1px solid #e2e8f0;">Sent By</th>' +
        '<th style="padding:10px 8px;border-bottom:1px solid #e2e8f0;">Status</th>' +
        '<th style="padding:10px 8px;border-bottom:1px solid #e2e8f0;">Sent At</th>' +
      '</tr></thead><tbody>';

    filtered.forEach(function(c) {
      var aptDate = c.appointment_date || '';
      var formattedDate = aptDate;
      try {
        if (aptDate.indexOf('T') >= 0) {
          var parts = aptDate.split('T');
          var tp = parts[1].split(':');
          var h = parseInt(tp[0]); var m = tp[1];
          var ampm = h >= 12 ? 'PM' : 'AM';
          var h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
          formattedDate = parts[0] + ' ' + h12 + ':' + m + ' ' + ampm;
        }
      } catch(e) {}

      var sentAt = c.confirmation_sent_at || '';
      if (sentAt.length > 16) sentAt = sentAt.substring(0, 16).replace('T', ' ');

      var statusBadge = '';
      var ms = c.message_status || (c.confirmation_sent ? 'sent' : 'unknown');
      if (ms === 'sent') statusBadge = '<span style="background:#dcfce7;color:#16a34a;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">Sent</span>';
      else if (ms === 'approved') statusBadge = '<span style="background:#dbeafe;color:#2563eb;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">Approved</span>';
      else if (ms === 'pending') statusBadge = '<span style="background:#fef3c7;color:#d97706;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">Pending</span>';
      else if (ms === 'failed') statusBadge = '<span style="background:#fecaca;color:#dc2626;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">Failed</span>';
      else statusBadge = '<span style="background:#e2e8f0;color:#64748b;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">' + escapeHtml(ms) + '</span>';

      var reminderBadge = c.reminder_sent
        ? '<span style="background:#dbeafe;color:#2563eb;padding:1px 6px;border-radius:8px;font-size:10px;margin-left:4px;">Reminder</span>'
        : '';

      html += '<tr style="border-bottom:1px solid #f1f5f9;">' +
        '<td style="padding:8px;">' + escapeHtml(c.patient_name || '-') + '</td>' +
        '<td style="padding:8px;color:#64748b;">' + escapeHtml(c.patient_phone || '-') + '</td>' +
        '<td style="padding:8px;font-weight:600;color:#3b82f6;">' + escapeHtml(formattedDate) + '</td>' +
        '<td style="padding:8px;">' + escapeHtml(c.service || '-') + '</td>' +
        '<td style="padding:8px;">' + escapeHtml(c.sent_by || 'System') + '</td>' +
        '<td style="padding:8px;">' + statusBadge + reminderBadge + '</td>' +
        '<td style="padding:8px;color:#94a3b8;font-size:12px;">' + escapeHtml(sentAt) + '</td>' +
      '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

// ===== CALL NOTES =====
function addCallNote(callId) {
  var note = prompt('Add note for call #' + callId + ':');
  if (note === null) return;
  fetch('/api/calls/' + callId + '/notes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ notes: note }) })
    .then(function() { loadCallHistory(); })
    .catch(function() {});
}

// ===== AGENT STATUS SELECTOR =====
function setMyStatus(status) {
  fetch('/api/agent/set-status', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ status: status }) }).catch(function() {});
}

// ===== PERSISTENT NOTIFICATIONS =====
function saveNotification(msg) {
  var stored = JSON.parse(localStorage.getItem('dashNotifications') || '[]');
  stored.unshift({ text: msg, time: Date.now() });
  if (stored.length > 15) stored = stored.slice(0, 15);
  localStorage.setItem('dashNotifications', JSON.stringify(stored));
}

// ===== CALLBACK BADGE =====
function loadCallbackBadge() {
  if (myRole !== 'admin') return;
  if (sessionStorage.getItem('callbackBadgeDismissed')) return;
  fetch('/admin/callbacks/summary', { headers: { 'Accept': 'application/json' } })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var pending = d.pending || 0;
      var overdue = d.overdue || 0;
      var el = document.getElementById('callbackBadge');
      var textEl = document.getElementById('callbackBadgeText');
      if (el && textEl) {
        if (pending > 0) {
          var msg = pending + ' pending callback' + (pending !== 1 ? 's' : '');
          if (overdue > 0) msg += ' (' + overdue + ' overdue)';
          msg += ' — click to review';
          textEl.textContent = msg;
          el.style.display = 'flex';  // flex layout for text + dismiss button
        } else {
          el.style.display = 'none';
        }
      }
    })
    .catch(function() {});
}

function dismissCallbackBadge() {
  var el = document.getElementById('callbackBadge');
  if (el) el.style.display = 'none';
  sessionStorage.setItem('callbackBadgeDismissed', '1');
}

// ===== SAFE FETCH HELPER (for non-waFetch callers) =====
async function safeFetch(url, opts) {
  var res = await fetch(url, opts);
  var ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (res.status === 401 || res.redirected) window.location.href = '/login';
    throw new Error('Non-JSON response');
  }
  return res.json();
}

// ===== CALL STATS =====
async function loadCallStats() {
  try {
    var data = await safeFetch('/api/call-stats');
    var el = document.getElementById('callStats');
    if (!el) return;

    var todayTalkTime = data.today.talkTime || 0;

    el.innerHTML =
      dashStatCard('Today', data.today.total || 0, '', 'all') +
      dashStatCard('Inbound', data.today.inbound || 0, 'inbound', 'direction=inbound') +
      dashStatCard('Outbound', data.today.outbound || 0, 'outbound', 'direction=outbound') +
      dashStatCard('Answered', data.today.answered || 0, 'answered', 'status=answered') +
      dashStatCard('Missed', data.today.missed || 0, 'missed', 'status=missed') +
      dashStatCard('Talk Time', formatCallDuration(todayTalkTime), '', 'status=answered') +
      dashStatCard('Avg Duration', formatCallDuration(data.avgDuration));

    // Admin-only sections
    var adminRow = document.getElementById('dashAdminRow');
    if (myRole === 'admin' && adminRow) {
      adminRow.style.display = '';

      // Agent snapshot
      var snap = data.agentSnapshot || [0, 0, 0];
      var countsEl = document.getElementById('dashAgentCounts');
      if (countsEl) {
        countsEl.innerHTML =
          dashMiniStat(snap[0], 'Active', '#2ecc71') +
          dashMiniStat(snap[1], 'Idle', '#f39c12') +
          dashMiniStat(snap[2], 'Offline', '#e74c3c');
      }

      // Recent calls
      var recentEl = document.getElementById('dashRecentCalls');
      if (recentEl && data.recentCalls) {
        if (data.recentCalls.length === 0) {
          recentEl.innerHTML = '<span style="color:#999;">No recent calls</span>';
        } else {
          recentEl.innerHTML = data.recentCalls.map(function(c) {
            var icon = c.direction === 'outbound' ? '\u2197' : '\u2199';
            var statusColor = c.call_status === 'answered' ? '#2ecc71' : c.call_status === 'missed' ? '#e74c3c' : '#999';
            var time = new Date(c.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #f5f5f5;">' +
              '<span style="font-size:14px;">' + icon + '</span>' +
              '<span style="flex:1;font-weight:500;">' + escapeHtml(c.caller_number) + '</span>' +
              '<span style="font-size:11px;color:#888;">' + escapeHtml(c.agent || 'untagged') + '</span>' +
              '<span style="width:6px;height:6px;border-radius:50%;background:' + statusColor + ';display:inline-block;"></span>' +
              '<span style="font-size:11px;color:#999;">' + time + '</span>' +
            '</div>';
          }).join('');
        }
      }

      // Alerts
      var alertsEl = document.getElementById('dashAlerts');
      if (alertsEl && data.alerts && data.alerts.length > 0) {
        // Filter out dismissed alerts
        var dismissed = JSON.parse(sessionStorage.getItem('dismissedAlerts') || '[]');
        var visible = data.alerts.filter(function(a) { return dismissed.indexOf(a.text) === -1; });
        if (visible.length > 0) {
          alertsEl.innerHTML = visible.map(function(a) {
            var bg = a.type === 'error' ? 'rgba(231,76,60,0.12)' : 'rgba(243,156,18,0.12)';
            var border = a.type === 'error' ? 'rgba(231,76,60,0.3)' : 'rgba(243,156,18,0.3)';
            var color = a.type === 'error' ? '#e74c3c' : '#f39c12';
            var filterParam = a.text.indexOf('missed') !== -1 ? 'status=missed' : '';
            return '<div style="padding:10px 14px;background:' + bg + ';border:1px solid ' + border + ';border-radius:8px;margin-bottom:6px;font-size:13px;color:' + color + ';font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:10px;">' +
              '<span style="cursor:' + (filterParam ? 'pointer' : 'default') + ';" ' + (filterParam ? 'onclick="applyCallFilter(\'' + filterParam + '\')"' : '') + '>\u26A0 ' + escapeHtml(a.text) + '</span>' +
              '<button onclick="dismissAlert(this,\'' + escapeHtml(a.text).replace(/'/g, "\\'") + '\')" style="background:none;border:none;color:' + color + ';font-size:18px;cursor:pointer;padding:0 4px;opacity:0.6;" title="Dismiss">&times;</button>' +
            '</div>';
          }).join('');
        } else {
          alertsEl.innerHTML = '';
        }
      } else if (alertsEl) {
        alertsEl.innerHTML = '';
      }
    }
  } catch (err) {
    console.error('Failed to load call stats:', err);
  }
}

function dashStatCard(label, value, cls, filter) {
  var onclick = filter ? ' onclick="applyCallFilter(\'' + filter + '\')" style="cursor:pointer;"' : '';
  return '<div class="call-stat-card' + (cls ? ' ' + cls : '') + '"' + onclick + '>' +
    '<div class="call-stat-value">' + value + '</div>' +
    '<div class="call-stat-label">' + label + '</div>' +
  '</div>';
}

function dashMiniStat(value, label, color) {
  return '<div style="text-align:center;flex:1;">' +
    '<div style="font-weight:700;font-size:20px;color:' + color + ';">' + value + '</div>' +
    '<div style="font-size:11px;color:#999;">' + label + '</div>' +
  '</div>';
}

// ===== CALL FILTERS =====
var activeCallFilters = {};

function applyCallFilter(filterStr) {
  // Parse filter string like "status=missed" or "direction=inbound" or "all"
  if (filterStr === 'all') {
    clearCallFilters();
    return;
  }
  var parts = filterStr.split('=');
  if (parts.length === 2) {
    activeCallFilters[parts[0]] = parts[1];
    // Update dropdowns
    if (parts[0] === 'status') document.getElementById('filterStatus').value = parts[1];
    if (parts[0] === 'direction') document.getElementById('filterDirection').value = parts[1];
  }
  currentPage = 1;
  loadFilteredCalls();
}

function loadFilteredCalls() {
  activeCallFilters.status = document.getElementById('filterStatus').value || '';
  activeCallFilters.direction = document.getElementById('filterDirection').value || '';
  activeCallFilters.agent = document.getElementById('filterAgent').value || '';
  activeCallFilters.from = document.getElementById('filterFrom').value || '';
  activeCallFilters.to = document.getElementById('filterTo').value || '';
  activeCallFilters.search = (document.getElementById('filterSearch') || {}).value || '';
  activeCallFilters.disposition = (document.getElementById('filterDisposition') || {}).value || '';
  currentPage = 1;
  loadCallHistory();
}

function clearCallFilters() {
  activeCallFilters = {};
  document.getElementById('filterStatus').value = '';
  document.getElementById('filterDirection').value = '';
  document.getElementById('filterAgent').value = '';
  document.getElementById('filterFrom').value = '';
  document.getElementById('filterTo').value = '';
  var searchEl = document.getElementById('filterSearch'); if (searchEl) searchEl.value = '';
  var dispEl = document.getElementById('filterDisposition'); if (dispEl) dispEl.value = '';
  document.getElementById('filterActiveLabel').style.display = 'none';
  currentPage = 1;
  loadCallHistory();
}

// ---------------------------------------------------------------------------
// Clear call history
// ---------------------------------------------------------------------------
function clearMyCallHistory() {
  if (!confirm('Delete all YOUR call history?\n\nThis cannot be undone.')) return;
  fetch('/api/calls/clear-my-history', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        showToast(data.deleted + ' calls deleted', 'success');
        currentPage = 1;
        loadCallHistory();
      } else {
        showToast(data.error || 'Failed to clear history', 'error');
      }
    })
    .catch(function(e) { showToast('Error: ' + e.message, 'error'); });
}

function clearAllCallHistory() {
  if (!confirm('DELETE ALL call history for EVERY agent?\n\nThis cannot be undone.')) return;
  if (!confirm('Are you absolutely sure? All call records will be permanently removed.')) return;
  fetch('/api/agents/clear-all-history', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        showToast(data.deleted + ' total calls deleted', 'success');
        currentPage = 1;
        loadCallHistory();
      } else {
        showToast(data.error || 'Failed to clear history', 'error');
      }
    })
    .catch(function(e) { showToast('Error: ' + e.message, 'error'); });
}

function buildCallQueryString() {
  var qs = 'page=' + currentPage + '&limit=10';
  if (activeCallFilters.status) qs += '&status=' + activeCallFilters.status;
  if (activeCallFilters.direction) qs += '&direction=' + activeCallFilters.direction;
  if (activeCallFilters.agent) qs += '&agent=' + activeCallFilters.agent;
  if (activeCallFilters.from) qs += '&from=' + activeCallFilters.from;
  if (activeCallFilters.to) qs += '&to=' + activeCallFilters.to;
  if (activeCallFilters.search) qs += '&search=' + encodeURIComponent(activeCallFilters.search);
  if (activeCallFilters.disposition) qs += '&disposition=' + activeCallFilters.disposition;
  return qs;
}

function updateFilterLabel() {
  var parts = [];
  if (activeCallFilters.status) parts.push(activeCallFilters.status);
  if (activeCallFilters.direction) parts.push(activeCallFilters.direction);
  if (activeCallFilters.agent) parts.push(activeCallFilters.agent);
  if (activeCallFilters.from || activeCallFilters.to) parts.push((activeCallFilters.from || '...') + ' to ' + (activeCallFilters.to || '...'));
  var label = document.getElementById('filterActiveLabel');
  if (parts.length > 0) {
    label.textContent = 'Filtered: ' + parts.join(', ');
    label.style.display = '';
  } else {
    label.style.display = 'none';
  }
}

// Agent name lookup map
var agentNameMap = {};
function getAgentDisplayName(username) { return agentNameMap[username] || username || '-'; }

// Populate agent filter dropdown (admin only)
function loadAgentFilterOptions() {
  if (myRole !== 'admin') return;
  var sel = document.getElementById('filterAgent');
  if (!sel) return;
  sel.style.display = '';
  waFetch('/api/agents').then(function(data) {
    var opts = '<option value="">All Agents</option>';
    (data.agents || []).forEach(function(a) {
      agentNameMap[a.username] = a.displayName || a.username;
      if (a.role !== 'admin') opts += '<option value="' + escapeHtml(a.username) + '">' + escapeHtml(a.displayName || a.username) + '</option>';
    });
    sel.innerHTML = opts;
  }).catch(function() {});
}

// ===== CALL HISTORY =====
async function loadCallHistory(page) {
  if (page !== undefined) currentPage = page;
  updateFilterLabel();
  try {
    var data = await safeFetch('/api/calls?' + buildCallQueryString());
    var calls = data.calls;
    var total = data.total;
    var totalPages = data.totalPages;

    if (total === 0) {
      callHistory.innerHTML = '<div class="empty-state"><p>No calls yet. Waiting for incoming calls...</p></div>';
      return;
    }

    var html = '<div class="call-table"><table>' +
      '<thead>' +
        '<tr>' +
          '<th>#</th>' +
          '<th>Direction</th>' +
          '<th>Caller</th>' +
          '<th>Patient</th>' +
          '<th>Agent</th>' +
          '<th>Source</th>' +
          '<th>Status</th>' +
          '<th>Duration</th>' +
          '<th>Time</th>' +
          '<th>Next Meeting</th>' +
          '<th>Profile</th>' +
        '</tr>' +
      '</thead><tbody>';

    calls.forEach(function(call) {
      var time = new Date(call.timestamp + 'Z').toLocaleString();
      // Strip "contact:" prefix for display
      var rawNumber = call.caller_number || '';
      var dir = call.direction || 'inbound';
      var displayNumber = rawNumber.indexOf('contact:') === 0
        ? rawNumber.slice(8)
        : (rawNumber === 'Unknown' || !rawNumber)
          ? (call.patient_name || (dir === 'outbound' ? 'Outbound Call' : 'Unknown'))
          : rawNumber;
      var waUrl = getWhatsappUrl(call.caller_number);
      var nameDisplay = call.patient_name
        ? '<span class="meeting-badge upcoming" id="name-' + call.id + '">' + escapeHtml(call.patient_name) + '</span>'
        : '<span class="meeting-badge loading" id="name-' + call.id + '">--</span>';

      // Direction badge (clickable to toggle)
      var dir = call.direction || 'inbound';
      var dirBadge = dir === 'outbound'
        ? '<span class="call-dir outbound" style="cursor:pointer;" onclick="toggleCallDirection(' + call.id + ',\'inbound\')" title="Click to change to Inbound">&#8599; Out</span>'
        : '<span class="call-dir inbound" style="cursor:pointer;" onclick="toggleCallDirection(' + call.id + ',\'outbound\')" title="Click to change to Outbound">&#8601; In</span>';

      // Status badge
      var st = call.call_status || 'unknown';
      var stBadge = st === 'answered' ? '<span class="call-st answered">Answered</span>'
        : st === 'missed' ? '<span class="call-st missed">Missed</span>'
        : st === 'rejected' ? '<span class="call-st missed">Rejected</span>'
        : '<span class="call-st unknown">--</span>';

      // Duration
      var durDisplay = formatCallDuration(call.duration);

      html += '<tr data-call-id="' + call.id + '" data-caller-number="' + escapeHtml(call.caller_number || '') + '" data-patient-name="' + escapeHtml(call.patient_name || '') + '">' +
        '<td>' + call.id + '</td>' +
        '<td>' + dirBadge + '</td>' +
        '<td>' +
          '<span class="caller-number-wrap">' +
            '<strong>' + escapeHtml(displayNumber) + '</strong>' +
            '<a href="' + waUrl + '" target="_blank" class="whatsapp-link" title="Message on WhatsApp">' + whatsappSvg + '</a>' +
          '</span>' +
        '</td>' +
        '<td>' + nameDisplay + '</td>' +
        '<td><strong style="color:#334155;font-size:12px;">' + escapeHtml(getAgentDisplayName(call.agent)) + '</strong></td>' +
        '<td>' + (call.source === 'whatsapp' ? '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:#dcfce7;color:#16a34a;">WhatsApp</span>' : '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:#eff6ff;color:#2563eb;">Phone</span>') + '</td>' +
        '<td><span id="status-' + call.id + '">' + stBadge + '</span></td>' +
        '<td><span id="duration-' + call.id + '">' + durDisplay + '</span></td>' +
        '<td>' + escapeHtml(time) + '</td>' +
        '<td><span class="meeting-badge loading" id="meeting-' + call.id + '">Loading...</span></td>' +
        '<td style="display:flex;gap:3px;align-items:center;flex-wrap:wrap;">' +
          '<button class="btn-profile" onclick="openProfile(\'' + escapeHtml(call.caller_number) + '\',\'' + escapeHtml(call.clinicea_url) + '\')">Profile</button>' +
          '<select style="padding:2px 4px;border:1px solid #e2e8f0;border-radius:3px;font-size:9px;color:#475569;max-width:80px;" onchange="setCallDisposition(' + call.id + ',this.value)" title="Disposition">' +
            '<option value=""' + (!call.disposition ? ' selected' : '') + '>Outcome</option>' +
            '<option value="appointment_booked"' + (call.disposition === 'appointment_booked' ? ' selected' : '') + '>Appt Booked</option>' +
            '<option value="follow_up_needed"' + (call.disposition === 'follow_up_needed' ? ' selected' : '') + '>Follow Up</option>' +
            '<option value="inquiry_only"' + (call.disposition === 'inquiry_only' ? ' selected' : '') + '>Inquiry</option>' +
            '<option value="wrong_number"' + (call.disposition === 'wrong_number' ? ' selected' : '') + '>Wrong #</option>' +
            '<option value="existing_patient"' + (call.disposition === 'existing_patient' ? ' selected' : '') + '>Existing</option>' +
          '</select>' +
          '<button style="padding:2px 5px;border:1px solid #e2e8f0;border-radius:3px;background:#fff;color:#64748b;font-size:9px;cursor:pointer;" onclick="addCallNote(' + call.id + ')" title="' + escapeHtml(call.notes || 'Add note') + '">' + (call.notes ? '📝' : '✏️') + '</button>' +
          (myRole === 'admin' && call.agent ? '<button style="padding:2px 5px;border:1px solid #e2e8f0;border-radius:3px;background:#fff;color:#3b82f6;font-size:9px;cursor:pointer;" onclick="quickMessageAgent(\'' + escapeHtml(call.agent) + '\',\'' + escapeHtml(displayNumber) + '\',\'' + escapeHtml(call.call_status || '') + '\',\'' + escapeHtml(call.patient_name || '') + '\')">Msg</button>' : '') +
        '</td>' +
      '</tr>';
    });

    html += '</tbody></table></div>';

    if (totalPages > 1) {
      html += '<div class="pagination">';
      html += '<button onclick="loadCallHistory(1)" ' + (currentPage === 1 ? 'disabled' : '') + '>&laquo;</button>';
      html += '<button onclick="loadCallHistory(' + (currentPage - 1) + ')" ' + (currentPage === 1 ? 'disabled' : '') + '>&lsaquo; Prev</button>';

      var startPage = Math.max(1, currentPage - 2);
      var endPage = Math.min(totalPages, startPage + 4);
      for (var p = startPage; p <= endPage; p++) {
        html += '<button onclick="loadCallHistory(' + p + ')" class="' + (p === currentPage ? 'active' : '') + '">' + p + '</button>';
      }

      html += '<button onclick="loadCallHistory(' + (currentPage + 1) + ')" ' + (currentPage === totalPages ? 'disabled' : '') + '>Next &rsaquo;</button>';
      html += '<button onclick="loadCallHistory(' + totalPages + ')" ' + (currentPage === totalPages ? 'disabled' : '') + '>&raquo;</button>';
      html += '<span class="page-info">' + total + ' calls</span>';
      html += '</div>';
    }

    callHistory.innerHTML = html;

    var uniqueCallers = [...new Set(calls.map(function(c) { return c.caller_number; }))];
    for (var i = 0; i < uniqueCallers.length; i++) {
      var phone = uniqueCallers[i];
      fetchNextMeeting(phone, calls.filter(function(c) { return c.caller_number === phone; }).map(function(c) { return c.id; }));
    }
  } catch (err) {
    console.error('Failed to load call history:', err);
  }
}

async function fetchNextMeeting(phone, callIds) {
  try {
    var res = await fetch('/api/next-meeting/' + encodeURIComponent(phone));
    var data = await res.json();
    var els = callIds.map(function(id) { return document.getElementById('meeting-' + id); }).filter(Boolean);

    if (data.patientName) {
      callIds.forEach(function(id) {
        var nameEl = document.getElementById('name-' + id);
        if (nameEl && nameEl.textContent === '--') {
          nameEl.textContent = data.patientName;
          nameEl.className = 'meeting-badge upcoming';
        }
      });
    }

    if (data.error === 'Clinicea API not configured') {
      els.forEach(function(el) { el.textContent = 'Not configured'; el.className = 'meeting-badge none'; });
      return;
    }

    if (data.nextMeeting) {
      var apt = data.nextMeeting;
      var dateStr = apt.StartDateTime || apt.startDateTime || apt.AppointmentDateTime || apt.appointmentDateTime || '';
      if (dateStr) {
        var d = new Date(dateStr);
        var formatted = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        var label = apt.ServiceName ? formatted + ' - ' + apt.ServiceName : formatted;
        els.forEach(function(el) { el.textContent = label; el.className = 'meeting-badge upcoming'; });
      } else {
        els.forEach(function(el) { el.textContent = 'No upcoming'; el.className = 'meeting-badge none'; });
      }
    } else {
      els.forEach(function(el) { el.textContent = 'No upcoming'; el.className = 'meeting-badge none'; });
    }
  } catch (err) {
    var els = callIds.map(function(id) { return document.getElementById('meeting-' + id); }).filter(Boolean);
    els.forEach(function(el) { el.textContent = 'Error'; el.className = 'meeting-badge none'; });
  }
}

// ===== TEST CALL =====
window.sendTestCall = async function() {
  var phone = prompt('Enter test phone number:', '+920300000000');
  if (!phone) return;
  try {
    var res = await fetch('/api/test-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone })
    });
    var data = await res.json();
    console.log('[Dashboard] Test call response:', data);
  } catch (e) {
    console.error('[Dashboard] Test call failed:', e);
    alert('Test call failed: ' + e.message);
  }
};

// --- OWNERSHIP CHECK: is this event for the current logged-in user? ---
function isEventForMe(data) {
  // Identity not loaded yet — reject to prevent leaks (call history loads on next refresh)
  if (!myUsername || !myRole) {
    console.log('[Dashboard] Event rejected — identity not loaded yet');
    return false;
  }
  // Admin sees everything (including untagged)
  if (myRole === 'admin') return true;
  // STRICT: agents only see events tagged to them — never untagged events
  if (!data.agent || data.agent !== myUsername) {
    console.log('[Dashboard] Event rejected — agent mismatch or untagged | event.agent:', data.agent, 'me:', myUsername);
    return false;
  }
  return true;
}

// ===== CALENDAR =====
// ===== CALENDAR FILTERS =====
function filterCalendar() {
  if (!window._calAppointments) return;
  var search = (document.getElementById('calSearchInput').value || '').toLowerCase().trim();
  var statusFilter = document.getElementById('calStatusFilter').value;
  var doctorFilter = document.getElementById('calDoctorFilter').value;
  var serviceFilter = document.getElementById('calServiceFilter').value;

  var cards = document.querySelectorAll('#calendarList .calendar-card');
  var shown = 0, total = cards.length;

  cards.forEach(function(card) {
    var name = (card.getAttribute('data-name') || '').toLowerCase();
    var status = card.getAttribute('data-status') || '';
    var doctor = card.getAttribute('data-doctor') || '';
    var service = card.getAttribute('data-service') || '';

    var match = true;
    if (search && !name.includes(search)) match = false;
    if (statusFilter && status !== statusFilter) match = false;
    if (doctorFilter && doctor !== doctorFilter) match = false;
    if (serviceFilter && service !== serviceFilter) match = false;

    card.style.display = match ? '' : 'none';
    if (match) shown++;
  });

  var countLabel = document.getElementById('calFilterCount');
  if (search || statusFilter || doctorFilter || serviceFilter) {
    countLabel.textContent = shown + ' of ' + total;
  } else {
    countLabel.textContent = '';
  }
}

function clearCalendarFilters() {
  document.getElementById('calSearchInput').value = '';
  document.getElementById('calStatusFilter').value = '';
  document.getElementById('calDoctorFilter').value = '';
  document.getElementById('calServiceFilter').value = '';
  document.getElementById('calFilterCount').textContent = '';
  var cards = document.querySelectorAll('#calendarList .calendar-card');
  cards.forEach(function(card) { card.style.display = ''; });
}

function calendarToday() {
  var today = new Date();
  document.getElementById('calendarDate').value = today.toISOString().split('T')[0];
  loadCalendar();
}

function calendarPrevDay() {
  var input = document.getElementById('calendarDate');
  var d = new Date(input.value);
  d.setDate(d.getDate() - 1);
  input.value = d.toISOString().split('T')[0];
  loadCalendar();
}

function calendarNextDay() {
  var input = document.getElementById('calendarDate');
  var d = new Date(input.value);
  d.setDate(d.getDate() + 1);
  input.value = d.toISOString().split('T')[0];
  loadCalendar();
}

async function loadCalendar() {
  var date = document.getElementById('calendarDate').value;
  if (!date) return;

  var dateObj = new Date(date + 'T00:00:00');
  document.getElementById('calendarDateLabel').textContent =
    dateObj.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  var listEl = document.getElementById('calendarList');
  var countEl = document.getElementById('calendarCount');

  listEl.innerHTML = '<div class="empty-state"><div class="modal-loading"><div class="spinner"></div><p>Loading appointments...</p></div></div>';
  countEl.textContent = '';

  try {
    var data = await safeFetch('/api/appointments-by-date?date=' + encodeURIComponent(date));

    if (data.error && data.error !== 'Clinicea API not configured') {
      listEl.innerHTML = '<div class="empty-state"><p>Error: ' + escapeHtml(data.error) + '</p></div>';
      return;
    }

    var appointments = data.appointments || [];
    // Store for filtering
    window._calAppointments = appointments;
    window._calDate = date;

    countEl.textContent = appointments.length + ' appointment' + (appointments.length !== 1 ? 's' : '');

    if (appointments.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><p>No appointments for this date</p></div>';
      document.getElementById('calendarFilters').style.display = 'none';
      return;
    }

    // Show filters and populate doctor/service dropdowns
    document.getElementById('calendarFilters').style.display = 'flex';
    var doctors = {}, services = {};
    appointments.forEach(function(a) {
      if (a.doctor) doctors[a.doctor] = true;
      if (a.service) services[a.service] = true;
    });
    var docSel = document.getElementById('calDoctorFilter');
    var curDoc = docSel.value;
    docSel.innerHTML = '<option value="">All Doctors</option>' + Object.keys(doctors).map(function(d) { return '<option value="' + escapeHtml(d) + '">' + escapeHtml(d) + '</option>'; }).join('');
    docSel.value = curDoc;
    var svcSel = document.getElementById('calServiceFilter');
    var curSvc = svcSel.value;
    svcSel.innerHTML = '<option value="">All Services</option>' + Object.keys(services).map(function(s) { return '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>'; }).join('');
    svcSel.value = curSvc;

    // Sort by start time
    appointments.sort(function(a, b) { return new Date(a.startTime || 0) - new Date(b.startTime || 0); });

    var html = '';
    appointments.forEach(function(apt) {
      var status = (apt.status || 'unknown').toLowerCase();
      var statusClass = 'status-scheduled';
      var aptStatusBadge = 'scheduled';
      if (status.includes('engaged') || status.includes('in progress')) { statusClass = 'status-engaged'; aptStatusBadge = 'engaged'; }
      else if (status.includes('confirm')) { statusClass = 'status-confirmed'; aptStatusBadge = 'confirmed'; }
      else if (status.includes('check') && status.includes('out')) { statusClass = 'status-checkout'; aptStatusBadge = 'checkout'; }
      else if (status.includes('complet') || status.includes('checked') || status.includes('arrived')) { statusClass = 'status-completed'; aptStatusBadge = 'completed'; }
      else if (status.includes('cancel')) { statusClass = 'status-cancelled'; aptStatusBadge = 'cancelled'; }
      else if (status.includes('no show') || status.includes('noshow')) { statusClass = 'status-cancelled'; aptStatusBadge = 'noshow'; }
      else if (status.includes('schedul')) { statusClass = 'status-scheduled'; aptStatusBadge = 'scheduled'; }

      var timeStr = formatTime(apt.startTime);
      var endTimeStr = apt.endTime ? ' - ' + formatTime(apt.endTime) : '';
      var durationStr = apt.duration ? ' (' + apt.duration + ' min)' : '';

      // Message tracking badges — per appointment, from DB flags
      var trackInfo = {
        confirmationSent: !!apt.confirmationSent,
        reminderSent: !!apt.reminderSent,
        reviewSent: !!apt.reviewSent,
        aftercareSent: !!apt.aftercareSent,
      };
      var msgBadges = '';
      if (trackInfo) {
        if (trackInfo.confirmationSent) msgBadges += '<span style="background:#2ecc71;color:white;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px;">Confirmed</span>';
        if (trackInfo.reminderSent) msgBadges += '<span style="background:#3498db;color:white;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px;">Reminded</span>';
        if (trackInfo.reviewSent) msgBadges += '<span style="background:#8b5cf6;color:white;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px;">Review Sent</span>';
        if (trackInfo.aftercareSent) msgBadges += '<span style="background:#059669;color:white;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px;">Aftercare Sent</span>';
      }

      html += '<div class="calendar-card ' + statusClass + '" data-name="' + escapeHtml(apt.patientName) + '" data-status="' + aptStatusBadge + '" data-doctor="' + escapeHtml(apt.doctor || '') + '" data-service="' + escapeHtml(apt.service || '') + '" data-apt-id="' + escapeHtml(String(apt.appointmentID || '')) + '" onclick="openProfileById(\'' + escapeHtml(String(apt.patientID)) + '\', \'' + escapeHtml(apt.patientName) + '\')">';
      html += '<div class="calendar-card-left">';
      html += '<h4>' + escapeHtml(apt.patientName) + '</h4>';
      html += '<p>' + escapeHtml(apt.service || 'Appointment');
      if (apt.doctor) html += ' &middot; ' + escapeHtml(apt.doctor);
      html += '</p>';
      if (msgBadges) html += '<div style="margin-top:4px;">' + msgBadges + '</div>';
      html += '</div>';
      html += '<div class="calendar-card-right">';
      html += '<span class="calendar-time">' + escapeHtml(timeStr + endTimeStr + durationStr) + '</span>';
      html += '<span class="apt-status ' + aptStatusBadge + '">' + escapeHtml(apt.status) + '</span>';
      var aptPhone = escapeHtml(apt.phone || apt.patientPhone || apt.mobile || '');
      if (aptPhone && aptStatusBadge !== 'cancelled' && aptStatusBadge !== 'noshow') {
        html += '<div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;">';
        if (aptStatusBadge === 'checkout' || aptStatusBadge === 'completed') {
          // Post-visit: Review + Aftercare
          html += '<button onclick="event.stopPropagation();calSendReview(\'' + escapeHtml(aptPhone) + '\',\'' + escapeHtml(apt.patientName) + '\',\'' + escapeHtml(apt.service || '') + '\',\'' + escapeHtml(apt.doctor || '') + '\')" style="padding:3px 8px;border:none;border-radius:4px;background:#8b5cf6;color:white;font-size:11px;font-weight:600;cursor:pointer;">Review</button>';
          html += '<button onclick="event.stopPropagation();calSendAftercare(\'' + escapeHtml(aptPhone) + '\',\'' + escapeHtml(apt.patientName) + '\',\'' + escapeHtml(apt.service || '') + '\',\'' + escapeHtml(apt.doctor || '') + '\')" style="padding:3px 8px;border:none;border-radius:4px;background:#059669;color:white;font-size:11px;font-weight:600;cursor:pointer;">Aftercare</button>';
        } else {
          // Pre-visit: Confirm + Remind (pass appointmentID for tracking, hide if already sent)
          if (!trackInfo || !trackInfo.confirmationSent) {
            html += '<button onclick="event.stopPropagation();calSendConfirmation(\'' + escapeHtml(aptPhone) + '\',\'' + escapeHtml(apt.patientName) + '\',\'' + escapeHtml(date) + '\',\'' + escapeHtml(timeStr) + '\',\'' + escapeHtml(apt.service || '') + '\',\'' + escapeHtml(apt.doctor || '') + '\',\'' + escapeHtml(String(apt.appointmentID || '')) + '\')" style="padding:3px 8px;border:none;border-radius:4px;background:#2ecc71;color:white;font-size:11px;font-weight:600;cursor:pointer;">Confirm</button>';
          }
          if (!trackInfo || !trackInfo.reminderSent) {
            html += '<button onclick="event.stopPropagation();calSendReminder(\'' + escapeHtml(aptPhone) + '\',\'' + escapeHtml(apt.patientName) + '\',\'' + escapeHtml(date) + '\',\'' + escapeHtml(timeStr) + '\',\'' + escapeHtml(apt.service || '') + '\',\'' + escapeHtml(apt.doctor || '') + '\',\'' + escapeHtml(String(apt.appointmentID || '')) + '\')" style="padding:3px 8px;border:none;border-radius:4px;background:#f39c12;color:white;font-size:11px;font-weight:600;cursor:pointer;">Remind</button>';
          }
        }
        html += '<button onclick="event.stopPropagation();calSendMessage(\'' + escapeHtml(aptPhone) + '\',\'' + escapeHtml(apt.patientName) + '\')" style="padding:3px 8px;border:none;border-radius:4px;background:#3498db;color:white;font-size:11px;font-weight:600;cursor:pointer;">Message</button>';
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
    });

    listEl.innerHTML = html;
  } catch (err) {
    listEl.innerHTML = '<div class="empty-state"><p>Failed to load appointments</p></div>';
    console.error('Calendar load error:', err);
  }
}

// ===== CALENDAR: IN-PLACE CARD UPDATE AFTER SEND =====
function markCalendarCardSent(appointmentId, type) {
  var card = document.querySelector('.calendar-card[data-apt-id="' + appointmentId + '"]');
  if (!card) return;

  // Add "Queued" badge to the card
  var leftDiv = card.querySelector('.calendar-card-left');
  if (leftDiv) {
    // Remove existing badge container if re-sending
    var existingBadges = leftDiv.querySelector('.msg-badges');
    if (!existingBadges) {
      existingBadges = document.createElement('div');
      existingBadges.className = 'msg-badges';
      existingBadges.style.cssText = 'margin-top:4px;';
      leftDiv.appendChild(existingBadges);
    }

    var badgeColor = type === 'confirmation' ? '#2ecc71' : type === 'reminder' ? '#3498db' : '#8b5cf6';
    var badgeLabel = type === 'confirmation' ? 'Confirmation Queued' : type === 'reminder' ? 'Reminder Queued' : type.charAt(0).toUpperCase() + type.slice(1) + ' Queued';
    var badge = document.createElement('span');
    badge.style.cssText = 'background:' + badgeColor + ';color:white;font-size:9px;padding:2px 6px;border-radius:3px;margin-right:4px;';
    badge.textContent = badgeLabel;
    existingBadges.appendChild(badge);
  }

  // Hide the button that was just clicked (Confirm/Remind)
  var buttons = card.querySelectorAll('button');
  buttons.forEach(function(btn) {
    var text = btn.textContent.toLowerCase();
    if (type === 'confirmation' && text === 'confirm') btn.style.display = 'none';
    if (type === 'reminder' && text === 'remind') btn.style.display = 'none';
    if (type === 'review' && text === 'review') btn.style.display = 'none';
    if (type === 'aftercare' && text === 'aftercare') btn.style.display = 'none';
  });

  // Move card to bottom of the list
  var parent = card.parentElement;
  if (parent) {
    parent.appendChild(card);
  }

  // Dim the card slightly to show it's been handled
  card.style.opacity = '0.7';
}

// ===== PATIENTS =====
function onPatientSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(function() {
    patientsPage = 1;
    loadPatients(1);
  }, 300);
}

async function loadPatients(page) {
  if (patientsLoading) return;
  patientsLoading = true;

  var search = document.getElementById('patientSearch').value.trim();
  var gridEl = document.getElementById('patientsGrid');
  var paginationEl = document.getElementById('patientsPagination');
  var loadingEl = document.getElementById('patientsLoading');
  var emptyEl = document.getElementById('patientsEmpty');
  var countEl = document.getElementById('patientsCount');

  gridEl.innerHTML = '';
  loadingEl.style.display = 'block';
  emptyEl.style.display = 'none';
  paginationEl.style.display = 'none';

  try {
    var sort = (document.getElementById('patientSort') || {}).value || 'recent';
    var doctor = (document.getElementById('patientDoctorFilter') || {}).value || '';
    var service = (document.getElementById('patientServiceFilter') || {}).value || '';
    var url = '/api/patients?page=' + page + '&pageSize=50&sort=' + sort +
      (search ? '&search=' + encodeURIComponent(search) : '') +
      (doctor ? '&doctor=' + encodeURIComponent(doctor) : '') +
      (service ? '&service=' + encodeURIComponent(service) : '');
    var res = await fetch(url);
    var data = await res.json();

    if (data.loading) {
      loadingEl.style.display = 'block';
      loadingEl.querySelector('p').textContent = 'Loading patients from Clinicea... Please wait.';
      patientsLoading = false;
      setTimeout(function() { loadPatients(page); }, 3000);
      return;
    }

    if (data.error && data.error !== 'Clinicea API not configured') {
      loadingEl.style.display = 'none';
      emptyEl.style.display = 'block';
      emptyEl.querySelector('p').textContent = 'Error: ' + data.error;
      patientsLoading = false;
      return;
    }

    var patients = data.patients || [];
    var total = data.total || 0;
    var totalPages = Math.ceil(total / 50);
    patientsPage = page;

    countEl.textContent = total > 0 ? '(' + total + ')' : '';

    // Populate filter dropdowns (preserve current selection)
    var docSel = document.getElementById('patientDoctorFilter');
    var svcSel = document.getElementById('patientServiceFilter');
    if (docSel && data.doctors && data.doctors.length > 0) {
      var curDoc = docSel.value;
      docSel.innerHTML = '<option value="">All Doctors</option>' + data.doctors.map(function(d) { return '<option value="' + escapeHtml(d) + '">' + escapeHtml(d) + '</option>'; }).join('');
      docSel.value = curDoc;
    }
    if (svcSel && data.services && data.services.length > 0) {
      var curSvc = svcSel.value;
      svcSel.innerHTML = '<option value="">All Services</option>' + data.services.map(function(s) { return '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>'; }).join('');
      svcSel.value = curSvc;
    }

    // Render patient table
    var html = '<div class="call-table"><table><thead><tr>' +
      '<th>Patient</th><th>Doctor</th><th>Service</th><th>Last Appt</th><th>Actions</th>' +
      '</tr></thead><tbody>';

    patients.forEach(function(p) {
      var initials = getInitials(p.name);
      var lastAppt = p._lastAppointment ? new Date(p._lastAppointment).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : (p.createdDate ? new Date(p.createdDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-');
      var localId = p._local ? p.patientID.replace('local-', '') : '';
      var phoneLine = p.phone ? '<span style="font-family:monospace;font-size:11px;color:#64748b;">' + escapeHtml(p.phone) + '</span>' : '';
      var emailLine = p.email ? '<span style="font-size:11px;color:#94a3b8;">' + escapeHtml(p.email) + '</span>' : '';
      var subLine = [phoneLine, emailLine].filter(Boolean).join(' · ');

      html += '<tr style="cursor:pointer;" onclick="openProfileById(\'' + escapeHtml(String(p.patientID)) + '\',\'' + escapeHtml(p.name) + '\')">' +
        '<td><div style="display:flex;align-items:center;gap:10px;">' +
          '<div style="width:34px;height:34px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#475569;flex-shrink:0;">' + escapeHtml(initials) + '</div>' +
          '<div><strong style="color:#0f172a;font-size:13px;">' + escapeHtml(p.name) + '</strong>' +
            (subLine ? '<div style="margin-top:1px;">' + subLine + '</div>' : '') +
          '</div>' +
        '</div></td>' +
        '<td style="font-size:12px;color:#334155;">' + escapeHtml(p._doctor || '-') + '</td>' +
        '<td style="font-size:12px;color:#334155;">' + escapeHtml(p._service || '-') + '</td>' +
        '<td style="font-size:12px;color:#94a3b8;">' + lastAppt + '</td>' +
        '<td><div style="display:flex;gap:4px;">' +
          (localId ? '<button onclick="event.stopPropagation();editPatient(' + localId + ',\'' + escapeHtml(p.name) + '\',\'' + escapeHtml(p.phone || '') + '\',\'' + escapeHtml(p.email || '') + '\')" style="padding:3px 8px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;color:#3b82f6;font-size:10px;cursor:pointer;">Edit</button>' : '') +
          (p.phone ? '<a href="https://wa.me/' + (p.phone || '').replace(/[^0-9]/g, '') + '" target="_blank" onclick="event.stopPropagation();" style="padding:3px 8px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;color:#16a34a;font-size:10px;text-decoration:none;cursor:pointer;">WA</a>' : '') +
        '</div></td>' +
      '</tr>';
    });

    html += '</tbody></table></div>';
    gridEl.innerHTML = html;

    loadingEl.style.display = 'none';

    if (patients.length === 0) {
      emptyEl.style.display = 'block';
      paginationEl.style.display = 'none';
    } else {
      emptyEl.style.display = 'none';
      if (totalPages > 1) {
        var pagHtml = '';
        pagHtml += '<button onclick="loadPatients(1)" ' + (patientsPage === 1 ? 'disabled' : '') + '>&laquo;</button>';
        pagHtml += '<button onclick="loadPatients(' + (patientsPage - 1) + ')" ' + (patientsPage === 1 ? 'disabled' : '') + '>&lsaquo; Prev</button>';
        var startPage = Math.max(1, patientsPage - 2);
        var endPage = Math.min(totalPages, startPage + 4);
        for (var pg = startPage; pg <= endPage; pg++) {
          pagHtml += '<button onclick="loadPatients(' + pg + ')" class="' + (pg === patientsPage ? 'active' : '') + '">' + pg + '</button>';
        }
        pagHtml += '<button onclick="loadPatients(' + (patientsPage + 1) + ')" ' + (patientsPage === totalPages ? 'disabled' : '') + '>Next &rsaquo;</button>';
        pagHtml += '<button onclick="loadPatients(' + totalPages + ')" ' + (patientsPage === totalPages ? 'disabled' : '') + '>&raquo;</button>';
        pagHtml += '<span class="page-info">Page ' + patientsPage + ' of ' + totalPages + '</span>';
        paginationEl.innerHTML = pagHtml;
        paginationEl.style.display = 'flex';
      } else {
        paginationEl.style.display = 'none';
      }
    }
  } catch (err) {
    loadingEl.style.display = 'none';
    emptyEl.style.display = 'block';
    emptyEl.querySelector('p').textContent = 'Failed to load patients';
    console.error('Patients load error:', err);
  }

  patientsLoading = false;
}

// ===== WHATSAPP API =====
function loadWaStats() {
  waFetch('/api/whatsapp/stats')
    .then(function(data) {
      document.getElementById('waTotalMessages').textContent = data.totalMessages || 0;
      document.getElementById('waTodayMessages').textContent = data.todayMessages || 0;
      document.getElementById('waConfirmations').textContent = data.totalConfirmations || 0;
      document.getElementById('waReminders').textContent = data.totalReminders || 0;
      document.getElementById('waPending').textContent = data.pendingMessages || 0;

      // Failed + expired messages card
      var failed = (data.failedMessages || 0) + (data.expiredMessages || 0);
      var failedCard = document.getElementById('waFailedCard');
      if (failed > 0) {
        failedCard.style.display = '';
        document.getElementById('waFailed').textContent = failed;
      } else {
        failedCard.style.display = 'none';
      }

      // Global bot toggle state
      waUpdateBotToggle(data.botEnabled !== false);

      // WhatsApp connection status
      if (data.waConnectionStatus && typeof waUpdateConnectionUI === 'function') {
        waUpdateConnectionUI(data.waConnectionStatus);
      }

      // Load business hours
      if (typeof waInitBusinessHours === 'function') waInitBusinessHours();
      waFetch('/api/whatsapp/bot-status').then(function(status) {
        if (status.businessHoursStart !== undefined && typeof waUpdateBusinessHours === 'function') {
          waUpdateBusinessHours(status.businessHoursStart, status.businessHoursEnd);
        }
      }).catch(function() {});

      // Load approval queue
      loadWaApprovalQueue();
    })
    .catch(function() {});
}

function loadWaApprovalQueue() {
  waFetch('/api/whatsapp/pending-approval')
    .then(function(data) {
      var section = document.getElementById('waApprovalSection');
      var container = document.getElementById('waApprovalQueue');
      var countBadge = document.getElementById('waApprovalCount');
      var msgs = data.messages || [];

      if (msgs.length === 0) {
        section.style.display = 'none';
        return;
      }

      section.style.display = '';
      countBadge.textContent = msgs.length;

      container.innerHTML = msgs.map(function(m) {
        var time = new Date(m.created_at + 'Z').toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
        var preview = escapeHtml((m.message || '').substring(0, 150));
        if (m.message && m.message.length > 150) preview += '...';
        var fullMsg = escapeHtml(m.message || '').replace(/\n/g, '<br>');
        var typeTag = m.message_type !== 'chat' ? '<span style="background:rgba(52,152,219,0.2);color:#3498db;font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px;">' + m.message_type + '</span>' : '';
        return '<div style="background:#fff;border:1px solid rgba(243,156,18,0.35);border-radius:8px;padding:12px;margin-bottom:8px;color:#222;">' +
          '<div style="display:flex;justify-content:space-between;align-items:start;gap:10px;">' +
            '<div style="flex:1;min-width:0;cursor:pointer;" onclick="this.querySelector(\'.wa-preview\').style.display=this.querySelector(\'.wa-preview\').style.display===\'none\'?\'block\':\'none\';this.querySelector(\'.wa-full\').style.display=this.querySelector(\'.wa-full\').style.display===\'none\'?\'block\':\'none\';">' +
              '<div style="font-weight:600;font-size:13px;color:#333;">' + ((m.patient_name || m.chat_name) ? escapeHtml(m.patient_name || m.chat_name) + ' <span style="font-weight:400;color:#888;">(' + escapeHtml(m.phone) + ')</span>' : escapeHtml(m.phone)) + typeTag + '</div>' +
              '<div style="font-size:11px;color:#888;margin-top:2px;">' + time + (m.agent ? ' by ' + m.agent : ' (AI)') + '</div>' +
              '<div class="wa-preview" style="font-size:13px;margin-top:6px;color:#444;white-space:pre-wrap;word-break:break-word;">' + preview + '</div>' +
              '<div class="wa-full" style="display:none;font-size:13px;margin-top:6px;color:#222;white-space:pre-wrap;word-break:break-word;border-top:1px solid #eee;padding-top:8px;">' + fullMsg + '</div>' +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">' +
              '<button onclick="event.stopPropagation();waApproveMessage(' + m.id + ')" style="padding:5px 14px;border:none;border-radius:4px;background:#2ecc71;color:white;font-size:12px;font-weight:600;cursor:pointer;">Approve</button>' +
              '<button onclick="event.stopPropagation();waRejectMessage(' + m.id + ')" style="padding:5px 14px;border:none;border-radius:4px;background:#e74c3c;color:white;font-size:12px;font-weight:600;cursor:pointer;">Reject</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    })
    .catch(function() {});
}

function loadWaPausedChats() {
  return waFetch('/api/whatsapp/paused').then(function(data) {
    waPausedChats = new Set(data.pausedChats || []);
  }).catch(function() {});
}

function loadWaConversations() {
  loadWaPausedChats().then(function() {
    waFetch('/api/whatsapp/conversations')
      .then(function(data) {
        var container = document.getElementById('waConversations');
        if (!data.conversations || data.conversations.length === 0) {
          container.innerHTML = '<div class="empty-state"><p>No WhatsApp conversations yet. Install the Chrome extension and open WhatsApp Web to get started.</p></div>';
          return;
        }
        container.innerHTML = data.conversations.map(function(c) {
          var displayName = c.patient_name || c.chat_name || c.phone;
          var initials = displayName.substring(0, 2).toUpperCase();
          var name = c.patient_name ? c.patient_name + (c.chat_name && c.chat_name !== c.patient_name ? ' (' + c.chat_name + ')' : '') : (c.chat_name || c.phone);
          var time = new Date(c.last_message_at + 'Z').toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
          var lastMsg = (c.last_message || '').substring(0, 60);
          var isPaused = waPausedChats.has(c.phone) || waPausedChats.has(c.chat_name);
          var pausedBadge = isPaused ? '<span style="background:#e74c3c;color:white;font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px;">BOT OFF</span>' : '';
          return '<div class="wa-convo-item" onclick="waOpenChat(\'' + c.phone.replace(/'/g, "\\'") + '\', \'' + (c.chat_name || c.phone).replace(/'/g, "\\'") + '\')">' +
            '<div class="wa-convo-avatar">' + initials + '</div>' +
            '<div class="wa-convo-info">' +
              '<div class="wa-convo-name">' + escapeHtml(name) + pausedBadge + '</div>' +
              '<div class="wa-convo-last">' + escapeHtml(lastMsg) + '</div>' +
            '</div>' +
            '<div style="text-align:right;">' +
              '<div class="wa-convo-time">' + time + '</div>' +
              '<div class="wa-convo-count">' + c.message_count + '</div>' +
            '</div>' +
          '</div>';
        }).join('');
      })
      .catch(function() {});
  });
}
