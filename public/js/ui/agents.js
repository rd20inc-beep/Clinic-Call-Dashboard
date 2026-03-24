// ===== AGENT MANAGEMENT UI (Table-based, matching original admin console) =====

var agentData = [];
var agentSearchTerm = '';

// ===== PRESENCE =====
var presenceConfig = {
  online:          { color: '#059669', bg: '#ecfdf5', label: 'Online' },
  busy:            { color: '#d97706', bg: '#fffbeb', label: 'Busy' },
  idle:            { color: '#d97706', bg: '#fffbeb', label: 'Idle' },
  offline:         { color: '#64748b', bg: '#f1f5f9', label: 'Offline' },
  never_connected: { color: '#94a3b8', bg: '#f8fafc', label: 'Never' },
  disabled:        { color: '#dc2626', bg: '#fef2f2', label: 'Disabled' },
};

function badge(text, color, bg) {
  return '<span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;background:' + bg + ';color:' + color + ';">' + text + '</span>';
}

// ===== FORMATTERS =====
function formatTalkTime(s) {
  if (!s || s <= 0) return '--';
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60); s = s % 60;
  if (m < 60) return m + 'm' + (s > 0 ? ' ' + s + 's' : '');
  var h = Math.floor(m / 60); m = m % 60;
  return h + 'h' + (m > 0 ? ' ' + m + 'm' : '');
}

function formatLastSeen(ts) {
  if (!ts) return '<span style="color:#94a3b8;">Never</span>';
  var now = Date.now(), ago = Math.floor((now - ts) / 1000);
  var text;
  if (ago < 10) text = 'Just now';
  else if (ago < 60) text = ago + 's ago';
  else if (ago < 3600) text = Math.floor(ago / 60) + 'm ago';
  else if (ago < 86400) text = Math.floor(ago / 3600) + 'h ago';
  else { var d = new Date(ts); text = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  return '<span title="' + new Date(ts).toLocaleString() + '">' + text + '</span>';
}

// ===== TOAST =====
function agentToast(msg, type) {
  var t = document.createElement('div');
  t.className = 'error-toast' + (type === 'warn' ? ' warn' : type === 'success' ? ' success' : '');
  t.innerHTML = escapeHtml(msg) + '<button class="error-toast-close" onclick="dismissToast(this)">&times;</button>';
  toastContainer.appendChild(t);
  setTimeout(function() { if (t.parentNode) { t.style.animation = 'toastOut 0.3s ease-in forwards'; setTimeout(function() { t.remove(); }, 300); } }, 4000);
}

// ===== CONFIRM MODAL =====
function agentConfirm(title, msg, btnText, btnColor) {
  return new Promise(function(resolve) {
    var old = document.getElementById('agentConfirmModal'); if (old) old.remove();
    var ov = document.createElement('div');
    ov.id = 'agentConfirmModal';
    ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    ov.innerHTML = '<div style="background:#fff;border-radius:12px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.15);padding:28px;">' +
      '<h3 style="margin:0 0 12px;font-size:16px;color:#0f172a;">' + escapeHtml(title) + '</h3>' +
      '<p style="margin:0 0 20px;font-size:14px;color:#64748b;line-height:1.5;">' + escapeHtml(msg) + '</p>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
        '<button id="acmC" style="padding:8px 20px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#64748b;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>' +
        '<button id="acmO" style="padding:8px 20px;border:none;border-radius:6px;background:' + (btnColor || '#ef4444') + ';color:white;font-size:13px;font-weight:600;cursor:pointer;">' + (btnText || 'Confirm') + '</button>' +
      '</div></div>';
    document.body.appendChild(ov);
    ov.onclick = function(e) { if (e.target === ov) { ov.remove(); resolve(false); } };
    document.getElementById('acmC').onclick = function() { ov.remove(); resolve(false); };
    document.getElementById('acmO').onclick = function() { ov.remove(); resolve(true); };
  });
}

// ===== LOAD AGENTS =====
function loadAgents() {
  var container = document.getElementById('agentCards');
  container.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;"><div class="spinner" style="margin:0 auto 12px;"></div>Loading agents...</div>';
  waFetch('/api/agents').then(function(data) {
    agentData = data.agents || [];
    renderAgentTable();
  }).catch(function() { container.innerHTML = '<div style="text-align:center;padding:40px;color:#ef4444;">Failed to load agents</div>'; });
}

function agentSearch() {
  agentSearchTerm = (document.getElementById('agentSearchInput').value || '').toLowerCase().trim();
  renderAgentTable();
}

// ===== RENDER TABLE =====
function renderAgentTable() {
  var container = document.getElementById('agentCards');
  var filtered = agentData.filter(function(a) {
    if (!agentSearchTerm) return true;
    return (a.username + ' ' + (a.displayName || '') + ' ' + a.role).toLowerCase().indexOf(agentSearchTerm) !== -1;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;">No agents found</div>';
    return;
  }

  var html = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;">' +
    '<thead><tr>' +
      '<th style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;font-weight:600;background:#f8fafc;border-bottom:2px solid #e2e8f0;text-align:left;">Username</th>' +
      '<th style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;font-weight:600;background:#f8fafc;border-bottom:2px solid #e2e8f0;text-align:left;">Name</th>' +
      '<th style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;font-weight:600;background:#f8fafc;border-bottom:2px solid #e2e8f0;">Role</th>' +
      '<th style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;font-weight:600;background:#f8fafc;border-bottom:2px solid #e2e8f0;">Status</th>' +
      '<th style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;font-weight:600;background:#f8fafc;border-bottom:2px solid #e2e8f0;text-align:center;">Connected</th>' +
      '<th style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;font-weight:600;background:#f8fafc;border-bottom:2px solid #e2e8f0;">Phone</th>' +
      '<th style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;font-weight:600;background:#f8fafc;border-bottom:2px solid #e2e8f0;">Last Login</th>' +
      '<th style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;font-weight:600;background:#f8fafc;border-bottom:2px solid #e2e8f0;text-align:right;">Actions</th>' +
    '</tr></thead><tbody>';

  filtered.forEach(function(a) {
    var pc = presenceConfig[a.presenceStatus] || presenceConfig.offline;
    var statusBadge = badge(pc.label, pc.color, pc.bg);
    var roleBadge = a.role === 'admin' ? badge('Admin', '#2563eb', '#eff6ff') : badge('Agent', '#7c3aed', '#f5f3ff');
    var callBadge = a.onCall ? ' ' + badge('ON CALL', '#fff', '#ea580c') : '';

    // Connection source dots: portal (green) + mobile (blue)
    var portalDot = a.portalOnline ? '<span title="Dashboard" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;margin-right:3px;"></span>' : '<span title="Dashboard" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#e2e8f0;margin-right:3px;"></span>';
    var mobileDot = a.mobileOnline ? '<span title="Mobile App" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3b82f6;margin-right:3px;"></span>' : '<span title="Mobile App" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#e2e8f0;margin-right:3px;"></span>';
    var monitorDotHtml = a.monitorAlive ? '<span title="Monitor" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f59e0b;"></span>' : '<span title="Monitor" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#e2e8f0;"></span>';
    var connectionDots = portalDot + mobileDot + monitorDotHtml;
    var name = escapeHtml(a.displayName && a.displayName !== a.username ? a.displayName : '-');
    var phone = a.phone ? escapeHtml(a.phone) : '<span style="color:#94a3b8;">-</span>';
    var lastLogin = a.lastLogin ? formatLastSeen(a.lastLogin) : '<span style="color:#94a3b8;">Never</span>';
    var rowBg = a.active ? '' : 'opacity:0.5;';

    // Action buttons
    var actions = '<div style="display:flex;gap:4px;justify-content:flex-end;align-items:center;flex-wrap:wrap;">';
    actions += '<button onclick="event.stopPropagation();openAgentDetail(\'' + escapeHtml(a.username) + '\')" style="padding:4px 8px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;color:#2563eb;font-size:11px;font-weight:600;cursor:pointer;">Stats</button>';
    actions += '<button onclick="event.stopPropagation();agentActionsMenu(this,\'' + escapeHtml(a.username) + '\',' + (a.active ? 'true' : 'false') + ',\'' + (a.source || 'db') + '\')" style="padding:4px 6px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;color:#64748b;font-size:13px;cursor:pointer;">&#8943;</button>';
    actions += '</div>';

    html += '<tr style="' + rowBg + 'cursor:pointer;" onclick="openAgentDetail(\'' + escapeHtml(a.username) + '\')">' +
      '<td style="padding:12px 16px;border-bottom:1px solid #f1f5f9;"><strong style="color:#0f172a;">' + escapeHtml(a.username) + '</strong>' + callBadge + '</td>' +
      '<td style="padding:12px 16px;border-bottom:1px solid #f1f5f9;color:#334155;">' + name + '</td>' +
      '<td style="padding:12px 16px;border-bottom:1px solid #f1f5f9;text-align:center;">' + roleBadge + '</td>' +
      '<td style="padding:12px 16px;border-bottom:1px solid #f1f5f9;text-align:center;">' + statusBadge + '</td>' +
      '<td style="padding:12px 16px;border-bottom:1px solid #f1f5f9;text-align:center;">' + connectionDots + '</td>' +
      '<td style="padding:12px 16px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#334155;">' + phone + '</td>' +
      '<td style="padding:12px 16px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#94a3b8;">' + lastLogin + '</td>' +
      '<td style="padding:12px 16px;border-bottom:1px solid #f1f5f9;">' + actions + '</td>' +
    '</tr>';
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;
}

// ===== ACTIONS DROPDOWN MENU =====
function agentActionsMenu(btn, username, isActive, source) {
  // Close any existing menu
  var old = document.getElementById('agentActionMenu'); if (old) old.remove();

  var menu = document.createElement('div');
  menu.id = 'agentActionMenu';
  menu.style.cssText = 'position:fixed;z-index:999;background:#fff;border:1px solid #e2e8f0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.12);min-width:160px;padding:4px 0;';

  var items = '';
  items += menuItem('Edit', "openEditAgent('" + username + "')");
  items += menuItem('Change Password', "agentChangePassword('" + username + "')");
  if (isActive) {
    items += menuItem('Disable Agent', "agentToggleActive('" + username + "',false)", '#d97706');
  } else {
    items += menuItem('Enable Agent', "agentToggleActive('" + username + "',true)", '#059669');
  }
  items += menuItem('Reset Stats', "agentClearActivity('" + username + "')");
  items += menuItem('Force Logout', "agentForceLogout('" + username + "')");
  items += '<div style="border-top:1px solid #e2e8f0;margin:4px 0;"></div>';
  items += menuItem('Delete History', "agentClearHistory('" + username + "')", '#dc2626');
  if (source === 'db') items += menuItem('Delete Agent', "agentDelete('" + username + "')", '#7f1d1d');

  menu.innerHTML = items;
  document.body.appendChild(menu);

  // Position near button
  var rect = btn.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';

  // Close on click outside
  setTimeout(function() {
    document.addEventListener('click', function closeMenu() {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    });
  }, 10);
}

function menuItem(text, onclick, color) {
  return '<a onclick="event.stopPropagation();' + onclick + ';document.getElementById(\'agentActionMenu\')&&document.getElementById(\'agentActionMenu\').remove();" style="display:block;padding:8px 16px;font-size:13px;color:' + (color || '#334155') + ';cursor:pointer;text-decoration:none;font-weight:' + (color === '#7f1d1d' ? '700' : '500') + ';" onmouseover="this.style.background=\'#f1f5f9\'" onmouseout="this.style.background=\'\';">' + text + '</a>';
}

// ===== CRUD ACTIONS =====
function agentChangePassword(u) {
  var pw = prompt('New password for ' + u + ' (min 6 chars):');
  if (!pw || pw.length < 6) { if (pw !== null) agentToast('Min 6 characters', 'warn'); return; }
  waFetch('/api/agents/change-password', { method: 'POST', body: JSON.stringify({ username: u, password: pw }) })
    .then(function(d) { d.ok ? agentToast('Password changed', 'success') : agentToast(d.error, 'warn'); })
    .catch(function() {});
}

function agentToggleActive(u, active) {
  agentConfirm(active ? 'Enable Agent' : 'Disable Agent', (active ? 'Enable ' : 'Disable ') + u + '?', active ? 'Enable' : 'Disable', active ? '#059669' : '#d97706')
    .then(function(ok) { if (!ok) return;
      waFetch('/api/agents/toggle-active', { method: 'POST', body: JSON.stringify({ username: u, active: active }) })
        .then(function(d) { d.ok ? (agentToast(u + (active ? ' enabled' : ' disabled'), 'success'), loadAgents()) : agentToast(d.error, 'warn'); }).catch(function() {});
    });
}

function agentDelete(u) {
  agentConfirm('Delete Agent', 'Delete ' + u + '? This can be undone from Archived Agents.', 'Delete', '#ef4444')
    .then(function(ok) { if (!ok) return;
      waFetch('/api/agents/delete', { method: 'POST', body: JSON.stringify({ username: u }) })
        .then(function(d) { d.ok ? (agentToast(u + ' deleted', 'success'), loadAgents()) : agentToast(d.error, 'warn'); }).catch(function() {});
    });
}

function agentClearActivity(u) {
  agentConfirm('Reset Stats', 'Clear visible activity for ' + u + '?\n\nRaw call history is preserved for audit.', 'Reset', '#d97706')
    .then(function(ok) { if (!ok) return;
      waFetch('/api/agents/clear-activity', { method: 'POST', body: JSON.stringify({ username: u }) })
        .then(function(d) { d.ok ? (agentToast('Activity cleared for ' + u, 'success'), loadAgents()) : agentToast(d.error, 'warn'); }).catch(function() {});
    });
}

function agentClearHistory(u) {
  agentConfirm('Delete Call History', 'PERMANENTLY delete all call history for ' + u + '?\n\nThis cannot be undone.', 'Delete History', '#dc2626')
    .then(function(ok) { if (!ok) return;
      waFetch('/api/agents/clear-history', { method: 'POST', body: JSON.stringify({ username: u }) })
        .then(function(d) { d.ok ? (agentToast(d.deleted + ' calls deleted for ' + u, 'success'), loadAgents()) : agentToast(d.error, 'warn'); }).catch(function() {});
    });
}

function agentForceLogout(u) {
  agentConfirm('Force Logout', 'Force logout ' + u + '? All active sessions will be destroyed.', 'Logout', '#ef4444')
    .then(function(ok) { if (!ok) return;
      waFetch('/api/agents/force-logout', { method: 'POST', body: JSON.stringify({ username: u }) })
        .then(function(d) { d.ok ? agentToast(d.sessionsDestroyed + ' session(s) destroyed', 'success') : agentToast(d.error, 'warn'); }).catch(function() {});
    });
}

function clearAllActivity() {
  agentConfirm('Reset All Stats', 'Clear visible activity for ALL agents?\n\nRaw call history is preserved.', 'Reset All', '#d97706')
    .then(function(ok) { if (!ok) return;
      waFetch('/api/agents/clear-all-activity', { method: 'POST' })
        .then(function(d) { d.ok ? (agentToast(d.count + ' agents reset', 'success'), loadAgents()) : agentToast(d.error, 'warn'); }).catch(function() {});
    });
}

function clearAllHistory() {
  agentConfirm('Delete ALL Call History', 'PERMANENTLY delete ALL call history for every agent?\n\nThis cannot be undone.', 'Delete Everything', '#7f1d1d')
    .then(function(ok) { if (!ok) return;
      waFetch('/api/agents/clear-all-history', { method: 'POST' })
        .then(function(d) { d.ok ? (agentToast(d.deleted + ' calls deleted', 'success'), loadAgents()) : agentToast(d.error, 'warn'); }).catch(function() {});
    });
}

// ===== CREATE / EDIT AGENT =====
function agentShowCreateForm() {
  var s = document.getElementById('agentCreateSection');
  s.style.display = s.style.display === 'none' ? '' : 'none';
  if (s.style.display !== 'none') document.getElementById('newAgentUsername').focus();
  // Reset edit state
  document.getElementById('editAgentId').value = '';
  document.getElementById('newAgentUsername').disabled = false;
  document.getElementById('createFormTitle').textContent = 'Add Agent';
  document.getElementById('newAgentUsername').value = '';
  document.getElementById('newAgentPassword').value = '';
  document.getElementById('newAgentName').value = '';
  document.getElementById('newAgentPhone').value = '';
  document.getElementById('newAgentEmail').value = '';
  document.getElementById('newAgentRole').value = 'agent';
  document.getElementById('newAgentNotes').value = '';
  document.getElementById('passwordRow').style.display = '';
}

function openEditAgent(username) {
  var a = agentData.find(function(x) { return x.username === username; });
  if (!a) return;
  var s = document.getElementById('agentCreateSection');
  s.style.display = '';
  document.getElementById('editAgentId').value = username;
  document.getElementById('createFormTitle').textContent = 'Edit: ' + username;
  document.getElementById('newAgentUsername').value = username;
  document.getElementById('newAgentUsername').disabled = true;
  document.getElementById('passwordRow').style.display = 'none';
  document.getElementById('newAgentName').value = a.displayName !== username ? (a.displayName || '') : '';
  document.getElementById('newAgentRole').value = a.role || 'agent';
  document.getElementById('newAgentPhone').value = a.phone || '';
  document.getElementById('newAgentEmail').value = a.email || '';
  document.getElementById('newAgentNotes').value = a.notes || '';
  s.scrollIntoView({ behavior: 'smooth' });
}

function agentCreate() {
  var editId = document.getElementById('editAgentId').value;
  var u = document.getElementById('newAgentUsername').value.trim();
  var p = document.getElementById('newAgentPassword').value;
  var n = document.getElementById('newAgentName').value.trim();
  var r = document.getElementById('newAgentRole').value;
  var ph = document.getElementById('newAgentPhone').value.trim();
  var em = document.getElementById('newAgentEmail').value.trim();
  var notes = document.getElementById('newAgentNotes').value.trim();

  if (editId) {
    // Update existing
    waFetch('/api/agents/update', { method: 'POST', body: JSON.stringify({ username: editId, displayName: n, role: r, active: true, notes: notes, phone: ph, email: em }) })
      .then(function(d) {
        if (d.ok) { agentToast('Agent updated', 'success'); document.getElementById('agentCreateSection').style.display = 'none'; loadAgents(); }
        else agentToast(d.error, 'warn');
      }).catch(function(e) { agentToast(e.message, 'warn'); });
  } else {
    // Create new
    if (!u || !p) return agentToast('Username and password required', 'warn');
    if (u.length < 3) return agentToast('Username min 3 chars', 'warn');
    if (p.length < 6) return agentToast('Password min 6 chars', 'warn');
    waFetch('/api/agents/create', { method: 'POST', body: JSON.stringify({ username: u, password: p, displayName: n, role: r, notes: notes, phone: ph, email: em }) })
      .then(function(d) {
        if (d.ok) { agentToast(u + ' created', 'success'); document.getElementById('agentCreateSection').style.display = 'none'; loadAgents(); }
        else agentToast(d.error, 'warn');
      }).catch(function(e) { agentToast(e.message, 'warn'); });
  }
}

// ===== ARCHIVED + AUDIT =====
function agentShowArchived() {
  var s = document.getElementById('agentExtraSection');
  s.innerHTML = '<div style="text-align:center;padding:20px;"><div class="spinner" style="margin:0 auto;"></div></div>';
  waFetch('/api/agents/archived').then(function(d) {
    var a = d.agents || [];
    if (!a.length) { s.innerHTML = '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;color:#94a3b8;">No archived agents</div>'; return; }
    var html = '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;"><h3 style="margin:0 0 12px;font-size:15px;color:#0f172a;">Archived Agents</h3>';
    a.forEach(function(u) { html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f1f5f9;"><div><strong>' + escapeHtml(u.username) + '</strong> <span style="font-size:11px;color:#94a3b8;">' + u.role + '</span><div style="font-size:11px;color:#94a3b8;">Deleted: ' + (u.deleted_at ? new Date(u.deleted_at).toLocaleString() : '') + '</div></div><button onclick="agentRestore(' + u.id + ')" style="padding:5px 14px;border:none;border-radius:6px;background:#059669;color:white;font-size:12px;font-weight:600;cursor:pointer;">Restore</button></div>'; });
    s.innerHTML = html + '</div>';
  }).catch(function() { s.innerHTML = '<p style="color:#ef4444;">Failed to load</p>'; });
}

function agentRestore(id) {
  agentConfirm('Restore Agent', 'Restore this agent?', 'Restore', '#059669').then(function(ok) { if (!ok) return;
    waFetch('/api/agents/restore', { method: 'POST', body: JSON.stringify({ id: id }) })
      .then(function(d) { d.ok ? (agentToast('Restored', 'success'), agentShowArchived(), loadAgents()) : agentToast(d.error, 'warn'); }).catch(function() {});
  });
}

function agentShowAuditLog() {
  var s = document.getElementById('agentExtraSection');
  s.innerHTML = '<div style="text-align:center;padding:20px;"><div class="spinner" style="margin:0 auto;"></div></div>';
  waFetch('/api/audit-log?limit=50').then(function(d) {
    var logs = d.logs || [];
    if (!logs.length) { s.innerHTML = '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;color:#94a3b8;">No audit entries</div>'; return; }
    var colors = { agent_created: '#059669', agent_updated: '#2563eb', agent_deleted: '#dc2626', agent_activated: '#059669', agent_deactivated: '#d97706', agent_restored: '#059669', password_changed: '#7c3aed', activity_cleared: '#d97706', all_activity_cleared: '#d97706', history_deleted: '#dc2626', all_history_deleted: '#dc2626', force_logout: '#ef4444' };
    s.innerHTML = '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;max-height:400px;overflow:auto;"><h3 style="margin:0 0 12px;font-size:15px;color:#0f172a;">Audit Log</h3><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr><th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e2e8f0;background:#f8fafc;">Time</th><th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e2e8f0;background:#f8fafc;">Action</th><th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e2e8f0;background:#f8fafc;">Target</th><th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e2e8f0;background:#f8fafc;">Details</th><th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e2e8f0;background:#f8fafc;">By</th></tr></thead><tbody>' +
      logs.map(function(l) { return '<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:#94a3b8;white-space:nowrap;">' + new Date(l.created_at).toLocaleString() + '</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:' + (colors[l.action] || '#334155') + ';font-weight:600;">' + escapeHtml(l.action.replace(/_/g, ' ')) + '</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:#0f172a;">' + escapeHtml(l.target || '-') + '</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:#94a3b8;">' + escapeHtml(l.details || '-') + '</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:#94a3b8;">' + escapeHtml(l.performed_by) + '</td></tr>'; }).join('') +
    '</tbody></table></div>';
  }).catch(function() { s.innerHTML = '<p style="color:#ef4444;">Failed to load</p>'; });
}

// ===== AGENT DETAIL MODAL =====
function openAgentDetail(username) {
  var modal = document.getElementById('agentDetailModal');
  var title = document.getElementById('agentDetailTitle');
  var body = document.getElementById('agentDetailBody');
  title.textContent = username;
  body.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner" style="margin:0 auto 12px;"></div>Loading...</div>';
  modal.style.display = 'flex';

  Promise.all([
    waFetch('/api/agents/performance?agent=' + encodeURIComponent(username)),
    waFetch('/api/agents/performance?agent=' + encodeURIComponent(username) + '&period=week'),
    safeFetch('/api/calls?agent=' + encodeURIComponent(username) + '&limit=20'),
  ]).then(function(r) {
    var today = r[0].performance || {}, week = r[1].performance || {}, calls = r[2].calls || [], hourly = r[0].hourly || [];
    var html = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">' +
      dCard('Today Calls', today.total_calls || 0) + dCard('Today Talk', formatTalkTime(today.total_talk_time || 0)) +
      dCard('Week Calls', week.total_calls || 0) + dCard('Week Talk', formatTalkTime(week.total_talk_time || 0)) +
    '</div><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px;">' +
      dCard('Answered', today.answered_calls || 0, '#059669') + dCard('Missed', today.missed_calls || 0, '#dc2626') +
      dCard('Avg Duration', formatTalkTime(Math.round(today.avg_duration || 0))) + dCard('Longest', formatTalkTime(today.longest_call || 0)) +
    '</div>';

    if (hourly.length > 0) {
      html += '<h4 style="margin:0 0 8px;font-size:13px;color:#0f172a;font-weight:700;">Today by Hour</h4>';
      html += '<div style="display:flex;align-items:flex-end;gap:2px;height:60px;margin-bottom:20px;">';
      var maxH = 1, hm = {}; hourly.forEach(function(h) { hm[h.hour] = h; if (h.calls > maxH) maxH = h.calls; });
      for (var i = 0; i < 24; i++) { var hv = hm[i] || { calls: 0 }; html += '<div title="' + i + ':00 — ' + hv.calls + ' calls" style="flex:1;height:' + Math.max(2, Math.round((hv.calls / maxH) * 100)) + '%;background:#3b82f6;border-radius:2px;min-width:0;"></div>'; }
      html += '</div>';
    }

    html += '<h4 style="margin:0 0 8px;font-size:13px;color:#0f172a;font-weight:700;">Recent Calls</h4>';
    if (!calls.length) { html += '<p style="color:#94a3b8;font-size:13px;">No calls</p>'; }
    else {
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr><th style="padding:6px 8px;text-align:left;color:#64748b;font-size:10px;text-transform:uppercase;border-bottom:2px solid #e2e8f0;">Caller</th><th style="padding:6px 8px;color:#64748b;font-size:10px;text-transform:uppercase;border-bottom:2px solid #e2e8f0;">Dir</th><th style="padding:6px 8px;color:#64748b;font-size:10px;text-transform:uppercase;border-bottom:2px solid #e2e8f0;">Status</th><th style="padding:6px 8px;color:#64748b;font-size:10px;text-transform:uppercase;border-bottom:2px solid #e2e8f0;">Duration</th><th style="padding:6px 8px;color:#64748b;font-size:10px;text-transform:uppercase;border-bottom:2px solid #e2e8f0;">Time</th></tr></thead><tbody>';
      calls.forEach(function(c) { var sc = c.call_status === 'answered' ? '#059669' : c.call_status === 'missed' ? '#dc2626' : '#94a3b8'; html += '<tr><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;">' + escapeHtml(c.caller_number) + '</td><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:center;">' + (c.direction === 'outbound' ? '\u2197' : '\u2199') + '</td><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:center;color:' + sc + ';font-weight:600;">' + (c.call_status || '--') + '</td><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:center;">' + formatTalkTime(c.duration) + '</td><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;color:#94a3b8;">' + new Date(c.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '</td></tr>'; });
      html += '</tbody></table>';
    }
    html += '<div style="margin-top:16px;text-align:center;"><button onclick="closeAgentDetail();document.getElementById(\'filterAgent\').value=\'' + username + '\';loadFilteredCalls();" style="padding:8px 20px;border:none;border-radius:6px;background:#3b82f6;color:white;font-size:13px;font-weight:600;cursor:pointer;">View All Calls</button></div>';
    body.innerHTML = html;
  }).catch(function() { body.innerHTML = '<p style="color:#ef4444;text-align:center;padding:40px;">Failed to load</p>'; });
}

function closeAgentDetail() { document.getElementById('agentDetailModal').style.display = 'none'; }

function dCard(label, value, color) {
  return '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;text-align:center;"><div style="font-weight:800;font-size:18px;color:' + (color || '#0f172a') + ';">' + value + '</div><div style="font-size:10px;color:#94a3b8;margin-top:2px;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">' + label + '</div></div>';
}
