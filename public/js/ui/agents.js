// ===== AGENT MANAGEMENT UI =====

function loadAgents() {
  waFetch('/api/agents')
    .then(function(data) {
      var container = document.getElementById('agentCards');
      if (!data.agents || data.agents.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No agents configured</p></div>';
        return;
      }

      container.innerHTML = data.agents.map(function(a) {
        var isOnline = a.online;
        var statusDot = isOnline ? '#2ecc71' : '#e74c3c';
        var statusText = isOnline ? 'Online' : 'Offline';
        var monitorBadge = '';
        if (a.role !== 'admin') {
          var monitorColor = a.monitorAlive ? '#2ecc71' : '#e74c3c';
          var monitorLabel = a.monitorAlive ? 'Monitor On' : 'Monitor Off';
          monitorBadge = '<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:' + monitorColor + ';"><span style="width:6px;height:6px;border-radius:50%;background:' + monitorColor + ';display:inline-block;"></span>' + monitorLabel + '</span>';
        }

        var lastSeen = '';
        if (a.lastHeartbeat) {
          var ago = Math.floor((Date.now() - a.lastHeartbeat) / 1000);
          if (ago < 60) lastSeen = ago + 's ago';
          else if (ago < 3600) lastSeen = Math.floor(ago / 60) + 'm ago';
          else lastSeen = Math.floor(ago / 3600) + 'h ago';
          lastSeen = 'Last heartbeat: ' + lastSeen;
        }

        var roleTag = a.role === 'admin'
          ? '<span style="background:#7b1fa2;color:white;font-size:10px;padding:2px 8px;border-radius:4px;">ADMIN</span>'
          : '<span style="background:#1565c0;color:white;font-size:10px;padding:2px 8px;border-radius:4px;">AGENT</span>';

        var changePwBtn = '<button onclick="event.stopPropagation();agentChangePassword(\'' + a.username + '\')" style="padding:4px 10px;border:1px solid #ddd;border-radius:4px;background:#fff;color:#555;font-size:11px;cursor:pointer;">Change Password</button>';

        return '<div style="background:#fff;border-radius:10px;padding:16px;border:1px solid #eee;box-shadow:0 1px 4px rgba(0,0,0,0.06);">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
              '<span style="width:10px;height:10px;border-radius:50%;background:' + statusDot + ';display:inline-block;"></span>' +
              '<span style="font-weight:700;font-size:15px;color:#222;">' + a.username + '</span>' +
              roleTag +
            '</div>' +
            '<span style="font-size:12px;color:' + (isOnline ? '#2ecc71' : '#999') + ';font-weight:600;">' + statusText + '</span>' +
          '</div>' +
          '<div style="display:flex;gap:16px;margin-bottom:8px;">' +
            '<div style="text-align:center;flex:1;background:#f8f9fa;border-radius:6px;padding:8px;">' +
              '<div style="font-weight:700;font-size:18px;color:#222;">' + a.todayCalls + '</div>' +
              '<div style="font-size:11px;color:#888;">Today</div>' +
            '</div>' +
            '<div style="text-align:center;flex:1;background:#f8f9fa;border-radius:6px;padding:8px;">' +
              '<div style="font-weight:700;font-size:18px;color:#222;">' + a.totalCalls + '</div>' +
              '<div style="font-size:11px;color:#888;">Total Calls</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;">' +
            '<div>' +
              monitorBadge +
              (lastSeen ? '<div style="font-size:10px;color:#bbb;margin-top:2px;">' + lastSeen + '</div>' : '') +
            '</div>' +
            changePwBtn +
          '</div>' +
        '</div>';
      }).join('');
    })
    .catch(function() {});
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
