// ===== WHATSAPP CHAT UI =====

var waBotEnabled = true;
var waExtensionConnected = false;

function waOpenChat(phone, name) {
  waCurrentChatPhone = phone;
  document.getElementById('waConversations').style.display = 'none';
  document.getElementById('waChatView').style.display = 'block';
  document.getElementById('waChatName').textContent = name;
  waUpdatePauseBtn();

  fetch('/api/whatsapp/history/' + encodeURIComponent(phone))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var container = document.getElementById('waChatMessages');
      if (!data.messages || data.messages.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No messages</p></div>';
        return;
      }
      container.innerHTML = data.messages.map(function(m) {
        var time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        var typeLabel = m.message_type !== 'chat' ? ' [' + m.message_type + ']' : '';
        var statusLabel = '';
        if (m.direction === 'out' && m.status === 'failed') {
          statusLabel = ' <span style="color:#e74c3c;font-size:11px;">[FAILED]</span>';
        } else if (m.direction === 'out' && m.status === 'rejected') {
          statusLabel = ' <span style="color:#e74c3c;font-size:11px;">[REJECTED]</span>';
        } else if (m.direction === 'out' && m.status === 'expired') {
          statusLabel = ' <span style="color:#e67e22;font-size:11px;">[EXPIRED]</span>';
        } else if (m.direction === 'out' && m.status === 'sending') {
          statusLabel = ' <span style="color:#3498db;font-size:11px;">[SENDING]</span>';
        } else if (m.direction === 'out' && m.status === 'approved') {
          statusLabel = ' <span style="color:#2ecc71;font-size:11px;">[APPROVED]</span>';
        } else if (m.direction === 'out' && m.status === 'pending') {
          statusLabel = ' <span style="color:#f39c12;font-size:11px;">[AWAITING APPROVAL]</span>';
        }
        var sentInfo = '';
        if (m.sent_at) {
          sentInfo = ' <span style="color:#999;font-size:10px;">sent ' + new Date(m.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</span>';
        }
        return '<div class="wa-msg ' + m.direction + '">' +
          '<div>' + escapeHtml(m.message) + typeLabel + statusLabel + '</div>' +
          '<div class="wa-msg-time">' + time + sentInfo + '</div>' +
        '</div>';
      }).join('');
      container.scrollTop = container.scrollHeight;
    })
    .catch(function() {});
}

function waUpdatePauseBtn() {
  var btn = document.getElementById('waPauseBtn');

  if (!waExtensionConnected) {
    btn.textContent = 'Not Connected';
    btn.style.background = '#e74c3c';
    btn.style.cursor = 'not-allowed';
    btn.style.opacity = '0.7';
    btn.disabled = true;
    return;
  }

  if (!waBotEnabled) {
    btn.textContent = 'Bot Disabled';
    btn.style.background = '#e74c3c';
    btn.style.cursor = 'not-allowed';
    btn.style.opacity = '0.7';
    btn.disabled = true;
    return;
  }

  btn.disabled = false;
  btn.style.cursor = 'pointer';
  btn.style.opacity = '1';
  var isPaused = waPausedChats.has(waCurrentChatPhone);
  btn.textContent = isPaused ? 'Resume Bot' : 'Pause Bot';
  btn.style.background = isPaused ? '#2ecc71' : 'rgba(255,255,255,0.2)';
}

function waTogglePause() {
  if (!waCurrentChatPhone || !waExtensionConnected || !waBotEnabled) return;
  var isPaused = waPausedChats.has(waCurrentChatPhone);
  var endpoint = isPaused ? '/api/whatsapp/resume' : '/api/whatsapp/pause';

  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: waCurrentChatPhone })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        if (data.paused) {
          waPausedChats.add(waCurrentChatPhone);
        } else {
          waPausedChats.delete(waCurrentChatPhone);
        }
        waUpdatePauseBtn();
      }
    })
    .catch(function() {});
}

function waCloseChat() {
  waCurrentChatPhone = null;
  document.getElementById('waChatView').style.display = 'none';
  document.getElementById('waConversations').style.display = 'flex';
  loadWaConversations(); // refresh to show updated pause status
}

function waSendManual() {
  var phone = document.getElementById('waSendPhone').value.trim();
  var message = document.getElementById('waSendMessage').value.trim();
  if (!phone || !message) return alert('Please enter both phone number and message');

  fetch('/api/whatsapp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phone, message: message })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        document.getElementById('waSendPhone').value = '';
        document.getElementById('waSendMessage').value = '';
        alert('Message queued! It will be sent when WhatsApp Web is open with the extension active.');
        loadWaStats();
      } else {
        alert('Error: ' + (data.error || 'Unknown error'));
      }
    })
    .catch(function(err) { alert('Error: ' + err.message); });
}

// ===== MESSAGE APPROVAL =====

function waApproveMessage(id) {
  fetch('/api/whatsapp/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) { loadWaApprovalQueue(); loadWaStats(); }
    })
    .catch(function() {});
}

function waRejectMessage(id) {
  fetch('/api/whatsapp/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) { loadWaApprovalQueue(); loadWaStats(); }
    })
    .catch(function() {});
}

function waApproveAllMessages() {
  if (!confirm('Approve all pending messages for sending?')) return;
  fetch('/api/whatsapp/approve-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) { loadWaApprovalQueue(); loadWaStats(); }
    })
    .catch(function() {});
}

// ===== EXTENSION CONNECTION STATUS =====

function waUpdateExtensionStatus(lastSeen) {
  var dot = document.getElementById('waExtDot');
  var label = document.getElementById('waExtLabel');
  var detail = document.getElementById('waExtDetail');
  var container = document.getElementById('waExtensionStatus');
  var prevConnected = waExtensionConnected;

  if (!lastSeen) {
    waExtensionConnected = false;
    dot.style.background = '#e74c3c';
    label.textContent = 'Extension: Disconnected';
    detail.textContent = 'No activity detected since server start';
    container.style.background = 'rgba(231,76,60,0.15)';
    container.style.borderColor = 'rgba(231,76,60,0.3)';
    if (prevConnected !== waExtensionConnected) waUpdatePauseBtn();
    return;
  }

  var lastSeenDate = new Date(lastSeen);
  var secondsAgo = Math.floor((Date.now() - lastSeenDate.getTime()) / 1000);

  if (secondsAgo < 60) {
    waExtensionConnected = true;
    dot.style.background = '#2ecc71';
    label.textContent = 'Extension: Connected';
    detail.textContent = 'Last seen ' + secondsAgo + 's ago';
    container.style.background = 'rgba(46,204,113,0.15)';
    container.style.borderColor = 'rgba(46,204,113,0.3)';
  } else if (secondsAgo < 300) {
    waExtensionConnected = false;
    dot.style.background = '#f39c12';
    label.textContent = 'Extension: Idle';
    var mins = Math.floor(secondsAgo / 60);
    detail.textContent = 'Last seen ' + mins + 'm ago';
    container.style.background = 'rgba(243,156,18,0.15)';
    container.style.borderColor = 'rgba(243,156,18,0.3)';
  } else {
    waExtensionConnected = false;
    dot.style.background = '#e74c3c';
    label.textContent = 'Extension: Disconnected';
    var minsAgo = Math.floor(secondsAgo / 60);
    detail.textContent = 'Last seen ' + minsAgo + 'm ago';
    container.style.background = 'rgba(231,76,60,0.15)';
    container.style.borderColor = 'rgba(231,76,60,0.3)';
  }

  if (prevConnected !== waExtensionConnected) waUpdatePauseBtn();
}

// ===== GLOBAL BOT TOGGLE =====

function waUpdateBotToggle(enabled) {
  waBotEnabled = enabled;
  var bar = document.getElementById('waBotToggleBar');
  var statusText = document.getElementById('waBotStatusText');
  var btn = document.getElementById('waBotToggleBtn');

  if (enabled) {
    bar.style.background = 'rgba(46,204,113,0.15)';
    bar.style.borderColor = 'rgba(46,204,113,0.3)';
    statusText.textContent = 'ENABLED';
    statusText.style.color = '#2ecc71';
    btn.textContent = 'Disable Bot';
    btn.style.background = '#e74c3c';
  } else {
    bar.style.background = 'rgba(231,76,60,0.15)';
    bar.style.borderColor = 'rgba(231,76,60,0.3)';
    statusText.textContent = 'DISABLED';
    statusText.style.color = '#e74c3c';
    btn.textContent = 'Enable Bot';
    btn.style.background = '#2ecc71';
  }

  // Refresh pause button since it depends on bot enabled state
  waUpdatePauseBtn();
}

function waToggleBot() {
  var newState = !waBotEnabled;
  var action = newState ? 'enable' : 'disable';
  if (!confirm('Are you sure you want to ' + action + ' the WhatsApp bot globally?\n\nThis affects ALL chats, AI replies, and appointment messages.')) return;

  fetch('/api/whatsapp/bot-toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: newState })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        waUpdateBotToggle(data.enabled);
      } else {
        alert('Error: ' + (data.error || 'Unknown error'));
      }
    })
    .catch(function(err) { alert('Error: ' + err.message); });
}

// ===== FAILED MESSAGES =====

function waShowFailed() {
  fetch('/api/whatsapp/failed')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.messages || data.messages.length === 0) {
        alert('No failed messages.');
        return;
      }
      var container = document.getElementById('waConversations');
      var html = '<div style="padding:12px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
          '<h3 style="margin:0;font-size:16px;font-weight:600;color:#e74c3c;">Failed Messages (' + data.messages.length + ')</h3>' +
          '<div>' +
            '<button onclick="waRetryAll()" style="padding:6px 14px;border:none;border-radius:6px;background:#f39c12;color:white;font-weight:600;cursor:pointer;margin-right:8px;">Retry All</button>' +
            '<button onclick="loadWaConversations()" style="padding:6px 14px;border:none;border-radius:6px;background:rgba(255,255,255,0.2);color:white;font-weight:600;cursor:pointer;">Back</button>' +
          '</div>' +
        '</div>';
      data.messages.forEach(function(m) {
        var time = new Date(m.created_at).toLocaleString();
        html += '<div style="background:rgba(231,76,60,0.1);border:1px solid rgba(231,76,60,0.2);border-radius:8px;padding:12px;margin-bottom:8px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:start;">' +
            '<div style="flex:1;">' +
              '<div style="font-weight:600;font-size:13px;">' + escapeHtml(m.phone) + ' <span style="color:#999;font-weight:400;">' + m.message_type + '</span></div>' +
              '<div style="font-size:12px;color:#ccc;margin-top:2px;">' + time + '</div>' +
              '<div style="font-size:13px;margin-top:6px;color:#ddd;">' + escapeHtml((m.message || '').substring(0, 120)) + (m.message && m.message.length > 120 ? '...' : '') + '</div>' +
            '</div>' +
            '<button onclick="waRetryOne(' + m.id + ')" style="padding:4px 12px;border:none;border-radius:4px;background:#f39c12;color:white;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;margin-left:8px;">Retry</button>' +
          '</div>' +
        '</div>';
      });
      html += '</div>';
      container.innerHTML = html;
    })
    .catch(function() {});
}

function waRetryOne(id) {
  fetch('/api/whatsapp/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        waShowFailed(); // refresh the list
        loadWaStats();
      }
    })
    .catch(function() {});
}

function waRetryAll() {
  if (!confirm('Retry all failed messages?')) return;
  fetch('/api/whatsapp/retry-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        alert(data.count + ' message(s) re-queued for sending.');
        loadWaConversations();
        loadWaStats();
      }
    })
    .catch(function() {});
}
