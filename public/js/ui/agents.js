// ===== AGENT MANAGEMENT UI =====

var agentData = [];
var agentSortBy = 'status';
var agentFilterStatus = 'all';
var agentSearchTerm = '';

// ===== PRESENCE STATUS HELPERS =====
var presenceConfig = {
  online:          { color: '#2ecc71', label: 'Online',          dot: '#2ecc71' },
  busy:            { color: '#e67e22', label: 'Busy',            dot: '#e67e22' },
  idle:            { color: '#f39c12', label: 'Idle',            dot: '#f39c12' },
  offline:         { color: '#95a5a6', label: 'Offline',         dot: '#95a5a6' },
  never_connected: { color: '#bdc3c7', label: 'Never Connected', dot: '#bdc3c7' },
  disabled:        { color: '#e74c3c', label: 'Disabled',        dot: '#e74c3c' },
};

function presenceBadge(status) {
  var cfg = presenceConfig[status] || presenceConfig.offline;
  return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:' + cfg.color + ';background:' + cfg.color + '15;padding:2px 8px;border-radius:10px;"><span style="width:6px;height:6px;border-radius:50%;background:' + cfg.dot + ';display:inline-block;"></span>' + cfg.label + '</span>';
}

// ===== TALK TIME FORMATTER =====
function formatTalkTime(seconds) {
  if (!seconds || seconds <= 0) return '--';
  if (seconds < 60) return seconds + 's';
  var m = Math.floor(seconds / 60);
  var s = seconds % 60;
  if (m < 60) return m + 'm ' + (s > 0 ? s + 's' : '');
  var h = Math.floor(m / 60);
  m = m % 60;
  return h + 'h ' + (m > 0 ? m + 'm' : '');
}

// ===== LAST SEEN FORMATTER =====
function formatLastSeen(ts) {
  if (!ts) return 'Never';
  var now = Date.now();
  var ago = Math.floor((now - ts) / 1000);
  if (ago < 10) return 'Just now';
  if (ago < 60) return ago + ' sec ago';
  if (ago < 3600) return Math.floor(ago / 60) + ' min ago';
  if (ago < 86400) return Math.floor(ago / 3600) + ' hr ago';

  var d = new Date(ts);
  var yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return 'Yesterday ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function lastSeenTooltip(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

// ===== TOAST =====
function agentToast(message, type) {
  var toast = document.createElement('div');
  toast.className = 'error-toast' + (type === 'warn' ? ' warn' : type === 'success' ? ' success' : '');
  toast.innerHTML = escapeHtml(message) + '<button class="error-toast-close" onclick="dismissToast(this)">&times;</button>';
  toastContainer.appendChild(toast);
  setTimeout(function() { if (toast.parentNode) { toast.style.animation = 'toastOut 0.3s ease-in forwards'; setTimeout(function() { toast.remove(); }, 300); } }, 4000);
}

// ===== CONFIRM MODAL =====
function agentConfirm(title, message, btnText, btnColor) {
  return new Promise(function(resolve) {
    var existing = document.getElementById('agentConfirmModal');
    if (existing) existing.remove();
    var overlay = document.createElement('div');
    overlay.id = 'agentConfirmModal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    var modal = document.createElement('div');
    modal.style.cssText = 'background:#fff;border-radius:12px;max-width:400px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.3);';
    modal.innerHTML = '<div style="padding:20px 24px;border-bottom:1px solid #eee;"><div style="font-weight:700;font-size:16px;color:#222;">' + escapeHtml(title) + '</div></div>' +
      '<div style="padding:16px 24px;font-size:14px;color:#555;line-height:1.5;">' + escapeHtml(message) + '</div>' +
      '<div style="padding:12px 24px 20px;display:flex;gap:10px;justify-content:flex-end;">' +
        '<button id="acmCancel" style="padding:8px 20px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#555;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>' +
        '<button id="acmConfirm" style="padding:8px 20px;border:none;border-radius:6px;background:' + (btnColor || '#e74c3c') + ';color:white;font-size:13px;font-weight:600;cursor:pointer;">' + (btnText || 'Confirm') + '</button></div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    overlay.onclick = function(e) { if (e.target === overlay) { overlay.remove(); resolve(false); } };
    document.getElementById('acmCancel').onclick = function() { overlay.remove(); resolve(false); };
    document.getElementById('acmConfirm').onclick = function() { overlay.remove(); resolve(true); };
  });
}

// ===== DATA LOADING =====
function loadAgents() {
  var container = document.getElementById('agentCards');
  container.innerHTML = '<div class="empty-state"><div class="modal-loading"><div class="spinner"></div><p>Loading agents...</p></div></div>';
  waFetch('/api/agents').then(function(data) {
    if (!data.agents || data.agents.length === 0) {
      document.getElementById('agentSummary').innerHTML = '';
      container.innerHTML = '<div class="empty-state"><p>No agents configured</p></div>';
      return;
    }
    agentData = data.agents;
    renderAgentSummary();
    renderAgentCards();
  }).catch(function() { container.innerHTML = '<div class="empty-state"><p>Failed to load agents</p></div>'; });
}

function agentSearch() {
  agentSearchTerm = (document.getElementById('agentSearchInput').value || '').toLowerCase().trim();
  renderAgentCards();
}

// ===== SUMMARY =====
function renderAgentSummary() {
  var online = 0, idle = 0, offline = 0, total = 0;
  agentData.forEach(function(a) {
    if (a.role === 'admin') return;
    total++;
    if (a.presenceStatus === 'online') online++;
    else if (a.presenceStatus === 'idle') idle++;
    else offline++;
  });
  document.getElementById('agentSummary').innerHTML =
    summaryCard('Total', total, '#222', 'all') +
    summaryCard('Online', online, '#2ecc71', 'online') +
    summaryCard('Idle', idle, '#f39c12', 'idle') +
    summaryCard('Offline', offline, '#95a5a6', 'offline');
}

function summaryCard(label, value, color, filter) {
  var sel = agentFilterStatus === filter;
  return '<div onclick="agentFilterBy(\'' + filter + '\')" style="flex:1;min-width:80px;text-align:center;padding:10px;background:#fff;border-radius:8px;border:' + (sel ? '2px solid ' + color : '1px solid #eee') + ';cursor:pointer;">' +
    '<div style="font-weight:700;font-size:20px;color:' + color + ';">' + value + '</div>' +
    '<div style="font-size:11px;color:#999;">' + label + '</div></div>';
}

function agentFilterBy(s) { agentFilterStatus = s; renderAgentSummary(); renderAgentCards(); }
function agentSortByField(f) { agentSortBy = f; renderAgentCards(); }

// ===== CARD RENDERING =====
function renderAgentCards() {
  var container = document.getElementById('agentCards');
  var filtered = agentData.filter(function(a) {
    if (agentFilterStatus !== 'all' && a.presenceStatus !== agentFilterStatus) return false;
    if (agentSearchTerm) {
      var h = (a.username + ' ' + (a.displayName || '') + ' ' + a.role).toLowerCase();
      if (h.indexOf(agentSearchTerm) === -1) return false;
    }
    return true;
  });

  filtered.sort(function(a, b) {
    if (a.role === 'admin' && b.role !== 'admin') return 1;
    if (a.role !== 'admin' && b.role === 'admin') return -1;
    switch (agentSortBy) {
      case 'calls': return b.todayCalls - a.todayCalls;
      case 'talktime': return b.todayTalkTime - a.todayTalkTime;
      case 'rate': return b.answerRate - a.answerRate;
      case 'score': return b.score - a.score;
      case 'lastseen': return (b.lastSeen || 0) - (a.lastSeen || 0);
      default:
        var order = { online: 0, busy: 1, idle: 2, offline: 3, never_connected: 4, disabled: 5 };
        return (order[a.presenceStatus] || 3) - (order[b.presenceStatus] || 3);
    }
  });

  var sortHtml = '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap;">' +
    '<span style="font-size:12px;color:#888;">Sort:</span>' +
    sortBtn('Status', 'status') + sortBtn('Calls', 'calls') + sortBtn('Talk Time', 'talktime') +
    sortBtn('Rate', 'rate') + sortBtn('Score', 'score') + sortBtn('Last Seen', 'lastseen') +
    '<span style="margin-left:auto;font-size:12px;color:#999;">' + filtered.length + ' of ' + agentData.length + '</span></div>';

  if (filtered.length === 0) {
    container.innerHTML = sortHtml + '<div class="empty-state"><p>No agents match this filter</p></div>';
    return;
  }

  container.innerHTML = sortHtml + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;">' +
    filtered.map(renderAgentCard).join('') + '</div>';
}

function sortBtn(label, field) {
  var a = agentSortBy === field;
  return '<button onclick="agentSortByField(\'' + field + '\')" style="padding:3px 10px;border:' + (a ? 'none' : '1px solid #ddd') + ';border-radius:4px;background:' + (a ? '#1a1a2e' : '#fff') + ';color:' + (a ? '#fff' : '#555') + ';font-size:11px;font-weight:600;cursor:pointer;">' + label + '</button>';
}

function stat(label, value, color) {
  var s = color ? 'color:' + color + ';' : 'color:#222;';
  return '<div style="background:#fff;text-align:center;padding:8px 2px;"><div style="font-weight:700;font-size:14px;' + s + '">' + value + '</div><div style="font-size:9px;color:#aaa;margin-top:1px;">' + label + '</div></div>';
}

function renderAgentCard(a) {
  var pcfg = presenceConfig[a.presenceStatus] || presenceConfig.offline;
  var roleBadge = a.role === 'admin'
    ? '<span style="background:#7b1fa2;color:white;font-size:9px;padding:1px 6px;border-radius:3px;">ADMIN</span>'
    : '<span style="background:#1565c0;color:white;font-size:9px;padding:1px 6px;border-radius:3px;">AGENT</span>';
  var scoreColor = a.score >= 20 ? '#2ecc71' : a.score >= 5 ? '#f39c12' : '#e74c3c';
  var rateColor = a.answerRate >= 80 ? '#2ecc71' : a.answerRate >= 50 ? '#f39c12' : '#e74c3c';
  var displayName = a.displayName && a.displayName !== a.username ? '<div style="font-size:11px;color:#888;">' + escapeHtml(a.displayName) + '</div>' : '';
  var monBadge = a.role !== 'admin' ? '<span style="font-size:9px;color:' + (a.monitorAlive ? '#2ecc71' : '#ccc') + ';">' + (a.monitorAlive ? '● Mon' : '○ Mon') + '</span>' : '';
  var uid = 'ad-' + a.username.replace(/\W/g, '');
  var isDb = a.source === 'db';
  var lastCall = a.lastCallAt ? formatLastSeen(new Date(a.lastCallAt).getTime()) : 'Never';

  var actions = '<button onclick="agentChangePassword(\'' + a.username + '\')" style="padding:2px 8px;border:1px solid #ddd;border-radius:4px;background:#fff;color:#555;font-size:10px;cursor:pointer;">Reset PW</button>';
  if (isDb) {
    actions += a.active
      ? ' <button onclick="agentToggleActive(\'' + a.username + '\',false)" style="padding:2px 8px;border:none;border-radius:4px;background:#f39c12;color:white;font-size:10px;cursor:pointer;">Deactivate</button>'
      : ' <button onclick="agentToggleActive(\'' + a.username + '\',true)" style="padding:2px 8px;border:none;border-radius:4px;background:#2ecc71;color:white;font-size:10px;cursor:pointer;">Activate</button>';
    actions += ' <button onclick="agentDelete(\'' + a.username + '\')" style="padding:2px 8px;border:none;border-radius:4px;background:#e74c3c;color:white;font-size:10px;cursor:pointer;">Delete</button>';
  }

  return '<div style="background:#fff;border-radius:10px;border:1px solid #eee;box-shadow:0 1px 3px rgba(0,0,0,0.05);overflow:hidden;' + (!a.active ? 'opacity:0.5;' : '') + '">' +
    // Header
    '<div onclick="agentToggleDetail(\'' + uid + '\')" style="padding:10px 14px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;border-bottom:1px solid #f5f5f5;">' +
      '<div style="display:flex;align-items:center;gap:6px;">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + pcfg.dot + ';display:inline-block;"></span>' +
        '<div><span style="font-weight:700;font-size:14px;color:#222;">' + escapeHtml(a.username) + '</span> ' + roleBadge + ' ' + monBadge + displayName + '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;">' +
        '<span style="font-size:11px;font-weight:700;color:' + scoreColor + ';">' + a.score + '</span>' +
        presenceBadge(a.presenceStatus) +
      '</div>' +
    '</div>' +
    // Quick stats
    '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:#f5f5f5;">' +
      stat('Today', a.todayCalls) +
      stat('Talk', formatTalkTime(a.todayTalkTime)) +
      stat('Week', a.weekCalls) +
      stat('Week Talk', formatTalkTime(a.weekTalkTime)) +
      stat('Rate', a.answerRate + '%', rateColor) +
    '</div>' +
    // Expandable detail
    '<div id="' + uid + '" style="display:none;">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#f5f5f5;">' +
        stat('Total', a.totalCalls) +
        stat('Answered', a.answeredCalls, '#2ecc71') +
        stat('Missed', a.missedCalls, '#e74c3c') +
        stat('Avg', formatTalkTime(a.avgDuration)) +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#f5f5f5;">' +
        stat('Total Talk', formatTalkTime(a.totalTalkTime)) +
        stat('Best Today', formatTalkTime(a.longestToday)) +
        stat('Best Week', formatTalkTime(a.longestWeek)) +
      '</div>' +
      '<div style="padding:8px 14px;font-size:11px;color:#888;border-top:1px solid #f5f5f5;">' +
        '<span title="' + lastSeenTooltip(a.lastSeen) + '">Last seen: ' + formatLastSeen(a.lastSeen) + '</span>' +
        ' · Last call: ' + lastCall +
        (a.lastLogin ? ' · Login: ' + formatLastSeen(a.lastLogin) : '') +
      '</div>' +
      '<div style="padding:6px 14px 10px;display:flex;gap:4px;flex-wrap:wrap;border-top:1px solid #f5f5f5;">' + actions + '</div>' +
    '</div>' +
  '</div>';
}

function agentToggleDetail(uid) {
  var el = document.getElementById(uid);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}

// ===== ACTIONS =====
function agentChangePassword(u) {
  var pw = prompt('New password for ' + u + ' (min 6 chars):');
  if (!pw || pw.length < 6) { if (pw !== null) agentToast('Min 6 characters', 'warn'); return; }
  waFetch('/api/agents/change-password', { method: 'POST', body: JSON.stringify({ username: u, password: pw }) })
    .then(function(d) { d.ok ? agentToast('Password changed for ' + u, 'success') : agentToast(d.error || 'Failed', 'warn'); })
    .catch(function(e) { if (e.message !== 'Session expired') agentToast('Request failed', 'warn'); });
}

function agentToggleActive(u, active) {
  agentConfirm(active ? 'Activate Agent' : 'Deactivate Agent', (active ? 'Activate ' : 'Deactivate ') + u + '?', active ? 'Activate' : 'Deactivate', active ? '#2ecc71' : '#f39c12')
    .then(function(ok) { if (!ok) return;
      waFetch('/api/agents/toggle-active', { method: 'POST', body: JSON.stringify({ username: u, active: active }) })
        .then(function(d) { d.ok ? (agentToast(u + (active ? ' activated' : ' deactivated'), 'success'), loadAgents()) : agentToast(d.error, 'warn'); })
        .catch(function(e) { if (e.message !== 'Session expired') agentToast('Request failed', 'warn'); });
    });
}

function agentDelete(u) {
  agentConfirm('Delete Agent', 'Permanently delete ' + u + '? This can be undone from Archived Agents.', 'Delete', '#e74c3c')
    .then(function(ok) { if (!ok) return;
      waFetch('/api/agents/delete', { method: 'POST', body: JSON.stringify({ username: u }) })
        .then(function(d) { d.ok ? (agentToast(u + ' deleted', 'success'), loadAgents()) : agentToast(d.error, 'warn'); })
        .catch(function(e) { if (e.message !== 'Session expired') agentToast('Request failed', 'warn'); });
    });
}

// ===== CREATE =====
function agentShowCreateForm() {
  var s = document.getElementById('agentCreateSection');
  s.style.display = s.style.display === 'none' ? '' : 'none';
  if (s.style.display !== 'none') document.getElementById('newAgentUsername').focus();
}

function agentCreate() {
  var u = document.getElementById('newAgentUsername').value.trim();
  var p = document.getElementById('newAgentPassword').value;
  var n = document.getElementById('newAgentName').value.trim();
  var r = document.getElementById('newAgentRole').value;
  var notes = document.getElementById('newAgentNotes').value.trim();
  if (!u || !p) return agentToast('Username and password required', 'warn');
  if (u.length < 3) return agentToast('Username min 3 chars', 'warn');
  if (p.length < 6) return agentToast('Password min 6 chars', 'warn');
  waFetch('/api/agents/create', { method: 'POST', body: JSON.stringify({ username: u, password: p, displayName: n, role: r, notes: notes }) })
    .then(function(d) {
      if (d.ok) { agentToast(u + ' created', 'success'); document.getElementById('newAgentUsername').value = ''; document.getElementById('newAgentPassword').value = ''; document.getElementById('newAgentName').value = ''; document.getElementById('newAgentNotes').value = ''; document.getElementById('agentCreateSection').style.display = 'none'; loadAgents(); }
      else agentToast(d.error || 'Failed', 'warn');
    }).catch(function(e) { agentToast(e.message, 'warn'); });
}

// ===== ARCHIVED =====
function agentShowArchived() {
  var s = document.getElementById('agentExtraSection');
  s.innerHTML = '<div class="empty-state"><div class="modal-loading"><div class="spinner"></div><p>Loading...</p></div></div>';
  waFetch('/api/agents/archived').then(function(d) {
    var a = d.agents || [];
    if (!a.length) { s.innerHTML = '<div style="background:#fff;border:1px solid #eee;border-radius:10px;padding:20px;color:#888;">No archived agents</div>'; return; }
    s.innerHTML = '<div style="background:#fff;border:1px solid #eee;border-radius:10px;padding:16px;"><h3 style="margin:0 0 12px;font-size:14px;color:#222;">Archived Agents</h3>' +
      a.map(function(u) { return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f0f0;"><div><span style="font-weight:600;">' + escapeHtml(u.username) + '</span> <span style="font-size:11px;color:#999;">' + u.role + '</span><div style="font-size:11px;color:#bbb;">Deleted: ' + (u.deleted_at ? new Date(u.deleted_at).toLocaleString() : '') + '</div></div><button onclick="agentRestore(' + u.id + ')" style="padding:4px 12px;border:none;border-radius:4px;background:#2ecc71;color:white;font-size:11px;font-weight:600;cursor:pointer;">Restore</button></div>'; }).join('') +
    '</div>';
  }).catch(function() { s.innerHTML = '<p style="color:#e74c3c;">Failed to load</p>'; });
}

function agentRestore(id) {
  agentConfirm('Restore Agent', 'Restore this agent?', 'Restore', '#2ecc71').then(function(ok) {
    if (!ok) return;
    waFetch('/api/agents/restore', { method: 'POST', body: JSON.stringify({ id: id }) })
      .then(function(d) { d.ok ? (agentToast('Restored', 'success'), agentShowArchived(), loadAgents()) : agentToast(d.error, 'warn'); })
      .catch(function() {});
  });
}

// ===== AUDIT LOG =====
function agentShowAuditLog() {
  var s = document.getElementById('agentExtraSection');
  s.innerHTML = '<div class="empty-state"><div class="modal-loading"><div class="spinner"></div><p>Loading...</p></div></div>';
  waFetch('/api/audit-log?limit=50').then(function(d) {
    var logs = d.logs || [];
    if (!logs.length) { s.innerHTML = '<div style="background:#fff;border:1px solid #eee;border-radius:10px;padding:20px;color:#888;">No audit entries</div>'; return; }
    var colors = { agent_created: '#2ecc71', agent_updated: '#3498db', agent_deleted: '#e74c3c', agent_activated: '#2ecc71', agent_deactivated: '#f39c12', agent_restored: '#2ecc71', password_changed: '#9b59b6' };
    s.innerHTML = '<div style="background:#fff;border:1px solid #eee;border-radius:10px;padding:16px;max-height:400px;overflow:auto;"><h3 style="margin:0 0 12px;font-size:14px;color:#222;">Audit Log</h3><table style="width:100%;border-collapse:collapse;font-size:12px;"><tr style="border-bottom:2px solid #eee;text-align:left;"><th style="padding:6px 8px;color:#888;">Time</th><th style="padding:6px 8px;color:#888;">Action</th><th style="padding:6px 8px;color:#888;">Target</th><th style="padding:6px 8px;color:#888;">Details</th><th style="padding:6px 8px;color:#888;">By</th></tr>' +
      logs.map(function(l) { return '<tr style="border-bottom:1px solid #f5f5f5;"><td style="padding:6px 8px;color:#999;white-space:nowrap;">' + new Date(l.created_at).toLocaleString() + '</td><td style="padding:6px 8px;color:' + (colors[l.action] || '#555') + ';font-weight:600;">' + escapeHtml(l.action.replace(/_/g, ' ')) + '</td><td style="padding:6px 8px;color:#222;">' + escapeHtml(l.target || '-') + '</td><td style="padding:6px 8px;color:#888;">' + escapeHtml(l.details || '-') + '</td><td style="padding:6px 8px;color:#888;">' + escapeHtml(l.performed_by) + '</td></tr>'; }).join('') +
    '</table></div>';
  }).catch(function() { s.innerHTML = '<p style="color:#e74c3c;">Failed to load</p>'; });
}
