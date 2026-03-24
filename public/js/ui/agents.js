// ===== AGENT MANAGEMENT UI =====

var agentData = [];
var agentSortBy = 'status';
var agentFilterStatus = 'all';
var agentSearchTerm = '';

// ===== TOAST HELPER =====
function agentToast(message, type) {
  var toast = document.createElement('div');
  toast.className = 'error-toast' + (type === 'warn' ? ' warn' : type === 'success' ? ' success' : '');
  if (type === 'success') toast.style.cssText = 'background:#2ecc71;color:white;';
  toast.innerHTML = escapeHtml(message) + '<button class="error-toast-close" onclick="dismissToast(this)">&times;</button>';
  toastContainer.appendChild(toast);
  setTimeout(function() {
    if (toast.parentNode) {
      toast.style.animation = 'toastOut 0.3s ease-in forwards';
      setTimeout(function() { toast.remove(); }, 300);
    }
  }, 4000);
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
    modal.innerHTML =
      '<div style="padding:20px 24px;border-bottom:1px solid #eee;">' +
        '<div style="font-weight:700;font-size:16px;color:#222;">' + escapeHtml(title) + '</div>' +
      '</div>' +
      '<div style="padding:16px 24px;font-size:14px;color:#555;line-height:1.5;">' + escapeHtml(message) + '</div>' +
      '<div style="padding:12px 24px 20px;display:flex;gap:10px;justify-content:flex-end;">' +
        '<button id="acmCancel" style="padding:8px 20px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#555;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>' +
        '<button id="acmConfirm" style="padding:8px 20px;border:none;border-radius:6px;background:' + (btnColor || '#e74c3c') + ';color:white;font-size:13px;font-weight:600;cursor:pointer;">' + (btnText || 'Confirm') + '</button>' +
      '</div>';

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

  waFetch('/api/agents')
    .then(function(data) {
      if (!data.agents || data.agents.length === 0) {
        document.getElementById('agentSummary').innerHTML = '';
        container.innerHTML = '<div class="empty-state"><p>No agents configured</p></div>';
        return;
      }
      agentData = data.agents;
      renderAgentSummary();
      renderAgentCards();
    })
    .catch(function() {
      container.innerHTML = '<div class="empty-state"><p>Failed to load agents</p></div>';
    });
}

// ===== SEARCH =====
function agentSearch() {
  agentSearchTerm = (document.getElementById('agentSearchInput').value || '').toLowerCase().trim();
  renderAgentCards();
}

// ===== SUMMARY =====
function renderAgentSummary() {
  var active = 0, idle = 0, offline = 0, totalAgents = 0;
  agentData.forEach(function(a) {
    if (a.role === 'admin') return;
    totalAgents++;
    if (a.status === 'active') active++;
    else if (a.status === 'idle') idle++;
    else offline++;
  });
  document.getElementById('agentSummary').innerHTML =
    agentSummaryCard('Total', totalAgents, '#222', 'all') +
    agentSummaryCard('Active', active, '#2ecc71', 'active') +
    agentSummaryCard('Idle', idle, '#f39c12', 'idle') +
    agentSummaryCard('Offline', offline, '#e74c3c', 'offline');
}

function agentSummaryCard(label, value, color, filter) {
  var selected = agentFilterStatus === filter;
  var border = selected ? '2px solid ' + color : '1px solid #eee';
  return '<div onclick="agentFilterBy(\'' + filter + '\')" style="flex:1;min-width:90px;text-align:center;padding:10px;background:#fff;border-radius:8px;border:' + border + ';cursor:pointer;transition:border 0.2s;">' +
    '<div style="font-weight:700;font-size:20px;color:' + color + ';">' + value + '</div>' +
    '<div style="font-size:11px;color:#999;">' + label + '</div>' +
  '</div>';
}

function agentFilterBy(status) {
  agentFilterStatus = status;
  renderAgentSummary();
  renderAgentCards();
}

function agentSortByField(field) {
  agentSortBy = field;
  renderAgentCards();
}

// ===== CARD RENDERING =====
function renderAgentCards() {
  var container = document.getElementById('agentCards');

  // Filter by status
  var filtered = agentData.filter(function(a) {
    if (agentFilterStatus !== 'all' && a.status !== agentFilterStatus) return false;
    // Filter by search
    if (agentSearchTerm) {
      var haystack = (a.username + ' ' + (a.displayName || '') + ' ' + a.role).toLowerCase();
      if (haystack.indexOf(agentSearchTerm) === -1) return false;
    }
    return true;
  });

  // Sort
  filtered.sort(function(a, b) {
    if (a.role === 'admin' && b.role !== 'admin') return 1;
    if (a.role !== 'admin' && b.role === 'admin') return -1;
    switch (agentSortBy) {
      case 'calls': return b.todayCalls - a.todayCalls;
      case 'talktime': return b.todayTalkTime - a.todayTalkTime;
      case 'rate': return b.answerRate - a.answerRate;
      case 'score': return b.score - a.score;
      case 'lastseen': return (b.lastActivity || 0) - (a.lastActivity || 0);
      default:
        var order = { active: 0, idle: 1, offline: 2 };
        return (order[a.status] || 2) - (order[b.status] || 2);
    }
  });

  // Sort controls
  var sortHtml = '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap;">' +
    '<span style="font-size:12px;color:#888;">Sort:</span>' +
    sortBtn('Status', 'status') + sortBtn('Calls', 'calls') + sortBtn('Talk Time', 'talktime') +
    sortBtn('Rate', 'rate') + sortBtn('Score', 'score') + sortBtn('Last Seen', 'lastseen') +
    '<span style="margin-left:auto;font-size:12px;color:#999;">' + filtered.length + ' of ' + agentData.length + ' agents</span>' +
  '</div>';

  if (filtered.length === 0) {
    container.innerHTML = sortHtml + '<div class="empty-state"><p>No agents match this filter</p></div>';
    return;
  }

  container.innerHTML = sortHtml + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;">' +
    filtered.map(function(a) { return renderAgentCard(a); }).join('') + '</div>';
}

function sortBtn(label, field) {
  var active = agentSortBy === field;
  return '<button onclick="agentSortByField(\'' + field + '\')" style="padding:3px 10px;border:' + (active ? 'none' : '1px solid #ddd') + ';border-radius:4px;background:' + (active ? '#1a1a2e' : '#fff') + ';color:' + (active ? '#fff' : '#555') + ';font-size:11px;font-weight:600;cursor:pointer;">' + label + '</button>';
}

function agentStatCell(label, value, color) {
  var valStyle = color ? 'color:' + color + ';' : 'color:#222;';
  return '<div style="background:#fff;text-align:center;padding:8px 4px;">' +
    '<div style="font-weight:700;font-size:15px;' + valStyle + '">' + value + '</div>' +
    '<div style="font-size:9px;color:#999;margin-top:1px;">' + label + '</div>' +
  '</div>';
}

function renderAgentCard(a) {
  var statusColor = { active: '#2ecc71', idle: '#f39c12', offline: '#e74c3c' }[a.status] || '#e74c3c';
  var statusLabel = a.status.charAt(0).toUpperCase() + a.status.slice(1);
  var roleBadge = a.role === 'admin'
    ? '<span style="background:#7b1fa2;color:white;font-size:10px;padding:2px 8px;border-radius:4px;">ADMIN</span>'
    : '<span style="background:#1565c0;color:white;font-size:10px;padding:2px 8px;border-radius:4px;">AGENT</span>';

  var inactiveBadge = !a.active ? ' <span style="background:#e74c3c;color:white;font-size:9px;padding:1px 6px;border-radius:3px;">INACTIVE</span>' : '';
  var monitorBadge = '';
  if (a.role !== 'admin') {
    var mColor = a.monitorAlive ? '#2ecc71' : '#e74c3c';
    monitorBadge = '<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;color:' + mColor + ';margin-left:6px;"><span style="width:5px;height:5px;border-radius:50%;background:' + mColor + ';display:inline-block;"></span>' + (a.monitorAlive ? 'Mon' : 'Mon Off') + '</span>';
  }

  var lastSeen = agentLastSeen(a.lastActivity || a.lastHeartbeat);
  var rateColor = a.answerRate >= 80 ? '#2ecc71' : a.answerRate >= 50 ? '#f39c12' : '#e74c3c';
  var scoreColor = a.score >= 20 ? '#2ecc71' : a.score >= 5 ? '#f39c12' : '#e74c3c';
  var displayName = a.displayName && a.displayName !== a.username ? '<div style="font-size:11px;color:#888;">' + escapeHtml(a.displayName) + '</div>' : '';
  var isDbAgent = a.source === 'db';
  var lastCall = a.lastCallAt ? agentLastSeen(new Date(a.lastCallAt).getTime()) : 'Never';
  var uid = 'agent-detail-' + a.username.replace(/[^a-z0-9]/gi, '');

  // Actions
  var actions = '<button onclick="agentChangePassword(\'' + a.username + '\')" style="padding:3px 8px;border:1px solid #ddd;border-radius:4px;background:#fff;color:#555;font-size:10px;cursor:pointer;">Reset PW</button>';
  if (isDbAgent) {
    if (a.active) {
      actions += ' <button onclick="agentToggleActive(\'' + a.username + '\',false)" style="padding:3px 8px;border:none;border-radius:4px;background:#f39c12;color:white;font-size:10px;cursor:pointer;">Deactivate</button>';
    } else {
      actions += ' <button onclick="agentToggleActive(\'' + a.username + '\',true)" style="padding:3px 8px;border:none;border-radius:4px;background:#2ecc71;color:white;font-size:10px;cursor:pointer;">Activate</button>';
    }
    actions += ' <button onclick="agentDelete(\'' + a.username + '\')" style="padding:3px 8px;border:none;border-radius:4px;background:#e74c3c;color:white;font-size:10px;cursor:pointer;">Delete</button>';
  }

  return '<div style="background:#fff;border-radius:10px;border:1px solid #eee;box-shadow:0 1px 4px rgba(0,0,0,0.06);overflow:hidden;' + (!a.active ? 'opacity:0.55;' : '') + '">' +
    // Header — clickable to expand
    '<div onclick="agentToggleDetail(\'' + uid + '\')" style="padding:12px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f0f0;cursor:pointer;">' +
      '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:' + statusColor + ';display:inline-block;flex-shrink:0;"></span>' +
        '<div>' +
          '<span style="font-weight:700;font-size:14px;color:#222;">' + escapeHtml(a.username) + '</span> ' + roleBadge + inactiveBadge + monitorBadge +
          displayName +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
        '<span style="font-size:11px;font-weight:700;color:' + scoreColor + ';">' + a.score + ' pts</span>' +
        '<span style="font-size:11px;color:' + statusColor + ';font-weight:600;">' + statusLabel + '</span>' +
        '<span style="font-size:12px;color:#ccc;">&#9660;</span>' +
      '</div>' +
    '</div>' +
    // Quick stats (always visible)
    '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:#f0f0f0;">' +
      agentStatCell('Today', a.todayCalls) +
      agentStatCell('Answered', a.answeredCalls, '#2ecc71') +
      agentStatCell('Missed', a.missedCalls, '#e74c3c') +
      agentStatCell('Rate', a.answerRate + '%', rateColor) +
      agentStatCell('Avg', a.avgDuration > 0 ? formatCallDuration(a.avgDuration) : '--') +
    '</div>' +
    // Expandable detail section
    '<div id="' + uid + '" style="display:none;">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#f0f0f0;">' +
        agentStatCell('Week Calls', a.weekCalls) +
        agentStatCell('Total Calls', a.totalCalls) +
        agentStatCell('Today Talk', formatCallDuration(a.todayTalkTime)) +
        agentStatCell('Week Talk', formatCallDuration(a.weekTalkTime)) +
      '</div>' +
      '<div style="padding:10px 14px;font-size:11px;color:#888;border-top:1px solid #f0f0f0;">' +
        'Total talk time: ' + formatCallDuration(a.totalTalkTime) +
        ' &middot; Last seen: ' + lastSeen +
        ' &middot; Last call: ' + lastCall +
      '</div>' +
      '<div style="padding:8px 14px 12px;display:flex;gap:4px;flex-wrap:wrap;border-top:1px solid #f0f0f0;">' + actions + '</div>' +
    '</div>' +
  '</div>';
}

function agentToggleDetail(uid) {
  var el = document.getElementById(uid);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

function agentLastSeen(ts) {
  if (!ts) return 'Never';
  var ago = Math.floor((Date.now() - ts) / 1000);
  if (ago < 10) return 'Just now';
  if (ago < 60) return ago + 's ago';
  if (ago < 3600) return Math.floor(ago / 60) + 'm ago';
  if (ago < 86400) return Math.floor(ago / 3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

// ===== AGENT ACTIONS (with confirm modals and toasts) =====

function agentChangePassword(username) {
  var pw = prompt('New password for ' + username + ' (min 6 characters):');
  if (!pw || pw.length < 6) {
    if (pw !== null) agentToast('Password must be at least 6 characters.', 'warn');
    return;
  }
  waFetch('/api/agents/change-password', { method: 'POST', body: JSON.stringify({ username: username, password: pw }) })
    .then(function(data) {
      if (data.ok) agentToast('Password changed for ' + username, 'success');
      else agentToast(data.error || 'Failed to change password', 'warn');
    })
    .catch(function() {});
}

function agentToggleActive(username, active) {
  var action = active ? 'activate' : 'deactivate';
  agentConfirm(
    (active ? 'Activate' : 'Deactivate') + ' Agent',
    'Are you sure you want to ' + action + ' ' + username + '?' + (!active ? '\n\nThey will not be able to log in.' : ''),
    active ? 'Activate' : 'Deactivate',
    active ? '#2ecc71' : '#f39c12'
  ).then(function(ok) {
    if (!ok) return;
    waFetch('/api/agents/toggle-active', { method: 'POST', body: JSON.stringify({ username: username, active: active }) })
      .then(function(data) {
        if (data.ok) { agentToast(username + ' ' + (active ? 'activated' : 'deactivated'), 'success'); loadAgents(); }
        else agentToast(data.error || 'Action failed', 'warn');
      })
      .catch(function() {});
  });
}

function agentDelete(username) {
  agentConfirm(
    'Delete Agent',
    'Are you sure you want to permanently delete ' + username + '?\n\nThis action cannot be undone. All call history will remain but the agent will no longer be able to log in.',
    'Delete Permanently',
    '#e74c3c'
  ).then(function(ok) {
    if (!ok) return;
    waFetch('/api/agents/delete', { method: 'POST', body: JSON.stringify({ username: username }) })
      .then(function(data) {
        if (data.ok) { agentToast(username + ' deleted', 'success'); loadAgents(); }
        else agentToast(data.error || 'Delete failed', 'warn');
      })
      .catch(function() {});
  });
}

// ===== CREATE AGENT =====

function agentShowCreateForm() {
  var section = document.getElementById('agentCreateSection');
  section.style.display = section.style.display === 'none' ? '' : 'none';
  if (section.style.display !== 'none') {
    document.getElementById('newAgentUsername').focus();
  }
}

function agentCreate() {
  var username = document.getElementById('newAgentUsername').value.trim();
  var password = document.getElementById('newAgentPassword').value;
  var displayName = document.getElementById('newAgentName').value.trim();
  var role = document.getElementById('newAgentRole').value;
  var notes = document.getElementById('newAgentNotes').value.trim();

  if (!username || !password) return agentToast('Username and password are required.', 'warn');
  if (username.length < 3) return agentToast('Username must be at least 3 characters.', 'warn');
  if (password.length < 6) return agentToast('Password must be at least 6 characters.', 'warn');

  waFetch('/api/agents/create', {
    method: 'POST',
    body: JSON.stringify({ username: username, password: password, displayName: displayName, role: role, notes: notes })
  })
    .then(function(data) {
      if (data.ok) {
        agentToast('Agent ' + username + ' created', 'success');
        document.getElementById('newAgentUsername').value = '';
        document.getElementById('newAgentPassword').value = '';
        document.getElementById('newAgentName').value = '';
        document.getElementById('newAgentNotes').value = '';
        document.getElementById('agentCreateSection').style.display = 'none';
        loadAgents();
      } else {
        agentToast(data.error || 'Create failed', 'warn');
      }
    })
    .catch(function(err) { agentToast(err.message, 'warn'); });
}
