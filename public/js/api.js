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

// ===== CALL STATS =====
async function loadCallStats() {
  try {
    var res = await fetch('/api/call-stats');
    var data = await res.json();
    var el = document.getElementById('callStats');
    if (!el) return;
    el.innerHTML =
      '<div class="call-stat-card">' +
        '<div class="call-stat-value">' + (data.today.total || 0) + '</div>' +
        '<div class="call-stat-label">Today</div>' +
      '</div>' +
      '<div class="call-stat-card inbound">' +
        '<div class="call-stat-value">' + (data.today.inbound || 0) + '</div>' +
        '<div class="call-stat-label">Inbound</div>' +
      '</div>' +
      '<div class="call-stat-card outbound">' +
        '<div class="call-stat-value">' + (data.today.outbound || 0) + '</div>' +
        '<div class="call-stat-label">Outbound</div>' +
      '</div>' +
      '<div class="call-stat-card answered">' +
        '<div class="call-stat-value">' + (data.today.answered || 0) + '</div>' +
        '<div class="call-stat-label">Answered</div>' +
      '</div>' +
      '<div class="call-stat-card missed">' +
        '<div class="call-stat-value">' + (data.today.missed || 0) + '</div>' +
        '<div class="call-stat-label">Missed</div>' +
      '</div>' +
      '<div class="call-stat-card">' +
        '<div class="call-stat-value">' + formatCallDuration(data.avgDuration) + '</div>' +
        '<div class="call-stat-label">Avg Duration</div>' +
      '</div>';
  } catch (err) {
    console.error('Failed to load call stats:', err);
  }
}

// ===== CALL HISTORY =====
async function loadCallHistory(page) {
  if (page !== undefined) currentPage = page;
  try {
    var res = await fetch('/api/calls?page=' + currentPage + '&limit=10');
    var data = await res.json();
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

      // Direction badge
      var dir = call.direction || 'inbound';
      var dirBadge = dir === 'outbound'
        ? '<span class="call-dir outbound">&#8599; Out</span>'
        : '<span class="call-dir inbound">&#8601; In</span>';

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
        '<td><span id="status-' + call.id + '">' + stBadge + '</span></td>' +
        '<td><span id="duration-' + call.id + '">' + durDisplay + '</span></td>' +
        '<td>' + escapeHtml(time) + '</td>' +
        '<td><span class="meeting-badge loading" id="meeting-' + call.id + '">Loading...</span></td>' +
        '<td style="display:flex;gap:6px;align-items:center;">' +
          '<button class="btn-profile" onclick="openProfile(\'' + escapeHtml(call.caller_number) + '\',\'' + escapeHtml(call.clinicea_url) + '\')">View Profile</button>' +
          '<a href="' + escapeHtml(call.clinicea_url) + '" target="_blank" class="btn-clinicea">Clinicea</a>' +
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
    var res = await fetch('/api/monitor-status');
    var data = await res.json();
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
    var res = await fetch('/api/appointments-by-date?date=' + encodeURIComponent(date) + '&refresh=1');
    var data = await res.json();

    if (data.error && data.error !== 'Clinicea API not configured') {
      listEl.innerHTML = '<div class="empty-state"><p>Error: ' + escapeHtml(data.error) + '</p></div>';
      return;
    }

    var appointments = data.appointments || [];
    countEl.textContent = appointments.length + ' appointment' + (appointments.length !== 1 ? 's' : '');

    if (appointments.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><p>No appointments for this date</p></div>';
      return;
    }

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
      var statusClass = 'status-pending';
      if (status.includes('confirm')) statusClass = 'status-confirmed';
      else if (status.includes('cancel')) statusClass = 'status-cancelled';
      else if (status.includes('complet') || status.includes('checked') || status.includes('arrived')) statusClass = 'status-completed';

      var aptStatusBadge = 'pending';
      if (status.includes('confirm')) aptStatusBadge = 'confirmed';
      else if (status.includes('cancel')) aptStatusBadge = 'cancelled';
      else if (status.includes('complet') || status.includes('checked') || status.includes('arrived')) aptStatusBadge = 'completed';

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

      html += '<div class="calendar-card ' + statusClass + '" onclick="openProfileById(\'' + escapeHtml(String(apt.patientID)) + '\', \'' + escapeHtml(apt.patientName) + '\')">';
      html += '<div class="calendar-card-left">';
      html += '<h4>' + escapeHtml(apt.patientName) + msgBadges + '</h4>';
      html += '<p>' + escapeHtml(apt.service || 'Appointment');
      if (apt.doctor) html += ' &middot; ' + escapeHtml(apt.doctor);
      html += '</p>';
      html += '</div>';
      html += '<div class="calendar-card-right">';
      html += '<span class="calendar-time">' + escapeHtml(timeStr + endTimeStr + durationStr) + '</span>';
      html += '<span class="apt-status ' + aptStatusBadge + '">' + escapeHtml(apt.status) + '</span>';
      var aptPhone = escapeHtml(apt.phone || apt.patientPhone || apt.mobile || '');
      if (aptPhone && aptStatusBadge !== 'cancelled') {
        html += '<div style="display:flex;gap:4px;margin-top:6px;">';
        html += '<button onclick="event.stopPropagation();calSendReminder(\'' + escapeHtml(aptPhone) + '\',\'' + escapeHtml(apt.patientName) + '\',\'' + escapeHtml(date) + '\',\'' + escapeHtml(timeStr) + '\',\'' + escapeHtml(apt.service || '') + '\',\'' + escapeHtml(apt.doctor || '') + '\')" style="padding:3px 8px;border:none;border-radius:4px;background:#f39c12;color:white;font-size:11px;font-weight:600;cursor:pointer;">Send Reminder</button>';
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
    var url = '/api/patients?page=' + page + (search ? '&search=' + encodeURIComponent(search) : '');
    var res = await fetch(url);
    var data = await res.json();

    if (data.error && data.error !== 'Clinicea API not configured') {
      loadingEl.style.display = 'none';
      emptyEl.style.display = 'block';
      emptyEl.querySelector('p').textContent = 'Error: ' + data.error;
      patientsLoading = false;
      return;
    }

    var patients = data.patients || [];
    var total = data.total || 0;
    var totalPages = Math.ceil(total / 25);
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
