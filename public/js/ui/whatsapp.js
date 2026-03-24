// ===== WHATSAPP CHAT UI =====

var waBotEnabled = true;

// Helper: fetch JSON API with proper headers and session-expiry handling
function waFetch(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  opts.headers['Accept'] = 'application/json';
  if (opts.body) opts.headers['Content-Type'] = 'application/json';
  return fetch(url, opts).then(function(r) {
    var ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      if (r.status === 401 || r.redirected) {
        window.location.href = '/login';
      }
      return r.text().then(function(body) {
        console.error('[waFetch] Non-JSON response from', url, '- status:', r.status);
        return Promise.reject(new Error('Server returned non-JSON response (status ' + r.status + ')'));
      });
    }
    return r.json();
  });
}

function waOpenChat(phone, name) {
  waCurrentChatPhone = phone;
  document.getElementById('waConversations').style.display = 'none';
  document.getElementById('waChatView').style.display = 'block';
  document.getElementById('waChatName').textContent = name;
  waUpdatePauseBtn();

  waFetch('/api/whatsapp/history/' + encodeURIComponent(phone))
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
  if (!waCurrentChatPhone || !waBotEnabled) return;
  var isPaused = waPausedChats.has(waCurrentChatPhone);
  var endpoint = isPaused ? '/api/whatsapp/resume' : '/api/whatsapp/pause';

  waFetch(endpoint, { method: 'POST', body: JSON.stringify({ chatId: waCurrentChatPhone }) })
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
  loadWaConversations();
}

function waSendManual() {
  var phone = document.getElementById('waSendPhone').value.trim();
  var message = document.getElementById('waSendMessage').value.trim();
  if (!phone || !message) return alert('Please enter both phone number and message');

  waFetch('/api/whatsapp/send', { method: 'POST', body: JSON.stringify({ phone: phone, message: message }) })
    .then(function(data) {
      if (data.ok) {
        document.getElementById('waSendPhone').value = '';
        document.getElementById('waSendMessage').value = '';
        alert('Message queued for approval.');
        loadWaStats();
      } else {
        alert('Error: ' + (data.error || 'Unknown error'));
      }
    })
    .catch(function(err) { alert('Error: ' + err.message); });
}

// ===== MESSAGE APPROVAL =====

function waApproveMessage(id) {
  waFetch('/api/whatsapp/approve', { method: 'POST', body: JSON.stringify({ id: id }) })
    .then(function(data) { if (data.ok) { loadWaApprovalQueue(); loadWaStats(); } })
    .catch(function() {});
}

function waRejectMessage(id) {
  waFetch('/api/whatsapp/reject', { method: 'POST', body: JSON.stringify({ id: id }) })
    .then(function(data) { if (data.ok) { loadWaApprovalQueue(); loadWaStats(); } })
    .catch(function() {});
}

function waApproveAllMessages() {
  if (!confirm('Approve all pending messages for sending?')) return;
  waFetch('/api/whatsapp/approve-all', { method: 'POST' })
    .then(function(data) { if (data.ok) { loadWaApprovalQueue(); loadWaStats(); } })
    .catch(function() {});
}

// ===== POST-VISIT: REVIEW REQUEST =====

function calSendReview(phone, name, service, doctor) {
  var msg = 'Assalam o Alaikum ' + name + '! Thank you for visiting Dr. Nakhoda\'s Skin Institute today.\n\n';
  msg += 'We hope you had a great experience';
  if (service) msg += ' with your ' + service + ' treatment';
  if (doctor) msg += ' by ' + doctor;
  msg += '.\n\n';
  msg += 'We would really appreciate if you could leave us a quick review:\n';
  msg += 'https://g.page/r/drnakhoda/review\n\n';
  msg += 'Your feedback helps us serve you better. Thank you!';

  waShowPreview('Send Review Request', phone, name, msg).then(function(ok) {
    if (!ok) return;
    waFetch('/api/whatsapp/send', { method: 'POST', body: JSON.stringify({ phone: phone, message: msg, type: 'review' }) })
      .then(function(data) { if (data.ok) alert('Review request queued for approval.'); else alert('Error: ' + (data.error || 'Unknown')); })
      .catch(function(err) { alert('Error: ' + err.message); });
  });
}

// ===== POST-VISIT: AFTERCARE MESSAGE =====

function calSendAftercare(phone, name, service, doctor) {
  var msg = 'Assalam o Alaikum ' + name + '! Here are your aftercare instructions following your visit at Dr. Nakhoda\'s Skin Institute.\n\n';

  // Service-specific aftercare
  var svc = (service || '').toLowerCase();
  if (svc.includes('laser') || svc.includes('hair removal')) {
    msg += 'Aftercare for Laser Treatment:\n';
    msg += '- Avoid sun exposure for 48 hours\n';
    msg += '- Apply SPF 50+ sunscreen daily\n';
    msg += '- Avoid hot showers/saunas for 24 hours\n';
    msg += '- Do not scratch or pick the treated area\n';
    msg += '- Apply aloe vera gel if you feel any irritation\n';
  } else if (svc.includes('hydra') || svc.includes('facial')) {
    msg += 'Aftercare for HydraFacial:\n';
    msg += '- Avoid makeup for 6-12 hours\n';
    msg += '- Use gentle cleanser and moisturizer\n';
    msg += '- Apply SPF 30+ sunscreen daily\n';
    msg += '- Avoid exfoliating for 48 hours\n';
    msg += '- Stay hydrated and avoid alcohol for 24 hours\n';
  } else if (svc.includes('botox') || svc.includes('filler')) {
    msg += 'Aftercare for Injectable Treatment:\n';
    msg += '- Do not touch or massage the treated area for 4 hours\n';
    msg += '- Avoid lying down for 4 hours after treatment\n';
    msg += '- Avoid strenuous exercise for 24 hours\n';
    msg += '- Avoid alcohol and blood thinners for 24 hours\n';
    msg += '- Mild swelling/bruising is normal and will resolve in a few days\n';
  } else if (svc.includes('peel') || svc.includes('chemical')) {
    msg += 'Aftercare for Chemical Peel:\n';
    msg += '- Do not pick or peel flaking skin\n';
    msg += '- Apply prescribed moisturizer frequently\n';
    msg += '- Avoid sun exposure — use SPF 50+ daily\n';
    msg += '- Avoid retinol/AHA products for 1 week\n';
    msg += '- Keep the area clean and hydrated\n';
  } else if (svc.includes('microneedling') || svc.includes('prp') || svc.includes('rf')) {
    msg += 'Aftercare for Microneedling/PRP:\n';
    msg += '- Avoid touching the face for 6 hours\n';
    msg += '- No makeup for 24 hours\n';
    msg += '- Use gentle cleanser and prescribed serum only\n';
    msg += '- Avoid sun and apply SPF 50+ daily\n';
    msg += '- Redness is normal and will subside in 24-48 hours\n';
  } else {
    msg += 'General Aftercare:\n';
    msg += '- Follow the instructions given by your doctor\n';
    msg += '- Apply prescribed medications as directed\n';
    msg += '- Avoid direct sun exposure and use sunscreen\n';
    msg += '- Stay hydrated and rest well\n';
  }

  msg += '\nIf you have any questions or concerns, please call us at +92-300-2105374.';

  waShowPreview('Send Aftercare Instructions', phone, name, msg).then(function(ok) {
    if (!ok) return;
    waFetch('/api/whatsapp/send', { method: 'POST', body: JSON.stringify({ phone: phone, message: msg, type: 'aftercare' }) })
      .then(function(data) { if (data.ok) alert('Aftercare message queued for approval.'); else alert('Error: ' + (data.error || 'Unknown')); })
      .catch(function(err) { alert('Error: ' + err.message); });
  });
}

// ===== MESSAGE PREVIEW MODAL =====

function waShowPreview(title, phone, name, msg) {
  // Remove existing modal if any
  var existing = document.getElementById('waPreviewModal');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'waPreviewModal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

  var modal = document.createElement('div');
  modal.style.cssText = 'background:#fff;border-radius:12px;max-width:480px;width:100%;max-height:80vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3);';

  modal.innerHTML =
    '<div style="padding:16px 20px;border-bottom:1px solid #eee;">' +
      '<div style="font-weight:700;font-size:16px;color:#222;">' + escapeHtml(title) + '</div>' +
      '<div style="font-size:13px;color:#888;margin-top:2px;">To: ' + escapeHtml(name) + ' (' + escapeHtml(phone) + ')</div>' +
    '</div>' +
    '<div style="padding:20px;background:#f0f2f0;margin:12px;border-radius:8px;">' +
      '<div style="font-size:14px;color:#222;white-space:pre-wrap;word-break:break-word;line-height:1.5;">' + escapeHtml(msg) + '</div>' +
    '</div>' +
    '<div style="padding:12px 20px 16px;display:flex;gap:10px;justify-content:flex-end;">' +
      '<button id="waPreviewCancel" style="padding:8px 20px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#555;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>' +
      '<button id="waPreviewSend" style="padding:8px 20px;border:none;border-radius:6px;background:#2ecc71;color:white;font-size:13px;font-weight:600;cursor:pointer;">Send</button>' +
    '</div>';

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  document.getElementById('waPreviewCancel').onclick = function() { overlay.remove(); };

  return new Promise(function(resolve) {
    document.getElementById('waPreviewSend').onclick = function() {
      overlay.remove();
      resolve(true);
    };
    document.getElementById('waPreviewCancel').onclick = function() {
      overlay.remove();
      resolve(false);
    };
  });
}

// ===== CALENDAR SEND ACTIONS =====

function calSendConfirmation(phone, name, date, time, service, doctor) {
  var dateObj = new Date(date + 'T00:00:00');
  var dateStr = dateObj.toLocaleDateString('en-PK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  var msg = 'Assalam o Alaikum ' + name + '! Your appointment at Dr. Nakhoda\'s Skin Institute has been confirmed.\n\n';
  msg += 'Date: ' + dateStr + '\n';
  msg += 'Time: ' + time + '\n';
  if (service) msg += 'Treatment: ' + service + '\n';
  if (doctor) msg += 'Doctor: ' + doctor + '\n';
  msg += '\nIf you need to reschedule, call +92-300-2105374. We look forward to seeing you!';

  waShowPreview('Send Confirmation', phone, name, msg).then(function(ok) {
    if (!ok) return;
    waFetch('/api/whatsapp/send', { method: 'POST', body: JSON.stringify({ phone: phone, message: msg, type: 'confirmation' }) })
      .then(function(data) {
        if (data.ok) alert('Confirmation queued for approval.');
        else alert('Error: ' + (data.error || 'Unknown'));
      })
      .catch(function(err) { alert('Error: ' + err.message); });
  });
}

function calSendReminder(phone, name, date, time, service, doctor) {
  var msg = 'Assalam o Alaikum ' + name + '! This is a friendly reminder about your appointment at Dr. Nakhoda\'s Skin Institute.\n\n';
  msg += 'Time: ' + time + '\n';
  msg += '\nLocation: GPC 11, Rojhan Street, Block 5, Clifton, Karachi\nhttps://maps.app.goo.gl/YadKKdh4911HmxKL9\n';
  msg += '\nPlease arrive 10 minutes early. See you soon!';

  waShowPreview('Send Reminder', phone, name, msg).then(function(ok) {
    if (!ok) return;
    waFetch('/api/whatsapp/send', { method: 'POST', body: JSON.stringify({ phone: phone, message: msg, type: 'reminder' }) })
      .then(function(data) {
        if (data.ok) alert('Reminder queued for approval.');
        else alert('Error: ' + (data.error || 'Unknown'));
      })
      .catch(function(err) { alert('Error: ' + err.message); });
  });
}

function calSendMessage(phone, name) {
  var msg = prompt('Message to ' + name + ' (' + phone + '):');
  if (!msg || !msg.trim()) return;

  waFetch('/api/whatsapp/send', { method: 'POST', body: JSON.stringify({ phone: phone, message: msg.trim() }) })
    .then(function(data) {
      if (data.ok) alert('Message queued for approval.');
      else alert('Error: ' + (data.error || 'Unknown'));
    })
    .catch(function(err) { alert('Error: ' + err.message); });
}

// ===== WHATSAPP CONNECTION =====

function waUpdateConnectionUI(status, qrDataUrl) {
  var dot = document.getElementById('waConnDot');
  var statusText = document.getElementById('waConnectionStatusText');
  var bar = document.getElementById('waConnectionBar');
  var logoutBtn = document.getElementById('waLogoutBtn');
  var reconnectBtn = document.getElementById('waReconnectBtn');
  var qrSection = document.getElementById('waQRSection');
  var qrImage = document.getElementById('waQRImage');

  if (status === 'ready') {
    dot.style.background = '#2ecc71';
    bar.style.background = 'rgba(46,204,113,0.15)';
    bar.style.borderColor = 'rgba(46,204,113,0.3)';
    statusText.textContent = 'CONNECTED';
    statusText.style.color = '#2ecc71';
    logoutBtn.style.display = '';
    reconnectBtn.style.display = 'none';
    qrSection.style.display = 'none';
  } else if (status === 'qr') {
    dot.style.background = '#f39c12';
    bar.style.background = 'rgba(243,156,18,0.15)';
    bar.style.borderColor = 'rgba(243,156,18,0.3)';
    statusText.textContent = 'SCAN QR CODE';
    statusText.style.color = '#f39c12';
    logoutBtn.style.display = 'none';
    reconnectBtn.style.display = 'none';
    qrSection.style.display = '';
    if (qrDataUrl) qrImage.src = qrDataUrl;
  } else if (status === 'authenticated') {
    dot.style.background = '#3498db';
    bar.style.background = 'rgba(52,152,219,0.15)';
    bar.style.borderColor = 'rgba(52,152,219,0.3)';
    statusText.textContent = 'AUTHENTICATING...';
    statusText.style.color = '#3498db';
    logoutBtn.style.display = 'none';
    reconnectBtn.style.display = 'none';
    qrSection.style.display = 'none';
  } else {
    dot.style.background = '#e74c3c';
    bar.style.background = 'rgba(231,76,60,0.15)';
    bar.style.borderColor = 'rgba(231,76,60,0.3)';
    statusText.textContent = 'DISCONNECTED';
    statusText.style.color = '#e74c3c';
    logoutBtn.style.display = 'none';
    reconnectBtn.style.display = '';
    qrSection.style.display = 'none';
  }
}

function waLogout() {
  if (!confirm('Disconnect WhatsApp? You will need to scan QR code again.')) return;
  waFetch('/api/whatsapp/wa-logout', { method: 'POST' })
    .then(function(data) { if (data.ok) waUpdateConnectionUI('disconnected'); })
    .catch(function() {});
}

function waReconnect() {
  waFetch('/api/whatsapp/wa-reconnect', { method: 'POST' })
    .then(function() {})
    .catch(function() {});
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

  waUpdatePauseBtn();
}

function waToggleBot() {
  var newState = !waBotEnabled;
  var action = newState ? 'enable' : 'disable';
  if (!confirm('Are you sure you want to ' + action + ' the WhatsApp bot globally?\n\nThis affects ALL chats, AI replies, and appointment messages.')) return;

  waFetch('/api/whatsapp/bot-toggle', { method: 'POST', body: JSON.stringify({ enabled: newState }) })
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
  waFetch('/api/whatsapp/failed')
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
  waFetch('/api/whatsapp/retry', { method: 'POST', body: JSON.stringify({ id: id }) })
    .then(function(data) { if (data.ok) { waShowFailed(); loadWaStats(); } })
    .catch(function() {});
}

function waRetryAll() {
  if (!confirm('Retry all failed messages?')) return;
  waFetch('/api/whatsapp/retry-all', { method: 'POST' })
    .then(function(data) {
      if (data.ok) {
        alert(data.count + ' message(s) re-queued for sending.');
        loadWaConversations();
        loadWaStats();
      }
    })
    .catch(function() {});
}
