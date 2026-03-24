// ===== FLOATING CHAT WIDGET =====
// Works on both admin and agent dashboards
(function() {
  var chatOpen = false;
  var chatUser = null; // who we're chatting with
  var chatContacts = [];
  var myUsername = null;
  var unreadCounts = {};

  // Inject CSS
  var style = document.createElement('style');
  style.textContent = [
    '.chat-fab { position:fixed;bottom:24px;right:24px;width:52px;height:52px;border-radius:50%;background:#3b82f6;color:#fff;border:none;cursor:pointer;box-shadow:0 4px 16px rgba(59,130,246,0.4);z-index:9000;display:flex;align-items:center;justify-content:center;transition:transform 0.2s;font-size:22px; }',
    '.chat-fab:hover { transform:scale(1.08); }',
    '.chat-fab-badge { position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;font-size:10px;font-weight:700;min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 4px; }',
    '.chat-panel { position:fixed;bottom:24px;right:24px;width:360px;height:480px;background:#fff;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.18);z-index:9001;display:none;flex-direction:column;overflow:hidden;border:1px solid #e2e8f0; }',
    '.chat-panel.open { display:flex; }',
    '.chat-header { background:#0f172a;color:#fff;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0; }',
    '.chat-header h4 { font-size:14px;font-weight:700;margin:0; }',
    '.chat-header button { background:none;border:none;color:#94a3b8;cursor:pointer;font-size:18px;padding:0 4px; }',
    '.chat-header button:hover { color:#fff; }',
    '.chat-contacts { flex:1;overflow-y:auto;padding:8px; }',
    '.chat-contact { display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;transition:background 0.1s; }',
    '.chat-contact:hover { background:#f1f5f9; }',
    '.chat-contact-name { font-size:13px;font-weight:600;color:#0f172a; }',
    '.chat-contact-role { font-size:10px;color:#94a3b8; }',
    '.chat-contact-unread { background:#ef4444;color:#fff;font-size:10px;font-weight:700;min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;margin-left:auto; }',
    '.chat-messages { flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:6px;background:#f8fafc; }',
    '.chat-msg { max-width:80%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.4;word-wrap:break-word; }',
    '.chat-msg-out { background:#3b82f6;color:#fff;align-self:flex-end;border-bottom-right-radius:4px; }',
    '.chat-msg-in { background:#e2e8f0;color:#0f172a;align-self:flex-start;border-bottom-left-radius:4px; }',
    '.chat-msg-time { font-size:9px;opacity:0.6;margin-top:2px; }',
    '.chat-input { display:flex;gap:8px;padding:10px 12px;border-top:1px solid #e2e8f0;background:#fff;flex-shrink:0; }',
    '.chat-input input { flex:1;padding:8px 12px;border:1px solid #e2e8f0;border-radius:20px;font-size:13px;outline:none;font-family:inherit; }',
    '.chat-input input:focus { border-color:#3b82f6; }',
    '.chat-input button { padding:8px 14px;background:#3b82f6;color:#fff;border:none;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer; }',
    '.chat-back { background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px;margin-right:8px; }'
  ].join('\n');
  document.head.appendChild(style);

  // Create FAB
  var fab = document.createElement('button');
  fab.className = 'chat-fab';
  fab.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>';
  fab.onclick = function() { toggleChat(); };
  document.body.appendChild(fab);

  var badgeEl = document.createElement('div');
  badgeEl.className = 'chat-fab-badge';
  badgeEl.style.display = 'none';
  fab.appendChild(badgeEl);

  // Create panel
  var panel = document.createElement('div');
  panel.className = 'chat-panel';
  panel.innerHTML = '<div class="chat-header"><div style="display:flex;align-items:center;"><button class="chat-back" id="chatBack" style="display:none;" onclick="chatGoBack()">&larr;</button><h4 id="chatTitle">Messages</h4></div><button onclick="toggleChat()">&times;</button></div><div class="chat-contacts" id="chatContacts"></div><div class="chat-messages" id="chatMessages" style="display:none;"></div><div class="chat-input" id="chatInput" style="display:none;"><input type="text" id="chatInputField" placeholder="Type a message..." onkeydown="if(event.key===\'Enter\')chatSend()"><button onclick="chatSend()">Send</button></div>';
  document.body.appendChild(panel);

  // Detect current user
  function detectUser() {
    if (myUsername) return;
    fetch('/api/me').then(function(r) { return r.json(); }).then(function(d) {
      if (d.username) myUsername = d.username;
    }).catch(function() {});
  }
  setTimeout(detectUser, 500);

  // Toggle chat
  window.toggleChat = function() {
    chatOpen = !chatOpen;
    panel.classList.toggle('open', chatOpen);
    fab.style.display = chatOpen ? 'none' : 'flex';
    if (chatOpen && !chatUser) loadContacts();
  };

  // Load contacts
  window.loadChatContacts = loadContacts;
  function loadContacts() {
    chatUser = null;
    document.getElementById('chatBack').style.display = 'none';
    document.getElementById('chatTitle').textContent = 'Messages';
    document.getElementById('chatContacts').style.display = '';
    document.getElementById('chatMessages').style.display = 'none';
    document.getElementById('chatInput').style.display = 'none';
    fetch('/api/chat/contacts').then(function(r) { return r.json(); }).then(function(d) {
      chatContacts = d.contacts || [];
      renderContacts();
    }).catch(function() {});
  }

  function renderContacts() {
    var el = document.getElementById('chatContacts');
    if (!chatContacts.length) { el.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;font-size:13px;">No contacts</div>'; return; }
    var html = '';
    chatContacts.forEach(function(c) {
      var unread = unreadCounts[c.username] || 0;
      var initials = (c.full_name || c.username).split(' ').map(function(w) { return w[0]; }).join('').substring(0, 2).toUpperCase();
      html += '<div class="chat-contact" onclick="openChat(\'' + c.username + '\',\'' + (c.full_name || c.username).replace(/'/g, "\\'") + '\')">';
      html += '<div style="width:36px;height:36px;border-radius:50%;background:#e2e8f0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#475569;flex-shrink:0;">' + initials + '</div>';
      html += '<div><div class="chat-contact-name">' + (c.full_name || c.username) + '</div><div class="chat-contact-role">' + c.role + (c.status === 'disabled' ? ' (disabled)' : '') + '</div></div>';
      if (unread > 0) html += '<div class="chat-contact-unread">' + unread + '</div>';
      html += '</div>';
    });
    el.innerHTML = html;
  }

  // Open chat with specific user
  window.openChat = function(username, displayName) {
    chatUser = username;
    document.getElementById('chatBack').style.display = '';
    document.getElementById('chatTitle').textContent = displayName;
    document.getElementById('chatContacts').style.display = 'none';
    document.getElementById('chatMessages').style.display = 'flex';
    document.getElementById('chatInput').style.display = 'flex';
    document.getElementById('chatInputField').focus();
    // Load history
    fetch('/api/chat/history/' + username).then(function(r) { return r.json(); }).then(function(d) {
      var el = document.getElementById('chatMessages');
      if (!d.messages || !d.messages.length) { el.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;font-size:12px;">No messages yet. Say hello!</div>'; return; }
      var html = '';
      d.messages.forEach(function(m) {
        var isMe = m.from_user === myUsername;
        var time = new Date(m.created_at + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        html += '<div class="chat-msg ' + (isMe ? 'chat-msg-out' : 'chat-msg-in') + '">';
        html += m.message.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        html += '<div class="chat-msg-time">' + time + '</div>';
        html += '</div>';
      });
      el.innerHTML = html;
      el.scrollTop = el.scrollHeight;
      // Clear unread for this user
      if (unreadCounts[username]) { delete unreadCounts[username]; updateBadge(); renderContacts(); }
    }).catch(function() {});
  };

  window.chatGoBack = function() { loadContacts(); };

  // Send message
  window.chatSend = function() {
    var input = document.getElementById('chatInputField');
    var msg = input.value.trim();
    if (!msg || !chatUser) return;
    input.value = '';
    // Optimistic append
    var el = document.getElementById('chatMessages');
    var emptyMsg = el.querySelector('div[style*="text-align:center"]');
    if (emptyMsg) emptyMsg.remove();
    var div = document.createElement('div');
    div.className = 'chat-msg chat-msg-out';
    div.innerHTML = msg.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '<div class="chat-msg-time">now</div>';
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
    fetch('/api/chat/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: chatUser, message: msg }) }).catch(function() {});
  };

  // Socket listener for incoming messages
  function setupSocketListener() {
    if (typeof socket === 'undefined') { setTimeout(setupSocketListener, 1000); return; }
    socket.on('chat_message', function(data) {
      if (!myUsername) return;
      var isForMe = data.to === myUsername;
      var isFromMe = data.from === myUsername;
      if (!isForMe && !isFromMe) return;
      var otherUser = isFromMe ? data.to : data.from;
      // If chat is open with this user, append
      if (chatOpen && chatUser === otherUser && !isFromMe) {
        var el = document.getElementById('chatMessages');
        var emptyMsg = el.querySelector('div[style*="text-align:center"]');
        if (emptyMsg) emptyMsg.remove();
        var div = document.createElement('div');
        div.className = 'chat-msg chat-msg-in';
        var time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        div.innerHTML = data.message.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '<div class="chat-msg-time">' + time + '</div>';
        el.appendChild(div);
        el.scrollTop = el.scrollHeight;
        // Mark as read
        fetch('/api/chat/history/' + otherUser).catch(function() {});
      } else if (isForMe && !isFromMe) {
        // Unread
        unreadCounts[data.from] = (unreadCounts[data.from] || 0) + 1;
        updateBadge();
        if (chatOpen && !chatUser) renderContacts();
        // Notification sound
        try {
          var ctx = new (window.AudioContext || window.webkitAudioContext)();
          var osc = ctx.createOscillator(); var gain = ctx.createGain();
          osc.connect(gain); gain.connect(ctx.destination);
          osc.frequency.value = 700; gain.gain.value = 0.1;
          osc.start(); osc.stop(ctx.currentTime + 0.1);
        } catch(e) {}
      }
    });
  }
  setTimeout(setupSocketListener, 1000);

  // Badge
  function updateBadge() {
    var total = 0;
    for (var u in unreadCounts) total += unreadCounts[u];
    badgeEl.textContent = total;
    badgeEl.style.display = total > 0 ? 'flex' : 'none';
  }

  // Check unread on load
  function checkUnread() {
    fetch('/api/chat/unread').then(function(r) { return r.json(); }).then(function(d) {
      unreadCounts = {};
      (d.unread || []).forEach(function(u) { unreadCounts[u.from_user] = u.count; });
      updateBadge();
    }).catch(function() {});
  }
  setTimeout(checkUnread, 1500);
  setInterval(checkUnread, 30000);

  // Allow opening chat from admin message button
  window.openChatWith = function(username, displayName) {
    if (!chatOpen) toggleChat();
    setTimeout(function() { openChat(username, displayName); }, 200);
  };
})();
