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
      html += '<button onclick="document.getElementById(\'qmText\').value=\'' + t.text.replace(/'/g, "\\'") + '\'" style="text-align:left;padding:8px 12px;border:1px solid #e2e8f0;border-radius:6px;background:#f8fafc;color:#334155;font-size:12px;cursor:pointer;font-family:inherit;">' + escapeHtml(t.label) + '</button>';
    }
  });
  html += '</div>';

  html += '<textarea id="qmText" rows="3" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;resize:vertical;box-sizing:border-box;font-family:inherit;" placeholder="Type or select a template above..."></textarea>';
  html += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">';
  html += '<button onclick="document.getElementById(\'quickMsgModal\').remove()" style="padding:8px 16px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#64748b;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>';
  html += '<button onclick="sendQuickMessage(\'' + escapeHtml(agent) + '\')" style="padding:8px 16px;border:none;border-radius:6px;background:#3b82f6;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">Send</button>';
  html += '</div></div>';

  ov.innerHTML = html;
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

// ===== TOGGLE CALL DIRECTION =====
function toggleCallDirection(callId, newDirection) {
  fetch('/api/calls/' + callId + '/direction', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ direction: newDirection }) })
    .then(function() { loadCallHistory(); })
    .catch(function() {});
}

// ===== CALL DISPOSITION =====
function setCallDisposition(callId, disposition) {
  if (!disposition) return;
  fetch('/api/calls/' + callId + '/disposition', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ disposition: disposition }) }).catch(function() {});
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

// Populate agent filter dropdown (admin only)
function loadAgentFilterOptions() {
  if (myRole !== 'admin') return;
  var sel = document.getElementById('filterAgent');
  if (!sel) return;
  sel.style.display = '';
  waFetch('/api/agents').then(function(data) {
    var opts = '<option value="">All Agents</option>';
    (data.agents || []).forEach(function(a) {
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
      var displayNumber = call.caller_number && call.caller_number.indexOf('contact:') === 0
        ? call.caller_number.slice(8)
        : call.caller_number;
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

      html += '<tr data-call-id="' + call.id + '">' +
        '<td>' + call.id + '</td>' +
        '<td>' + dirBadge + '</td>' +
        '<td>' +
          '<span class="caller-number-wrap">' +
            '<strong>' + escapeHtml(displayNumber) + '</strong>' +
            '<a href="' + waUrl + '" target="_blank" class="whatsapp-link" title="Message on WhatsApp">' + whatsappSvg + '</a>' +
          '</span>' +
        '</td>' +
        '<td>' + nameDisplay + '</td>' +
        '<td><strong style="color:#334155;font-size:12px;">' + escapeHtml(call.agent || '-') + '</strong></td>' +
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

// ===== VIEW MONITOR LOG =====
window.viewMonitorLog = async function() {
  try {
    // First check which agents have logs
    var listRes = await fetch('/api/monitor-log');
    var agents = await listRes.json();
    var agent = '_default';
    if (myUsername && myRole !== 'admin') {
      agent = myUsername;
    } else if (agents.length > 0) {
      agent = agents.map(function(a) { return a.agent + ' (' + a.lines + ' lines)'; }).join(', ');
      var pick = prompt('Available logs: ' + agent + '\nEnter agent name:', agents[0].agent);
      if (!pick) return;
      agent = pick.trim();
    }
    var res = await fetch('/api/monitor-log/' + encodeURIComponent(agent));
    var text = await res.text();
    var w = window.open('', 'monitor_log', 'width=900,height=600');
    w.document.write('<html><head><title>Monitor Log: ' + agent + '</title></head><body style="background:#1a1a2e;color:#0f0;font-family:monospace;font-size:13px;padding:16px;white-space:pre-wrap;">' + text.replace(/</g,'&lt;') + '</body></html>');
  } catch (e) {
    alert('Failed to load monitor log: ' + e.message);
  }
};

// ===== MONITOR STATUS =====
function setMonitorStatus(alive) {
  if (alive) {
    monitorDot.classList.add('connected');
    monitorText.textContent = 'Monitor: On';
  } else {
    monitorDot.classList.remove('connected');
    monitorText.textContent = 'Monitor: Off';
  }
}

async function checkMonitorStatus() {
  try {
    var data = await safeFetch('/api/monitor-status');
    setMonitorStatus(data.alive);
  } catch (e) { setMonitorStatus(false); }
}

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
    var data = await safeFetch('/api/appointments-by-date?date=' + encodeURIComponent(date) + '&refresh=1');

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

    // Fetch message tracking status
    var tracking = {};
    try {
      var trackRes = await waFetch('/api/whatsapp/tracking-status');
      tracking = trackRes.tracking || {};
    } catch (e) { /* ignore — just won't show badges */ }

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

      // Message tracking badges
      var aptPhone = (apt.phone || apt.patientPhone || apt.mobile || '').replace(/[\s\-()]/g, '');
      var trackInfo = tracking[aptPhone] || tracking['+' + aptPhone] || null;
      // Also try with + prefix stripped
      if (!trackInfo && aptPhone.startsWith('+')) trackInfo = tracking[aptPhone.substring(1)] || null;
      var msgBadges = '';
      if (trackInfo) {
        if (trackInfo.confirmationSent) msgBadges += '<span style="background:#2ecc71;color:white;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px;">Confirmed</span>';
        if (trackInfo.reminderSent) msgBadges += '<span style="background:#3498db;color:white;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px;">Reminded</span>';
      }

      html += '<div class="calendar-card ' + statusClass + '" data-name="' + escapeHtml(apt.patientName) + '" data-status="' + aptStatusBadge + '" data-doctor="' + escapeHtml(apt.doctor || '') + '" data-service="' + escapeHtml(apt.service || '') + '" onclick="openProfileById(\'' + escapeHtml(String(apt.patientID)) + '\', \'' + escapeHtml(apt.patientName) + '\')">';
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
          // Pre-visit: Confirm + Remind
          html += '<button onclick="event.stopPropagation();calSendConfirmation(\'' + escapeHtml(aptPhone) + '\',\'' + escapeHtml(apt.patientName) + '\',\'' + escapeHtml(date) + '\',\'' + escapeHtml(timeStr) + '\',\'' + escapeHtml(apt.service || '') + '\',\'' + escapeHtml(apt.doctor || '') + '\')" style="padding:3px 8px;border:none;border-radius:4px;background:#2ecc71;color:white;font-size:11px;font-weight:600;cursor:pointer;">Confirm</button>';
          html += '<button onclick="event.stopPropagation();calSendReminder(\'' + escapeHtml(aptPhone) + '\',\'' + escapeHtml(apt.patientName) + '\',\'' + escapeHtml(date) + '\',\'' + escapeHtml(timeStr) + '\',\'' + escapeHtml(apt.service || '') + '\',\'' + escapeHtml(apt.doctor || '') + '\')" style="padding:3px 8px;border:none;border-radius:4px;background:#f39c12;color:white;font-size:11px;font-weight:600;cursor:pointer;">Remind</button>';
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
    var url = '/api/patients?page=' + page + '&pageSize=50' + (search ? '&search=' + encodeURIComponent(search) : '');
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

    countEl.textContent = total > 0 ? total + ' patients' : '';

    // Render patient cards
    patients.forEach(function(p) {
      var card = document.createElement('div');
      card.className = 'patient-card';
      card.onclick = function() { openProfileById(p.patientID, p.name); };

      var initials = getInitials(p.name);
      var contactLine = [p.phone, p.email].filter(Boolean).join(' | ') || 'No contact info';

      card.innerHTML =
        '<div class="patient-card-avatar">' + escapeHtml(initials) + '</div>' +
        '<div class="patient-card-info">' +
          '<h4>' + escapeHtml(p.name) + '</h4>' +
          '<p>' + escapeHtml(contactLine) + '</p>' +
        '</div>';
      gridEl.appendChild(card);
    });

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
        var time = new Date(m.created_at).toLocaleString();
        var preview = escapeHtml((m.message || '').substring(0, 150));
        if (m.message && m.message.length > 150) preview += '...';
        var fullMsg = escapeHtml(m.message || '').replace(/\n/g, '<br>');
        var typeTag = m.message_type !== 'chat' ? '<span style="background:rgba(52,152,219,0.2);color:#3498db;font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px;">' + m.message_type + '</span>' : '';
        return '<div style="background:#fff;border:1px solid rgba(243,156,18,0.35);border-radius:8px;padding:12px;margin-bottom:8px;color:#222;">' +
          '<div style="display:flex;justify-content:space-between;align-items:start;gap:10px;">' +
            '<div style="flex:1;min-width:0;cursor:pointer;" onclick="this.querySelector(\'.wa-preview\').style.display=this.querySelector(\'.wa-preview\').style.display===\'none\'?\'block\':\'none\';this.querySelector(\'.wa-full\').style.display=this.querySelector(\'.wa-full\').style.display===\'none\'?\'block\':\'none\';">' +
              '<div style="font-weight:600;font-size:13px;color:#333;">' + escapeHtml(m.phone) + typeTag + '</div>' +
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
          var initials = (c.chat_name || c.phone || '?').substring(0, 2).toUpperCase();
          var name = c.chat_name || c.phone;
          var time = new Date(c.last_message_at).toLocaleString();
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
