// ===== AGENT MANAGEMENT UI =====

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

      // Summary bar
      var active = 0, idle = 0, offline = 0, totalAgents = 0;
      data.agents.forEach(function(a) {
        if (a.role === 'admin') return;
        totalAgents++;
        if (a.status === 'active') active++;
        else if (a.status === 'idle') idle++;
        else offline++;
      });
      document.getElementById('agentSummary').innerHTML =
        agentSummaryCard('Total Agents', totalAgents, '#222') +
        agentSummaryCard('Active', active, '#2ecc71') +
        agentSummaryCard('Idle', idle, '#f39c12') +
        agentSummaryCard('Offline', offline, '#e74c3c');

      // Agent cards
      container.innerHTML = data.agents.map(function(a) { return renderAgentCard(a); }).join('');
    })
    .catch(function() {
      container.innerHTML = '<div class="empty-state"><p>Failed to load agents</p></div>';
    });
}

function agentSummaryCard(label, value, color) {
  return '<div style="flex:1;min-width:90px;text-align:center;padding:10px;background:#fff;border-radius:8px;border:1px solid #eee;">' +
    '<div style="font-weight:700;font-size:20px;color:' + color + ';">' + value + '</div>' +
    '<div style="font-size:11px;color:#999;">' + label + '</div>' +
  '</div>';
}

function agentStatCell(label, value, color) {
  var valStyle = color ? 'color:' + color + ';' : 'color:#222;';
  return '<div style="background:#fff;text-align:center;padding:10px 4px;">' +
    '<div style="font-weight:700;font-size:16px;' + valStyle + '">' + value + '</div>' +
    '<div style="font-size:10px;color:#999;margin-top:2px;">' + label + '</div>' +
  '</div>';
}

function renderAgentCard(a) {
  var statusColor = { active: '#2ecc71', idle: '#f39c12', offline: '#e74c3c' }[a.status] || '#e74c3c';
  var statusLabel = a.status.charAt(0).toUpperCase() + a.status.slice(1);
  var roleBadge = a.role === 'admin'
    ? '<span style="background:#7b1fa2;color:white;font-size:10px;padding:2px 8px;border-radius:4px;">ADMIN</span>'
    : '<span style="background:#1565c0;color:white;font-size:10px;padding:2px 8px;border-radius:4px;">AGENT</span>';

  var inactiveBadge = '';
  if (!a.active) inactiveBadge = ' <span style="background:#e74c3c;color:white;font-size:9px;padding:1px 6px;border-radius:3px;">INACTIVE</span>';

  var monitorBadge = '';
  if (a.role !== 'admin') {
    var mColor = a.monitorAlive ? '#2ecc71' : '#e74c3c';
    var mLabel = a.monitorAlive ? 'Monitor On' : 'Monitor Off';
    monitorBadge = '<span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;color:' + mColor + ';margin-left:8px;"><span style="width:6px;height:6px;border-radius:50%;background:' + mColor + ';display:inline-block;"></span>' + mLabel + '</span>';
  }

  var lastSeen = agentLastSeen(a.lastActivity || a.lastHeartbeat);
  var rateColor = a.answerRate >= 80 ? '#2ecc71' : a.answerRate >= 50 ? '#f39c12' : '#e74c3c';
  var avgDur = a.avgDuration > 0 ? formatCallDuration(a.avgDuration) : '--';
  var displayName = a.displayName && a.displayName !== a.username ? ' (' + escapeHtml(a.displayName) + ')' : '';
  var isDbAgent = a.source === 'db';

  // Action buttons
  var actions = '<button onclick="agentChangePassword(\'' + a.username + '\')" style="padding:3px 8px;border:1px solid #ddd;border-radius:4px;background:#fff;color:#555;font-size:11px;cursor:pointer;">Reset Password</button>';

  if (isDbAgent) {
    if (a.active) {
      actions += ' <button onclick="agentToggleActive(\'' + a.username + '\',false)" style="padding:3px 8px;border:none;border-radius:4px;background:#f39c12;color:white;font-size:11px;cursor:pointer;">Deactivate</button>';
    } else {
      actions += ' <button onclick="agentToggleActive(\'' + a.username + '\',true)" style="padding:3px 8px;border:none;border-radius:4px;background:#2ecc71;color:white;font-size:11px;cursor:pointer;">Activate</button>';
    }
    actions += ' <button onclick="agentDelete(\'' + a.username + '\')" style="padding:3px 8px;border:none;border-radius:4px;background:#e74c3c;color:white;font-size:11px;cursor:pointer;">Delete</button>';
  }

  return '<div style="background:#fff;border-radius:10px;border:1px solid #eee;box-shadow:0 1px 4px rgba(0,0,0,0.06);overflow:hidden;' + (!a.active ? 'opacity:0.6;' : '') + '">' +
    '<div style="padding:14px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f0f0;">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:' + statusColor + ';display:inline-block;flex-shrink:0;"></span>' +
        '<span style="font-weight:700;font-size:15px;color:#222;">' + escapeHtml(a.username) + '</span>' +
        '<span style="font-size:12px;color:#888;">' + displayName + '</span>' +
        roleBadge + inactiveBadge + monitorBadge +
      '</div>' +
      '<span style="font-size:12px;color:' + statusColor + ';font-weight:600;">' + statusLabel + '</span>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#f0f0f0;">' +
      agentStatCell('Today', a.todayCalls) +
      agentStatCell('Week', a.weekCalls) +
      agentStatCell('Total', a.totalCalls) +
      agentStatCell('Rate', a.answerRate + '%', rateColor) +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#f0f0f0;">' +
      agentStatCell('Answered', a.answeredCalls, '#2ecc71') +
      agentStatCell('Missed', a.missedCalls, '#e74c3c') +
      agentStatCell('Avg Time', avgDur) +
    '</div>' +
    '<div style="padding:10px 16px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid #f0f0f0;flex-wrap:wrap;gap:6px;">' +
      '<span style="font-size:11px;color:#999;">Last seen: ' + lastSeen + '</span>' +
      '<div style="display:flex;gap:4px;flex-wrap:wrap;">' + actions + '</div>' +
    '</div>' +
  '</div>';
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

// ===== AGENT ACTIONS =====

function agentChangePassword(username) {
  var pw = prompt('New password for ' + username + ' (min 6 characters):');
  if (!pw || pw.length < 6) {
    if (pw !== null) alert('Password must be at least 6 characters.');
    return;
  }
  waFetch('/api/agents/change-password', { method: 'POST', body: JSON.stringify({ username: username, password: pw }) })
    .then(function(data) {
      if (data.ok) alert('Password changed for ' + username + '.');
      else alert('Error: ' + (data.error || 'Unknown'));
    })
    .catch(function(err) { alert('Error: ' + err.message); });
}

function agentToggleActive(username, active) {
  var action = active ? 'activate' : 'deactivate';
  if (!confirm('Are you sure you want to ' + action + ' ' + username + '?')) return;
  waFetch('/api/agents/toggle-active', { method: 'POST', body: JSON.stringify({ username: username, active: active }) })
    .then(function(data) {
      if (data.ok) loadAgents();
      else alert('Error: ' + (data.error || 'Unknown'));
    })
    .catch(function(err) { alert('Error: ' + err.message); });
}

function agentDelete(username) {
  if (!confirm('Are you sure you want to DELETE agent ' + username + '?\n\nThis action cannot be undone.')) return;
  if (!confirm('FINAL CONFIRMATION: Delete ' + username + ' permanently?')) return;
  waFetch('/api/agents/delete', { method: 'POST', body: JSON.stringify({ username: username }) })
    .then(function(data) {
      if (data.ok) loadAgents();
      else alert('Error: ' + (data.error || 'Unknown'));
    })
    .catch(function(err) { alert('Error: ' + err.message); });
}

// ===== CREATE AGENT =====

function agentShowCreateForm() {
  var section = document.getElementById('agentCreateSection');
  section.style.display = section.style.display === 'none' ? '' : 'none';
}

function agentCreate() {
  var username = document.getElementById('newAgentUsername').value.trim();
  var password = document.getElementById('newAgentPassword').value;
  var displayName = document.getElementById('newAgentName').value.trim();
  var role = document.getElementById('newAgentRole').value;
  var notes = document.getElementById('newAgentNotes').value.trim();

  if (!username || !password) return alert('Username and password are required.');
  if (username.length < 3) return alert('Username must be at least 3 characters.');
  if (password.length < 6) return alert('Password must be at least 6 characters.');

  waFetch('/api/agents/create', {
    method: 'POST',
    body: JSON.stringify({ username: username, password: password, displayName: displayName, role: role, notes: notes })
  })
    .then(function(data) {
      if (data.ok) {
        alert('Agent ' + username + ' created successfully.');
        document.getElementById('newAgentUsername').value = '';
        document.getElementById('newAgentPassword').value = '';
        document.getElementById('newAgentName').value = '';
        document.getElementById('newAgentNotes').value = '';
        document.getElementById('agentCreateSection').style.display = 'none';
        loadAgents();
      } else {
        alert('Error: ' + (data.error || 'Unknown'));
      }
    })
    .catch(function(err) { alert('Error: ' + err.message); });
}
