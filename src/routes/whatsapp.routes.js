'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { config } = require('../config/env');
const { logEvent } = require('../services/logging.service');
const waRepo = require('../db/whatsapp.repo');
const waService = require('../services/whatsapp.service');

// ---------------------------------------------------------------------------
// Extension auth middleware
// ---------------------------------------------------------------------------
function requireExtensionAuth(req, res, next) {
  if (!config.EXTENSION_SECRET) return next();
  const provided = req.headers['x-extension-key'];
  if (provided !== config.EXTENSION_SECRET) {
    logEvent('warn', 'Extension auth failed', 'IP: ' + req.ip);
    return res.status(401).json({ error: 'Invalid extension key', reply: null });
  }
  next();
}

// ---------------------------------------------------------------------------
// Setup function — returns router, accepts io for socket emissions
// ---------------------------------------------------------------------------

/**
 * @param {import('socket.io').Server} io
 * @returns {import('express').Router}
 */
// Track when the extension last polled (in-memory is fine — resets on restart)
let extensionLastSeen = null;

/** Check if the extension has polled within the last 60 seconds. */
function isExtensionConnected() {
  if (!extensionLastSeen) return false;
  const secondsAgo = (Date.now() - new Date(extensionLastSeen).getTime()) / 1000;
  return secondsAgo < 60;
}

function setupWhatsAppRoutes(io) {
  const router = express.Router();

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/incoming - incoming WA message (extension-auth)
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/incoming', requireExtensionAuth, async (req, res) => {
    extensionLastSeen = new Date().toISOString();
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

    // --- Global kill switch ---
    if (!waService.isBotEnabled()) {
      logEvent('info', 'WA bot globally disabled, skipping reply for ' + (chatName || phone));
      io.to('role:admin').emit('wa_message', {
        phone: contactId, chatName, direction: 'in', text,
        reply: null, timestamp: new Date().toISOString(),
      });
      return res.json({ reply: null });
    }

    // --- Per-chat pause check (now DB-backed) ---
    if (waService.isPaused(contactId) || (chatName && waService.isPaused(chatName))) {
      logEvent('info', 'WA bot paused for ' + (chatName || phone) + ', skipping reply');
      io.to('role:admin').emit('wa_message', {
        phone: contactId, chatName, direction: 'in', text,
        reply: null, timestamp: new Date().toISOString(),
      });
      return res.json({ reply: null });
    }

    // Get GPT reply
    const reply = await waService.getGPTReply(contactId, text, chatName);

    // Store outgoing reply as PENDING (not 'sent') — extension must confirm delivery
    waRepo.insertMessage(contactId, chatName || null, 'out', reply, 'chat', 'pending', null);

    logEvent(
      'info',
      'WA reply to ' + (chatName || phone) + ': ' + reply.substring(0, 50)
    );

    io.to('role:admin').emit('wa_message', {
      phone: contactId, chatName, direction: 'in', text,
      reply, timestamp: new Date().toISOString(),
    });

    return res.json({ reply });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/outgoing - poll for pending outgoing messages
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/outgoing', requireExtensionAuth, (req, res) => {
    // Record that extension is alive
    extensionLastSeen = new Date().toISOString();

    // Expire stale approved messages (>10 min) and stuck sending (>5 min)
    const expired = waRepo.expireStaleMessages();
    if (expired > 0) {
      logEvent('info', 'WA expired ' + expired + ' stale pending message(s)');
    }

    // If bot is globally disabled, return nothing — extension sends nothing
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
  // POST /api/whatsapp/sent - confirm message was sent by extension
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/sent', requireExtensionAuth, (req, res) => {
    const { id, phone, success } = req.body;
    if (id) {
      if (success) {
        waRepo.markMessageSent(id); // now also sets sent_at timestamp
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
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.json({ error: 'phone and message required' });
    }

    waRepo.insertMessage(
      phone, null, 'out', message, 'chat', 'pending',
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
  // POST /api/whatsapp/bot-toggle - global enable/disable bot
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/bot-toggle', requireAuth, (req, res) => {
    if (req.session.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { enabled } = req.body;
    waService.setBotEnabled(!!enabled);
    logEvent('info', 'WA bot globally ' + (enabled ? 'ENABLED' : 'DISABLED') + ' by ' + req.session.username);
    return res.json({ ok: true, enabled: !!enabled });
  });

  // -----------------------------------------------------------------------
  // GET /api/whatsapp/bot-status - get global bot status
  // -----------------------------------------------------------------------
  router.get('/api/whatsapp/bot-status', requireAuth, (req, res) => {
    return res.json({ enabled: waService.isBotEnabled() });
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
  router.post('/api/whatsapp/approve', requireAuth, (req, res) => {
    const { id } = req.body;
    if (!id) return res.json({ error: 'id required' });
    waRepo.approveMessage(id);
    logEvent('info', 'WA message #' + id + ' approved by ' + req.session.username);
    return res.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/approve-all - approve all pending messages
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/approve-all', requireAuth, (req, res) => {
    const result = waRepo.approveAll();
    logEvent('info', 'WA approve-all: ' + result.changes + ' message(s) approved by ' + req.session.username);
    return res.json({ ok: true, count: result.changes });
  });

  // -----------------------------------------------------------------------
  // POST /api/whatsapp/reject - reject a pending message
  // -----------------------------------------------------------------------
  router.post('/api/whatsapp/reject', requireAuth, (req, res) => {
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
    stats.extensionLastSeen = extensionLastSeen;
    stats.extensionConnected = isExtensionConnected();
    return res.json(stats);
  });

  return router;
}

setupWhatsAppRoutes.isExtensionConnected = isExtensionConnected;
module.exports = setupWhatsAppRoutes;
