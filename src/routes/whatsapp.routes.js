'use strict';

const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { config } = require('../config/env');
const { logEvent } = require('../services/logging.service');
const waRepo = require('../db/whatsapp.repo');
const waService = require('../services/whatsapp.service');
const waClient = require('../services/whatsappClient.service');
const { callLimiter } = require('../middleware/rateLimit');

// ---------------------------------------------------------------------------
// Setup function — returns router, accepts io for socket emissions
// ---------------------------------------------------------------------------

/**
 * @param {import('socket.io').Server} io
 * @returns {import('express').Router}
 */
function setupWhatsAppRoutes(io) {
  const router = express.Router();

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/incoming - incoming WA message
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/incoming', callLimiter, async (req, res) => {
    const { messageId, text, phone, chatName, timestamp } = req.body;

    if (!text || (!phone && !chatName)) {
      return res.json({ reply: null });
    }

    const contactId = phone || chatName || 'unknown';

    // --- Dedup: skip if we already processed this messageId ---
    if (messageId && waRepo.isMessageDuplicate(messageId)) {
      logEvent('info', 'WA duplicate message skipped: ' + messageId);
      return res.json({ reply: null, duplicate: true });
    }

    logEvent(
      'info',
      'WA message from ' + (chatName || phone) + ': ' + text.substring(0, 50)
    );

    // Store incoming message (with WA messageId for dedup)
    waRepo.insertMessage(contactId, chatName || null, 'in', text, 'chat', 'sent', null, messageId || null);

    // No auto-reply — system only sends scheduled messages (confirmations, reminders, aftercare)
    // Incoming messages are stored and shown to admin for reference
    io.to('role:admin').emit('wa_message', {
      phone: contactId, chatName, direction: 'in', text,
      reply: null, timestamp: new Date().toISOString(),
    });

    return res.json({ reply: null });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/outgoing - poll for approved outgoing messages
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/outgoing', (req, res) => {
    // Expire stale approved messages (>10 min) and stuck sending (>5 min)
    const expired = waRepo.expireStaleMessages();
    if (expired > 0) {
      logEvent('info', 'WA expired ' + expired + ' stale message(s)');
    }

    // Toggle controls all outgoing message sending (confirmations, reminders, aftercare)
    if (!waService.isBotEnabled()) {
      return res.json({ messages: [] });
    }

    const pending = waRepo.getPendingOutgoing();
    const messages = pending.map((m) => ({
      id: m.id,
      phone: m.phone,
      text: m.message,
      type: m.message_type,
    }));
    return res.json({ messages });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/sent - confirm message was sent
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/sent', (req, res) => {
    const { id, phone, success } = req.body;
    if (id) {
      if (success) {
        waRepo.markMessageSent(id);
        logEvent('info', 'WA message delivered to ' + phone);
      } else {
        waRepo.markMessageFailed(id);
        logEvent('warn', 'WA message failed for ' + phone);
      }
    }
    return res.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/send - manual message from dashboard (auth-protected)
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/send', requireAuth, (req, res) => {
    const { phone, message, type } = req.body;
    if (!phone || !message) {
      return res.json({ error: 'phone and message required' });
    }

    // Business hours check (configurable via DB settings)
    if (!waClient.isWithinBusinessHours()) {
      const startH = parseInt(waRepo.getSetting('business_hour_start') || '9', 10);
      const endH = parseInt(waRepo.getSetting('business_hour_end') || '19', 10);
      return res.json({ error: `WhatsApp messages can only be sent between ${startH}:00 and ${endH}:00 Pakistan time. Message saved for later.` });
    }

    // Validate message type
    const validTypes = ['chat', 'confirmation', 'reminder', 'review', 'aftercare'];
    const msgType = validTypes.includes(type) ? type : 'chat';

    waRepo.insertMessage(
      phone, null, 'out', message, msgType, 'pending',
      req.session.username || null
    );
    logEvent(
      'info',
      'WA manual message queued for ' + phone + ' by ' + req.session.username
    );
    return res.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/pause - pause bot for a specific chat (DB-persisted)
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/pause', requireAuth, (req, res) => {
    const { chatId } = req.body;
    if (!chatId) return res.json({ error: 'chatId required' });
    waService.pauseChat(chatId, req.session.username);
    logEvent('info', 'WA bot paused for "' + chatId + '" by ' + req.session.username);
    return res.json({ ok: true, paused: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/resume - resume bot for a specific chat
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/resume', requireAuth, (req, res) => {
    const { chatId } = req.body;
    if (!chatId) return res.json({ error: 'chatId required' });
    waService.resumeChat(chatId);
    logEvent('info', 'WA bot resumed for "' + chatId + '" by ' + req.session.username);
    return res.json({ ok: true, paused: false });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/paused - list paused chats
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/paused', requireAuth, (req, res) => {
    return res.json({ pausedChats: waService.getPausedChats() });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/bot-toggle - enable/disable sending reminders/confirmations (admin only)
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/bot-toggle', requireAuth, (req, res) => {
    if (req.session.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { enabled } = req.body;
    waService.setBotEnabled(!!enabled);
    logEvent('info', 'WA messaging ' + (enabled ? 'ENABLED' : 'PAUSED') + ' by ' + req.session.username);
    return res.json({ ok: true, enabled: !!enabled });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/bot-status - get sending status + business hours
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/bot-status', requireAuth, (req, res) => {
    const startHour = parseInt(waRepo.getSetting('business_hour_start') || '9', 10);
    const endHour = parseInt(waRepo.getSetting('business_hour_end') || '19', 10);
    return res.json({
      enabled: waService.isBotEnabled(),
      businessHoursStart: startHour,
      businessHoursEnd: endHour,
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/business-hours - set business hours (admin only)
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/business-hours', requireAuth, requireAdmin, (req, res) => {
    const { start, end } = req.body;
    const startH = parseInt(start, 10);
    const endH = parseInt(end, 10);
    if (isNaN(startH) || isNaN(endH) || startH < 0 || startH > 23 || endH < 0 || endH > 23) {
      return res.json({ error: 'Invalid hours (0-23)' });
    }
    waRepo.setSetting('business_hour_start', String(startH));
    waRepo.setSetting('business_hour_end', String(endH));
    logEvent('info', `WA business hours set to ${startH}:00 - ${endH}:00 PKT by ${req.session.username}`);
    return res.json({ ok: true, start: startH, end: endH });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/failed - list failed messages
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/failed', requireAuth, (req, res) => {
    const messages = waRepo.getFailedMessages();
    return res.json({ messages });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/retry - retry a failed message
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/retry', requireAuth, (req, res) => {
    const { id } = req.body;
    if (!id) return res.json({ error: 'id required' });
    waRepo.retryFailedMessage(id);
    logEvent('info', 'WA message #' + id + ' retried by ' + req.session.username);
    return res.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/retry-all - retry all failed messages
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/retry-all', requireAuth, (req, res) => {
    const failed = waRepo.getFailedMessages();
    let count = 0;
    for (const msg of failed) {
      waRepo.retryFailedMessage(msg.id);
      count++;
    }
    logEvent('info', 'WA retry-all: ' + count + ' messages re-queued by ' + req.session.username);
    return res.json({ ok: true, count });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/pending-approval - messages awaiting admin approval
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/pending-approval', requireAuth, (req, res) => {
    const messages = waRepo.getPendingApproval();
    return res.json({ messages });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/approve - approve a single message for sending
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/approve', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.body;
    if (!id) return res.json({ error: 'id required' });
    waRepo.approveMessage(id);
    logEvent('info', 'WA message #' + id + ' approved by ' + req.session.username);
    return res.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/approve-all - approve all pending messages
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/approve-all', requireAuth, requireAdmin, (req, res) => {
    const result = waRepo.approveAll();
    logEvent('info', 'WA approve-all: ' + result.changes + ' message(s) approved by ' + req.session.username);
    return res.json({ ok: true, count: result.changes });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/reject - reject a pending message
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/reject', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.body;
    if (!id) return res.json({ error: 'id required' });
    waRepo.rejectMessage(id);
    logEvent('info', 'WA message #' + id + ' rejected by ' + req.session.username);
    return res.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/history/:phone - conversation history (agent-filtered)
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/history/:phone', requireAuth, (req, res) => {
    const phone = decodeURIComponent(req.params.phone);
    const isAdmin = req.session.role === 'admin';
    const agent = req.session.username;

    let messages;
    if (isAdmin) {
      messages = waRepo.getAllConversationHistory(phone, 50);
    } else {
      messages = waRepo.getConversationHistoryByAgent(phone, agent, 50);
    }

    return res.json({ messages: messages.reverse() });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/conversations - grouped conversation list (agent-filtered)
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/conversations', requireAuth, (req, res) => {
    const isAdmin = req.session.role === 'admin';
    const agent = req.session.username;
    const conversations = waRepo.getConversations(isAdmin, agent);
    return res.json({ conversations });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/stats - aggregate WA stats
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/stats', requireAuth, (req, res) => {
    const isAdmin = req.session.role === 'admin';
    const agent = req.session.username;
    const stats = waRepo.getStats(isAdmin, agent);
    stats.botEnabled = waService.isBotEnabled();
    stats.waConnectionStatus = waClient.getStatus();
    return res.json(stats);
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/tracking-status - message tracking status by phone
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/tracking-status', requireAuth, (req, res) => {
    const tracking = waRepo.getTrackingByPhone();

    // Also get sent message types per phone from wa_messages
    try {
      const { db } = require('../db/index');
      const rows = db.prepare(
        "SELECT phone, GROUP_CONCAT(DISTINCT message_type) as types FROM wa_messages WHERE direction = 'out' AND status IN ('sent','pending','approved','sending') GROUP BY phone"
      ).all();
      for (const row of rows) {
        const phone = row.phone;
        if (!tracking[phone]) tracking[phone] = { confirmationSent: false, reminderSent: false };
        const types = (row.types || '').split(',');
        if (types.includes('confirmation')) tracking[phone].confirmationSent = true;
        if (types.includes('reminder')) tracking[phone].reminderSent = true;
        if (types.includes('review')) tracking[phone].reviewSent = true;
        if (types.includes('aftercare')) tracking[phone].aftercareSent = true;
      }
    } catch (e) { console.error('[whatsapp] Tracking query failed:', e.message); }

    return res.json({ tracking });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/reset-appointments - clear and re-queue appointment messages (admin)
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/reset-appointments', requireAuth, (req, res) => {
    if (req.session.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { db } = require('../db/index');
    const del = db.prepare("DELETE FROM wa_messages WHERE status = 'pending' AND message_type IN ('confirmation', 'reminder')").run();
    const r1 = db.prepare("UPDATE wa_appointment_tracking SET confirmation_sent = 0, confirmation_sent_at = NULL WHERE confirmation_sent = 1").run();
    const r2 = db.prepare("UPDATE wa_appointment_tracking SET reminder_sent = 0, reminder_sent_at = NULL WHERE reminder_sent = 1").run();
    logEvent('info', 'Appointment messages reset by ' + req.session.username + ': deleted ' + del.changes + ', reset ' + (r1.changes + r2.changes) + ' flags');
    return res.json({ ok: true, deleted: del.changes, resetFlags: r1.changes + r2.changes });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/connection-status - WhatsApp client connection status
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/connection-status', requireAuth, (req, res) => {
    return res.json({ status: waClient.getStatus() });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/wa-logout - disconnect WhatsApp (admin only)
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/wa-logout', requireAuth, async (req, res) => {
    if (req.session.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    try {
      await waClient.logout();
      logEvent('info', 'WA client logged out by ' + req.session.username);
      return res.json({ ok: true });
    } catch (err) {
      return res.json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/wa-reconnect - reinitialize WhatsApp client (admin only)
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/wa-reconnect', requireAuth, (req, res) => {
    if (req.session.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    // Fire-and-forget — initialization takes 10-30s (Puppeteer startup).
    // QR code will arrive via Socket.IO wa_connection event.
    waClient.initialize().catch((err) => {
      logEvent('error', 'WA reconnect failed: ' + err.message);
      io.to('role:admin').emit('wa_connection', { status: 'disconnected', reason: 'init_failed: ' + err.message });
    });
    return res.json({ ok: true, message: 'Initializing — QR code will appear shortly' });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/templates — get all message templates
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/templates', requireAuth, (req, res) => {
    const templates = require('../services/messageTemplates');
    res.json({ templates: templates.getAllTemplates() });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/templates — save a template (admin only)
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/templates', requireAuth, (req, res) => {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { key, text } = req.body;
    if (!key || !text) return res.json({ error: 'key and text required' });
    const templates = require('../services/messageTemplates');
    templates.setTemplate(key, text);
    const { logEvent } = require('../services/logging.service');
    logEvent('info', 'WA template updated: ' + key + ' by ' + req.session.username);
    res.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/templates/reset — reset template to default (admin)
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/templates/reset', requireAuth, (req, res) => {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { key } = req.body;
    if (!key) return res.json({ error: 'key required' });
    const templates = require('../services/messageTemplates');
    templates.resetTemplate(key);
    res.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/templates/create — create a new custom template (admin)
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/templates/create', requireAuth, (req, res) => {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { name, text } = req.body;
    if (!name || !text) return res.json({ error: 'name and text required' });
    const templates = require('../services/messageTemplates');
    const key = templates.createTemplate(name, text);
    const { logEvent } = require('../services/logging.service');
    logEvent('info', 'WA custom template created: ' + name + ' by ' + req.session.username);
    res.json({ ok: true, key });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/templates/delete — delete a custom template (admin)
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/templates/delete', requireAuth, (req, res) => {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { key } = req.body;
    if (!key) return res.json({ error: 'key required' });
    const templates = require('../services/messageTemplates');
    const ok = templates.deleteTemplate(key);
    if (!ok) return res.json({ error: 'Cannot delete default templates' });
    const { logEvent } = require('../services/logging.service');
    logEvent('info', 'WA custom template deleted: ' + key + ' by ' + req.session.username);
    res.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/templates/apply — apply a template with real variables
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/templates/apply', requireAuth, (req, res) => {
    const { key, vars } = req.body;
    if (!key) return res.json({ error: 'key required' });
    const templates = require('../services/messageTemplates');
    const text = templates.applyTemplate(key, vars || {});
    if (!text) return res.json({ error: 'Template not found: ' + key });
    res.json({ text });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/templates/preview — preview a template with sample data
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/templates/preview', requireAuth, (req, res) => {
    const { key } = req.body;
    const templates = require('../services/messageTemplates');
    const preview = templates.applyTemplate(key, {
      name: 'Ahmed Khan',
      date: 'Monday, 25 March 2026',
      time: '10:30 AM',
      service: 'Laser Hair Removal',
      doctor: 'Dr. Nakhoda',
      location: 'GPC 11, Rojhan Street, Block 5, Clifton, Karachi',
      phone: '+92-300-2105374',
      day_word: 'tomorrow',
      appointments: 'Monday, 25 March 2026 at 10:30 AM — Laser Hair Removal (Dr. Nakhoda)',
      service_text: ' with your Laser Hair Removal treatment',
      doctor_text: ' by Dr. Nakhoda',
    });
    res.json({ preview });
  });

  return router;
}

module.exports = setupWhatsAppRoutes;
