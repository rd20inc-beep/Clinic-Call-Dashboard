// ===== AGENT MANAGEMENT UI =====

function loadAgents() {
  var container = document.getElementById('agentCards');
  container.innerHTML = '<div class="empty-state"><div class="modal-loading"><div class="spinner"></div><p>Loading agents...</p></div></div>';

  waFetch('/api/agents')
    .then(function(data) {
      if (!data.agents || data.agents.length === 0) {
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
      var summaryEl = document.getElementById('agentSummary');
      summaryEl.innerHTML =
        '<div style="flex:1;min-width:100px;text-align:center;padding:10px;background:#fff;border-radius:8px;border:1px solid #eee;">' +
          '<div style="font-weight:700;font-size:20px;color:#222;">' + totalAgents + '</div>' +
          '<div style="font-size:11px;color:#999;">Total Agents</div>' +
        '</div>' +
        '<div style="flex:1;min-width:100px;text-align:center;padding:10px;background:#fff;border-radius:8px;border:1px solid #eee;">' +
          '<div style="font-weight:700;font-size:20px;color:#2ecc71;">' + active + '</div>' +
          '<div style="font-size:11px;color:#999;">Active</div>' +
        '</div>' +
        '<div style="flex:1;min-width:100px;text-align:center;padding:10px;background:#fff;border-radius:8px;border:1px solid #eee;">' +
          '<div style="font-weight:700;font-size:20px;color:#f39c12;">' + idle + '</div>' +
          '<div style="font-size:11px;color:#999;">Idle</div>' +
        '</div>' +
        '<div style="flex:1;min-width:100px;text-align:center;padding:10px;background:#fff;border-radius:8px;border:1px solid #eee;">' +
          '<div style="font-weight:700;font-size:20px;color:#e74c3c;">' + offline + '</div>' +
          '<div style="font-size:11px;color:#999;">Offline</div>' +
        '</div>';

      container.innerHTML = data.agents.map(function(a) {
        // Status
        var statusColor = { active: '#2ecc71', idle: '#f39c12', offline: '#e74c3c' }[a.status] || '#e74c3c';
        var statusLabel = a.status.charAt(0).toUpperCase() + a.status.slice(1);

        // Role badge
        var roleBadge = a.role === 'admin'
          ? '<span style="background:#7b1fa2;color:white;font-size:10px;padding:2px 8px;border-radius:4px;">ADMIN</span>'
          : '<span style="background:#1565c0;color:white;font-size:10px;padding:2px 8px;border-radius:4px;">AGENT</span>';

        // Monitor badge (only for agents)
        var monitorBadge = '';
        if (a.role !== 'admin') {
          var mColor = a.monitorAlive ? '#2ecc71' : '#e74c3c';
          var mLabel = a.monitorAlive ? 'Monitor On' : 'Monitor Off';
          monitorBadge = '<span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;color:' + mColor + ';margin-left:8px;"><span style="width:6px;height:6px;border-radius:50%;background:' + mColor + ';display:inline-block;"></span>' + mLabel + '</span>';
        }

        // Last seen
        var lastSeen = '';
        if (a.lastHeartbeat) {
          var ago = Math.floor((Date.now() - a.lastHeartbeat) / 1000);
          if (ago < 10) lastSeen = 'Just now';
          else if (ago < 60) lastSeen = ago + 's ago';
          else if (ago < 3600) lastSeen = Math.floor(ago / 60) + 'm ago';
          else if (ago < 86400) lastSeen = Math.floor(ago / 3600) + 'h ago';
          else lastSeen = new Date(a.lastHeartbeat).toLocaleDateString();
        } else {
          lastSeen = 'Never';
        }

        // Answer rate color
        var rateColor = a.answerRate >= 80 ? '#2ecc71' : a.answerRate >= 50 ? '#f39c12' : '#e74c3c';

        // Format duration
        var avgDur = a.avgDuration > 0 ? formatCallDuration(a.avgDuration) : '--';

        return '<div style="background:#fff;border-radius:10px;border:1px solid #eee;box-shadow:0 1px 4px rgba(0,0,0,0.06);overflow:hidden;">' +
          // Header
          '<div style="padding:14px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f0f0;">' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
              '<span style="width:10px;height:10px;border-radius:50%;background:' + statusColor + ';display:inline-block;flex-shrink:0;"></span>' +
              '<span style="font-weight:700;font-size:15px;color:#222;">' + a.username + '</span>' +
              roleBadge +
              monitorBadge +
            '</div>' +
            '<span style="font-size:12px;color:' + statusColor + ';font-weight:600;">' + statusLabel + '</span>' +
          '</div>' +
          // Stats grid
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
          // Footer
          '<div style="padding:10px 16px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid #f0f0f0;">' +
            '<span style="font-size:11px;color:#999;">Last seen: ' + lastSeen + '</span>' +
            '<button onclick="agentChangePassword(\'' + a.username + '\')" style="padding:4px 10px;border:1px solid #ddd;border-radius:4px;background:#fff;color:#555;font-size:11px;cursor:pointer;">Reset Password</button>' +
          '</div>' +
        '</div>';
      }).join('');
    })
    .catch(function(err) {
      container.innerHTML = '<div class="empty-state"><p>Failed to load agents</p></div>';
    });
}

function agentStatCell(label, value, color) {
  var valStyle = color ? 'color:' + color + ';' : 'color:#222;';
  return '<div style="background:#fff;text-align:center;padding:10px 4px;">' +
    '<div style="font-weight:700;font-size:16px;' + valStyle + '">' + value + '</div>' +
    '<div style="font-size:10px;color:#999;margin-top:2px;">' + label + '</div>' +
  '</div>';
}

function agentChangePassword(username) {
  var pw = prompt('New password for ' + username + ' (min 6 characters):');
  if (!pw || pw.length < 6) {
    if (pw !== null) alert('Password must be at least 6 characters.');
    return;
  }

  waFetch('/api/agents/change-password', {
    method: 'POST',
    body: JSON.stringify({ username: username, password: pw })
  })
    .then(function(data) {
      if (data.ok) alert('Password changed for ' + username + '.');
      else alert('Error: ' + (data.error || 'Unknown'));
    })
    .catch(function(err) { alert('Error: ' + err.message); });
}
