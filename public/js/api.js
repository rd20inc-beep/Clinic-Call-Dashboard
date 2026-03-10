// ===== HELPER FUNCTIONS =====
function getWhatsappUrl(phone) {
  return 'https://wa.me/' + phone.replace(/[\s\-\+]/g, '');
}

function escapeHtml(str) {
  var d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
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
          '<th>Caller</th>' +
          '<th>Patient</th>' +
          '<th>Time</th>' +
          '<th>Next Meeting</th>' +
          '<th>Profile</th>' +
        '</tr>' +
      '</thead><tbody>';

    calls.forEach(function(call) {
      var time = new Date(call.timestamp + 'Z').toLocaleString();
      var waUrl = getWhatsappUrl(call.caller_number);
      var nameDisplay = call.patient_name
        ? '<span class="meeting-badge upcoming" id="name-' + call.id + '">' + escapeHtml(call.patient_name) + '</span>'
        : '<span class="meeting-badge loading" id="name-' + call.id + '">--</span>';
      html += '<tr>' +
        '<td>' + call.id + '</td>' +
        '<td>' +
          '<span class="caller-number-wrap">' +
            '<strong>' + escapeHtml(call.caller_number) + '</strong>' +
            '<a href="' + waUrl + '" target="_blank" class="whatsapp-link" title="Message on WhatsApp">' + whatsappSvg + '</a>' +
          '</span>' +
        '</td>' +
        '<td>' + nameDisplay + '</td>' +
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

      html += '<div class="calendar-card ' + statusClass + '" onclick="openProfileById(\'' + escapeHtml(String(apt.patientID)) + '\', \'' + escapeHtml(apt.patientName) + '\')">';
      html += '<div class="calendar-card-left">';
      html += '<h4>' + escapeHtml(apt.patientName) + '</h4>';
      html += '<p>' + escapeHtml(apt.service || 'Appointment');
      if (apt.doctor) html += ' &middot; ' + escapeHtml(apt.doctor);
      html += '</p>';
      html += '</div>';
      html += '<div class="calendar-card-right">';
      html += '<span class="calendar-time">' + escapeHtml(timeStr + endTimeStr + durationStr) + '</span>';
      html += '<span class="apt-status ' + aptStatusBadge + '">' + escapeHtml(apt.status) + '</span>';
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
  fetch('/api/whatsapp/stats')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      document.getElementById('waTotalMessages').textContent = data.totalMessages || 0;
      document.getElementById('waTodayMessages').textContent = data.todayMessages || 0;
      document.getElementById('waConfirmations').textContent = data.totalConfirmations || 0;
      document.getElementById('waReminders').textContent = data.totalReminders || 0;
      document.getElementById('waPending').textContent = data.pendingMessages || 0;
    })
    .catch(function() {});
}

function loadWaPausedChats() {
  return fetch('/api/whatsapp/paused').then(function(r) { return r.json(); }).then(function(data) {
    waPausedChats = new Set(data.pausedChats || []);
  }).catch(function() {});
}

function loadWaConversations() {
  loadWaPausedChats().then(function() {
    fetch('/api/whatsapp/conversations')
      .then(function(r) { return r.json(); })
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
