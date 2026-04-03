// ===== WHATSAPP CHAT UI =====

var waBotEnabled = true;

// ===== MESSAGE TEMPLATE EDITOR =====
var templateLabels = {
  confirmation: 'Appointment Confirmation',
  reminder: 'Appointment Reminder',
  review: 'Review Request (Post-Visit)',
  aftercare_general: 'Aftercare — General',
  aftercare_laser: 'Aftercare — Laser/Hair Removal',
  aftercare_facial: 'Aftercare — HydraFacial',
  aftercare_botox: 'Aftercare — Botox/Fillers',
  aftercare_peel: 'Aftercare — Chemical Peel',
  aftercare_microneedling: 'Aftercare — Microneedling/PRP',
};

function loadWaTemplates() {
  var section = document.getElementById('waTemplatesSection');
  if (section.style.display !== 'none') { section.style.display = 'none'; return; }
  section.style.display = '';
  section.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8;">Loading templates...</div>';

  waFetch('/api/whatsapp/templates').then(function(data) {
    var templates = data.templates || {};
    var html = '<div style="font-size:11px;color:#94a3b8;margin-bottom:12px;">Variables: <code>{name}</code> <code>{date}</code> <code>{time}</code> <code>{service}</code> <code>{doctor}</code> <code>{day_word}</code> <code>{appointments}</code> <code>{service_text}</code> <code>{doctor_text}</code> <code>{location}</code> <code>{phone}</code></div>';

    // Add New Template button
    html += '<div style="background:#f0f9ff;border:1px dashed #3b82f6;border-radius:8px;padding:14px;margin-bottom:14px;">';
    html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';
    html += '<input id="newTplName" type="text" placeholder="Template name (e.g. Skin Rejuvenation Aftercare)" style="flex:1;min-width:200px;padding:6px 10px;border:1px solid #e2e8f0;border-radius:4px;font-size:12px;">';
    html += '<button onclick="createNewTemplate()" style="padding:6px 14px;border:none;border-radius:4px;background:#3b82f6;color:white;font-size:12px;font-weight:600;cursor:pointer;">+ Add Template</button>';
    html += '</div></div>';

    for (var key in templates) {
      var t = templates[key];
      var label = templateLabels[key] || (function() { try { return t.displayName; } catch(e) { return null; } })() || key.replace(/^custom_/, '').replace(/_/g, ' ');
      var customBadge = t.isUserCreated ? '<span style="background:#8b5cf6;color:white;font-size:9px;padding:1px 6px;border-radius:3px;margin-left:6px;">Service Template</span>' : t.isCustom ? '<span style="background:#3b82f6;color:white;font-size:9px;padding:1px 6px;border-radius:3px;margin-left:6px;">Modified</span>' : '';

      html += '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin-bottom:10px;">';
      html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">';
      html += '<span style="font-weight:600;font-size:13px;color:#0f172a;">' + escapeHtml(label) + customBadge + '</span>';
      html += '<div style="display:flex;gap:4px;">';
      html += '<button onclick="previewTemplate(\'' + key + '\')" style="padding:3px 8px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;color:#3b82f6;font-size:10px;cursor:pointer;">Preview</button>';
      if (t.isCustom && !t.isUserCreated) html += '<button onclick="resetTemplate(\'' + key + '\')" style="padding:3px 8px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;color:#f59e0b;font-size:10px;cursor:pointer;">Reset</button>';
      if (t.isUserCreated) html += '<button onclick="deleteCustomTemplate(\'' + key + '\')" style="padding:3px 8px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;color:#ef4444;font-size:10px;cursor:pointer;">Delete</button>';
      html += '<button onclick="saveTemplate(\'' + key + '\')" style="padding:3px 8px;border:none;border-radius:4px;background:#3b82f6;color:white;font-size:10px;cursor:pointer;">Save</button>';
      html += '</div></div>';
      html += '<textarea id="tpl_' + key + '" rows="5" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;font-family:monospace;resize:vertical;box-sizing:border-box;">' + escapeHtml(t.text) + '</textarea>';
      html += '</div>';
    }

    section.innerHTML = html;
  }).catch(function() { section.innerHTML = '<p style="color:#ef4444;">Failed to load templates</p>'; });
}

function saveTemplate(key) {
  var text = document.getElementById('tpl_' + key).value;
  if (!text.trim()) return alert('Template cannot be empty');
  waFetch('/api/whatsapp/templates', { method: 'POST', body: JSON.stringify({ key: key, text: text }) })
    .then(function(d) {
      if (d.ok) { alert('Template saved!'); loadWaTemplates(); }
      else alert('Error: ' + (d.error || 'Unknown'));
    }).catch(function(e) { alert('Error: ' + e.message); });
}

function resetTemplate(key) {
  if (!confirm('Reset this template to default?')) return;
  waFetch('/api/whatsapp/templates/reset', { method: 'POST', body: JSON.stringify({ key: key }) })
    .then(function(d) {
      if (d.ok) { alert('Template reset to default'); loadWaTemplates(); }
    }).catch(function() {});
}

function createNewTemplate() {
  var name = document.getElementById('newTplName').value.trim();
  if (!name) return alert('Enter a template name');
  var defaultText = 'Assalam o Alaikum {name}!\n\n[Your message here]\n\nIf you have any questions, call us at +92-300-2105374.';
  waFetch('/api/whatsapp/templates/create', { method: 'POST', body: JSON.stringify({ name: name, text: defaultText }) })
    .then(function(d) {
      if (d.ok) { document.getElementById('newTplName').value = ''; loadWaTemplates(); }
      else alert('Error: ' + (d.error || 'Unknown'));
    }).catch(function(e) { alert('Error: ' + e.message); });
}

function deleteCustomTemplate(key) {
  if (!confirm('Delete this custom template? This cannot be undone.')) return;
  waFetch('/api/whatsapp/templates/delete', { method: 'POST', body: JSON.stringify({ key: key }) })
    .then(function(d) {
      if (d.ok) loadWaTemplates();
      else alert('Error: ' + (d.error || 'Cannot delete default templates'));
    }).catch(function(e) { alert('Error: ' + e.message); });
}

function previewTemplate(key) {
  waFetch('/api/whatsapp/templates/preview', { method: 'POST', body: JSON.stringify({ key: key }) })
    .then(function(d) {
      if (d.preview) {
        waShowPreview('Template Preview: ' + (templateLabels[key] || key), '+923001234567', 'Ahmed Khan', d.preview);
      }
    }).catch(function() {});
}

// ===== SERVICE & DOCTOR TEMPLATE MANAGER =====

var _svcTplType = 'confirmation';

function loadServiceTemplateUI() {
  var section = document.getElementById('waServiceTemplatesSection');
  if (section.style.display !== 'none') { section.style.display = 'none'; return; }
  section.style.display = '';
  section.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8;">Loading services &amp; doctors...</div>';

  waFetch('/api/whatsapp/services').then(function(data) {
    var services = data.services || [];
    var doctors = data.doctors || [];

    var html = '';
    html += '<div style="font-size:11px;color:#94a3b8;margin-bottom:12px;">Pick a service or doctor, choose the message type, then customize the template. If no custom template is set, the default is used.</div>';

    // Type selector
    html += '<div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap;">';
    ['confirmation', 'reminder', 'aftercare'].forEach(function(t) {
      var active = _svcTplType === t;
      html += '<button onclick="_svcTplType=\'' + t + '\';loadServiceTemplateList()" style="padding:6px 16px;border:1px solid ' + (active ? '#3b82f6' : '#e2e8f0') + ';border-radius:6px;background:' + (active ? '#3b82f6' : '#fff') + ';color:' + (active ? '#fff' : '#64748b') + ';font-size:12px;font-weight:600;cursor:pointer;">' + t.charAt(0).toUpperCase() + t.slice(1) + '</button>';
    });
    html += '</div>';

    // Services list
    html += '<h4 style="font-size:14px;font-weight:600;margin:0 0 8px;color:#0f172a;">Services (' + services.length + ')</h4>';
    if (services.length === 0) {
      html += '<div style="color:#94a3b8;font-size:12px;padding:8px 0;">No services found. Services appear after appointment sync from Clinicea.</div>';
    } else {
      html += '<div id="svcTemplateList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:20px;"></div>';
    }

    // Doctors list
    html += '<h4 style="font-size:14px;font-weight:600;margin:0 0 8px;color:#0f172a;">Doctor Consultations (' + doctors.length + ')</h4>';
    if (doctors.length === 0) {
      html += '<div style="color:#94a3b8;font-size:12px;padding:8px 0;">No doctors found. Doctors appear after appointment sync from Clinicea.</div>';
    } else {
      html += '<div id="docTemplateList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;"></div>';
    }

    section.innerHTML = html;

    // Store lists for use by loadServiceTemplateList
    window._svcList = services;
    window._docList = doctors;
    loadServiceTemplateList();
  }).catch(function(err) { section.innerHTML = '<p style="color:#ef4444;">Failed to load: ' + err.message + '</p>'; });
}

function loadServiceTemplateList() {
  var services = window._svcList || [];
  var doctors = window._docList || [];

  // Load service templates for current type
  waFetch('/api/whatsapp/service-templates/' + _svcTplType).then(function(data) {
    var el = document.getElementById('svcTemplateList');
    if (!el) return;
    var svcData = {};
    (data.services || []).forEach(function(s) { svcData[s.service] = s; });

    el.innerHTML = services.map(function(svc) {
      var info = svcData[svc] || {};
      var hasCustom = !info.usingDefault && info.template;
      var badge = hasCustom ? '<span style="background:#10b981;color:#fff;font-size:9px;padding:1px 6px;border-radius:3px;margin-left:6px;">Custom</span>' : '<span style="background:#94a3b8;color:#fff;font-size:9px;padding:1px 6px;border-radius:3px;margin-left:6px;">Default</span>';
      return '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
          '<span style="font-weight:600;font-size:13px;">' + escapeHtml(svc) + badge + '</span>' +
          '<button onclick="editServiceTemplate(\'' + _svcTplType + '\',\'' + escapeHtml(svc).replace(/'/g, "\\'") + '\')" style="padding:3px 10px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;color:#3b82f6;font-size:11px;cursor:pointer;">' + (hasCustom ? 'Edit' : 'Customize') + '</button>' +
        '</div>' +
        (hasCustom ? '<div style="font-size:11px;color:#64748b;white-space:pre-wrap;max-height:60px;overflow:hidden;">' + escapeHtml((info.template || '').substring(0, 120)) + '...</div>' : '') +
      '</div>';
    }).join('');
  }).catch(function() {});

  // Load doctor templates for current type
  waFetch('/api/whatsapp/doctor-templates/' + _svcTplType).then(function(data) {
    var el = document.getElementById('docTemplateList');
    if (!el) return;
    var docData = {};
    (data.doctors || []).forEach(function(d) { docData[d.doctor] = d; });

    el.innerHTML = doctors.map(function(doc) {
      var info = docData[doc] || {};
      var hasCustom = !info.usingDefault && info.template;
      var badge = hasCustom ? '<span style="background:#10b981;color:#fff;font-size:9px;padding:1px 6px;border-radius:3px;margin-left:6px;">Custom</span>' : '<span style="background:#94a3b8;color:#fff;font-size:9px;padding:1px 6px;border-radius:3px;margin-left:6px;">Default</span>';
      return '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
          '<span style="font-weight:600;font-size:13px;">' + escapeHtml(doc) + badge + '</span>' +
          '<button onclick="editDoctorTemplate(\'' + _svcTplType + '\',\'' + escapeHtml(doc).replace(/'/g, "\\'") + '\')" style="padding:3px 10px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;color:#3b82f6;font-size:11px;cursor:pointer;">' + (hasCustom ? 'Edit' : 'Customize') + '</button>' +
        '</div>' +
        (hasCustom ? '<div style="font-size:11px;color:#64748b;white-space:pre-wrap;max-height:60px;overflow:hidden;">' + escapeHtml((info.template || '').substring(0, 120)) + '...</div>' : '') +
      '</div>';
    }).join('');
  }).catch(function() {});
}

function editServiceTemplate(type, service) {
  // Fetch current template (custom or default)
  waFetch('/api/whatsapp/service-templates/' + type).then(function(data) {
    var info = (data.services || []).find(function(s) { return s.service === service; }) || {};
    var text = info.template || info.defaultTemplate || '';
    var title = type.charAt(0).toUpperCase() + type.slice(1) + ' — ' + service;

    var modal = document.createElement('div');
    modal.id = 'svcTplModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    modal.innerHTML = '<div style="background:#fff;border-radius:12px;max-width:560px;width:100%;padding:24px;max-height:90vh;overflow-y:auto;">' +
      '<h3 style="margin:0 0 4px;font-size:16px;">' + escapeHtml(title) + '</h3>' +
      '<p style="margin:0 0 12px;font-size:11px;color:#94a3b8;">Variables: {name} {date} {time} {service} {doctor} {day_word} {appointments} {location} {phone}</p>' +
      '<textarea id="svcTplText" rows="10" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;font-family:monospace;resize:vertical;box-sizing:border-box;">' + escapeHtml(text) + '</textarea>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">' +
        (info.template ? '<button onclick="deleteServiceTpl(\'' + type + '\',\'' + service.replace(/'/g, "\\'") + '\')" style="padding:8px 16px;border:1px solid #fecaca;border-radius:6px;background:#fef2f2;color:#dc2626;font-size:13px;font-weight:600;cursor:pointer;margin-right:auto;">Reset to Default</button>' : '') +
        '<button onclick="document.getElementById(\'svcTplModal\').remove()" style="padding:8px 16px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#64748b;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>' +
        '<button onclick="saveServiceTpl(\'' + type + '\',\'' + service.replace(/'/g, "\\'") + '\')" style="padding:8px 16px;border:none;border-radius:6px;background:#3b82f6;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">Save</button>' +
      '</div></div>';
    document.body.appendChild(modal);
  }).catch(function(err) { alert('Error: ' + err.message); });
}

function saveServiceTpl(type, service) {
  var text = document.getElementById('svcTplText').value.trim();
  if (!text) return alert('Template cannot be empty');
  waFetch('/api/whatsapp/service-templates', { method: 'POST', body: JSON.stringify({ type: type, service: service, text: text }) })
    .then(function(d) {
      if (d.ok) { document.getElementById('svcTplModal').remove(); alert('Template saved!'); loadServiceTemplateList(); }
      else alert('Error: ' + (d.error || 'Unknown'));
    }).catch(function(err) { alert('Error: ' + err.message); });
}

function deleteServiceTpl(type, service) {
  if (!confirm('Reset "' + service + '" ' + type + ' template to default?')) return;
  waFetch('/api/whatsapp/service-templates', { method: 'DELETE', body: JSON.stringify({ type: type, service: service }) })
    .then(function(d) { if (d.ok) { document.getElementById('svcTplModal').remove(); loadServiceTemplateList(); } })
    .catch(function() {});
}

function editDoctorTemplate(type, doctor) {
  waFetch('/api/whatsapp/doctor-templates/' + type).then(function(data) {
    var info = (data.doctors || []).find(function(d) { return d.doctor === doctor; }) || {};
    var text = info.template || info.defaultTemplate || '';
    var title = type.charAt(0).toUpperCase() + type.slice(1) + ' — Consultation with ' + doctor;

    var modal = document.createElement('div');
    modal.id = 'svcTplModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    modal.innerHTML = '<div style="background:#fff;border-radius:12px;max-width:560px;width:100%;padding:24px;max-height:90vh;overflow-y:auto;">' +
      '<h3 style="margin:0 0 4px;font-size:16px;">' + escapeHtml(title) + '</h3>' +
      '<p style="margin:0 0 12px;font-size:11px;color:#94a3b8;">Variables: {name} {date} {time} {service} {doctor} {day_word} {appointments} {location} {phone}</p>' +
      '<textarea id="svcTplText" rows="10" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;font-family:monospace;resize:vertical;box-sizing:border-box;">' + escapeHtml(text) + '</textarea>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">' +
        (info.template ? '<button onclick="deleteDoctorTpl(\'' + type + '\',\'' + doctor.replace(/'/g, "\\'") + '\')" style="padding:8px 16px;border:1px solid #fecaca;border-radius:6px;background:#fef2f2;color:#dc2626;font-size:13px;font-weight:600;cursor:pointer;margin-right:auto;">Reset to Default</button>' : '') +
        '<button onclick="document.getElementById(\'svcTplModal\').remove()" style="padding:8px 16px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#64748b;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>' +
        '<button onclick="saveDoctorTpl(\'' + type + '\',\'' + doctor.replace(/'/g, "\\'") + '\')" style="padding:8px 16px;border:none;border-radius:6px;background:#3b82f6;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">Save</button>' +
      '</div></div>';
    document.body.appendChild(modal);
  }).catch(function(err) { alert('Error: ' + err.message); });
}

function saveDoctorTpl(type, doctor) {
  var text = document.getElementById('svcTplText').value.trim();
  if (!text) return alert('Template cannot be empty');
  waFetch('/api/whatsapp/doctor-templates', { method: 'POST', body: JSON.stringify({ type: type, doctor: doctor, text: text }) })
    .then(function(d) {
      if (d.ok) { document.getElementById('svcTplModal').remove(); alert('Template saved!'); loadServiceTemplateList(); }
      else alert('Error: ' + (d.error || 'Unknown'));
    }).catch(function(err) { alert('Error: ' + err.message); });
}

function deleteDoctorTpl(type, doctor) {
  if (!confirm('Reset "' + doctor + '" ' + type + ' template to default?')) return;
  waFetch('/api/whatsapp/doctor-templates', { method: 'DELETE', body: JSON.stringify({ type: type, doctor: doctor }) })
    .then(function(d) { if (d.ok) { document.getElementById('svcTplModal').remove(); loadServiceTemplateList(); } })
    .catch(function() {});
}

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

// ===== HELPER: fetch template from server, preview, then send =====

function _applyAndSend(templateKey, vars, title, phone, name, type) {
  if (!confirm(title + '\nTo: ' + phone + ' (' + name + ')\n\nSend this message?')) return;
  waFetch('/api/whatsapp/send', { method: 'POST', body: JSON.stringify({ phone: phone, template: templateKey, vars: vars, type: type }) })
    .then(function(d) {
      if (d.ok) alert(title + ' queued successfully.');
      else alert('Error: ' + (d.error || 'Unknown'));
    })
    .catch(function(err) { alert('Error: ' + err.message); });
}

// ===== POST-VISIT: REVIEW REQUEST =====

function calSendReview(phone, name, service, doctor) {
  _applyAndSend('review', {
    name: name,
    service_text: service ? ' with your ' + service + ' treatment' : '',
    doctor_text: doctor ? ' by ' + doctor : '',
  }, 'Send Review Request', phone, name, 'review');
}

// ===== POST-VISIT: AFTERCARE MESSAGE =====

function calSendAftercare(phone, name, service, doctor) {
  // Pick the right aftercare template based on service
  var svc = (service || '').toLowerCase();
  var templateKey = 'aftercare_general';
  if (svc.includes('laser') || svc.includes('hair removal')) templateKey = 'aftercare_laser';
  else if (svc.includes('hydra') || svc.includes('facial')) templateKey = 'aftercare_facial';
  else if (svc.includes('botox') || svc.includes('filler')) templateKey = 'aftercare_botox';
  else if (svc.includes('peel') || svc.includes('chemical')) templateKey = 'aftercare_peel';
  else if (svc.includes('microneedling') || svc.includes('prp') || svc.includes('rf')) templateKey = 'aftercare_microneedling';

  _applyAndSend(templateKey, { name: name }, 'Send Aftercare Instructions', phone, name, 'aftercare');
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
  var aptLine = dateStr + ' at ' + time;
  if (service) aptLine += ' — ' + service;
  if (doctor) aptLine += ' (' + doctor + ')';

  _applyAndSend('confirmation', {
    name: name, date: dateStr, time: time, service: service || '', doctor: doctor || '',
    appointments: aptLine,
  }, 'Send Confirmation', phone, name, 'confirmation');
}

function calSendReminder(phone, name, date, time, service, doctor) {
  var aptDate = new Date(date + 'T00:00:00');
  var dateStr = aptDate.toLocaleDateString('en-PK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  var aptLine = dateStr + ' at ' + time;
  if (service) aptLine += ' — ' + service;
  if (doctor) aptLine += ' (' + doctor + ')';

  _applyAndSend('reminder', {
    date: dateStr, time: time, service: service || '', doctor: doctor || '',
    appointments: aptLine,
  }, 'Send Reminder', phone, name, 'reminder');
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

// Store last status so we can re-apply after identity loads
var _lastWaStatus = null;
var _lastWaQrDataUrl = null;

function waUpdateConnectionUI(status, qrDataUrl) {
  _lastWaStatus = status;
  if (qrDataUrl) _lastWaQrDataUrl = qrDataUrl;
  var dot = document.getElementById('waConnDot');
  var statusText = document.getElementById('waConnectionStatusText');
  var bar = document.getElementById('waConnectionBar');
  // Reset reconnect button and timer on any real status change
  if (typeof _waReconnectTimer !== 'undefined' && _waReconnectTimer) { clearTimeout(_waReconnectTimer); _waReconnectTimer = null; }
  var reconnectBtnEl = document.getElementById('waReconnectBtn');
  if (reconnectBtnEl) { reconnectBtnEl.disabled = false; reconnectBtnEl.textContent = 'Reconnect'; }
  var logoutBtn = document.getElementById('waLogoutBtn');
  var reconnectBtn = document.getElementById('waReconnectBtn');
  var qrSection = document.getElementById('waQRSection');
  var qrImage = document.getElementById('waQRImage');
  var isAdmin = typeof myRole !== 'undefined' && myRole === 'admin';

  if (status === 'ready') {
    dot.style.background = '#2ecc71';
    bar.style.background = 'rgba(46,204,113,0.15)';
    bar.style.borderColor = 'rgba(46,204,113,0.3)';
    statusText.textContent = 'CONNECTED';
    statusText.style.color = '#2ecc71';
    logoutBtn.style.display = isAdmin ? '' : 'none';
    reconnectBtn.style.display = 'none';
    qrSection.style.display = 'none';
    // Clear stale QR image so it doesn't show again on disconnect
    if (qrImage) qrImage.src = '';
    var expiredMsg = document.getElementById('waQRExpired');
    if (expiredMsg) expiredMsg.remove();
  } else if (status === 'qr') {
    dot.style.background = '#f39c12';
    bar.style.background = 'rgba(243,156,18,0.15)';
    bar.style.borderColor = 'rgba(243,156,18,0.3)';
    statusText.textContent = isAdmin ? 'SCAN QR CODE' : 'LINKING...';
    statusText.style.color = '#f39c12';
    logoutBtn.style.display = 'none';
    reconnectBtn.style.display = isAdmin ? '' : 'none';
    qrSection.style.display = isAdmin ? '' : 'none';
    if (qrDataUrl && qrImage) qrImage.src = qrDataUrl;
    var expiredMsg = document.getElementById('waQRExpired');
    if (expiredMsg) expiredMsg.remove();
  } else if (status === 'authenticated' || status === 'authenticating') {
    dot.style.background = '#3498db';
    bar.style.background = 'rgba(52,152,219,0.15)';
    bar.style.borderColor = 'rgba(52,152,219,0.3)';
    statusText.textContent = status === 'authenticating' ? 'INITIALIZING...' : 'AUTHENTICATING...';
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
    reconnectBtn.style.display = isAdmin ? '' : 'none';
    qrSection.style.display = 'none';
    if (qrImage) qrImage.src = '';
  }
}

// Re-apply connection UI after identity loads (fixes race condition)
function waReapplyConnectionUI() {
  if (_lastWaStatus) waUpdateConnectionUI(_lastWaStatus, _lastWaQrDataUrl);
}

function waLogout() {
  if (!confirm('Disconnect WhatsApp? You will need to scan QR code again.')) return;
  waFetch('/api/whatsapp/wa-logout', { method: 'POST' })
    .then(function(data) { if (data.ok) waUpdateConnectionUI('disconnected'); })
    .catch(function() {});
}

var _waReconnectTimer = null;

function waReconnect() {
  // Show immediate feedback while Puppeteer starts (10-30s)
  waUpdateConnectionUI('authenticating');
  var btn = document.getElementById('waReconnectBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Initializing...'; }

  // Timeout: if no QR/status arrives in 45s, show error and re-enable
  if (_waReconnectTimer) clearTimeout(_waReconnectTimer);
  _waReconnectTimer = setTimeout(function() {
    if (_lastWaStatus === 'authenticating') {
      waUpdateConnectionUI('disconnected');
      var t = document.createElement('div');
      t.className = 'error-toast';
      t.innerHTML = 'WhatsApp initialization timed out. Check server logs or try again.<button class="error-toast-close" onclick="dismissToast(this)">&times;</button>';
      if (typeof toastContainer !== 'undefined' && toastContainer) toastContainer.appendChild(t);
      setTimeout(function() { if (t.parentNode) t.remove(); }, 8000);
    }
  }, 45000);

  waFetch('/api/whatsapp/wa-reconnect', { method: 'POST' })
    .then(function(data) {
      if (data.error) {
        clearTimeout(_waReconnectTimer);
        waUpdateConnectionUI('disconnected');
        var t = document.createElement('div');
        t.className = 'error-toast';
        t.innerHTML = 'WhatsApp error: ' + (data.error || 'Unknown') + '<button class="error-toast-close" onclick="dismissToast(this)">&times;</button>';
        if (typeof toastContainer !== 'undefined' && toastContainer) toastContainer.appendChild(t);
        setTimeout(function() { if (t.parentNode) t.remove(); }, 8000);
      }
    })
    .catch(function(err) {
      clearTimeout(_waReconnectTimer);
      waUpdateConnectionUI('disconnected');
      alert('Failed to reconnect: ' + err.message);
    });
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
    statusText.textContent = 'ACTIVE';
    statusText.style.color = '#2ecc71';
    btn.textContent = 'Pause Sending';
    btn.style.background = '#e74c3c';
  } else {
    bar.style.background = 'rgba(231,76,60,0.15)';
    bar.style.borderColor = 'rgba(231,76,60,0.3)';
    statusText.textContent = 'PAUSED';
    statusText.style.color = '#e74c3c';
    btn.textContent = 'Resume Sending';
    btn.style.background = '#2ecc71';
  }

  waUpdatePauseBtn();
}

function waToggleBot() {
  var newState = !waBotEnabled;
  var action = newState ? 'resume' : 'pause';
  if (!confirm('Are you sure you want to ' + action + ' sending WhatsApp messages?\n\nThis controls reminders, confirmations, and aftercare messages.')) return;

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

// ===== BUSINESS HOURS =====

function waFormatHour(h) {
  var ampm = h >= 12 ? 'PM' : 'AM';
  var h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return h12 + ':00 ' + ampm;
}

function waInitBusinessHours() {
  var startSel = document.getElementById('waStartHour');
  var endSel = document.getElementById('waEndHour');
  if (!startSel || !endSel) return;
  startSel.innerHTML = '';
  endSel.innerHTML = '';
  for (var i = 0; i < 24; i++) {
    startSel.innerHTML += '<option value="' + i + '">' + waFormatHour(i) + '</option>';
    endSel.innerHTML += '<option value="' + i + '">' + waFormatHour(i) + '</option>';
  }
  startSel.value = '9';
  endSel.value = '19';
}

function waUpdateBusinessHours(start, end) {
  var text = document.getElementById('waBusinessHoursText');
  if (text) text.textContent = waFormatHour(start) + ' — ' + waFormatHour(end);
  var startSel = document.getElementById('waStartHour');
  var endSel = document.getElementById('waEndHour');
  if (startSel) startSel.value = String(start);
  if (endSel) endSel.value = String(end);
}

function waSaveBusinessHours() {
  var start = parseInt(document.getElementById('waStartHour').value);
  var end = parseInt(document.getElementById('waEndHour').value);
  waFetch('/api/whatsapp/business-hours', {
    method: 'POST',
    body: JSON.stringify({ start: start, end: end })
  }).then(function(data) {
    if (data.ok) {
      waUpdateBusinessHours(data.start, data.end);
      alert('Business hours updated!');
    } else {
      alert('Error: ' + (data.error || 'Unknown error'));
    }
  }).catch(function(err) { alert('Error: ' + err.message); });
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
