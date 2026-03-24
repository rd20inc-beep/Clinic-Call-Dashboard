'use strict';

const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');
const { getEventLog, logEvent } = require('../services/logging.service');
const { requireWebhookSecret } = require('../middleware/webhookAuth');

// In-memory monitor log storage: { agent: "log text" }
const monitorLogs = {};

// Maximum log size per agent (50 KB)
const MAX_LOG_SIZE = 50 * 1024;

/**
 * Setup admin routes. Accepts the Socket.IO instance so that socket-debug
 * can inspect rooms and connected sockets.
 *
 * @param {import('socket.io').Server} io
 * @returns {import('express').Router}
 */
module.exports = function setupAdminRoutes(io) {
  const router = express.Router();

  // -------------------------------------------------------------------------
  // GET /api/socket-debug - show connected sockets and rooms (admin only)
  // -------------------------------------------------------------------------
  router.get('/api/socket-debug', requireAuth, requireAdmin, (req, res) => {
    const rooms = {};
    for (const [roomName, socketIds] of io.sockets.adapter.rooms) {
      // Skip per-socket rooms (socket IDs that auto-create a room)
      if (io.sockets.sockets.has(roomName)) continue;
      rooms[roomName] = Array.from(socketIds);
    }

    const sockets = [];
    for (const [id, socket] of io.sockets.sockets) {
      const sess = socket.request.session;
      sockets.push({
        id,
        username: (sess && sess.username) || null,
        role: (sess && sess.role) || null,
        rooms: Array.from(socket.rooms).filter((r) => r !== id),
      });
    }

    res.json({ totalSockets: io.sockets.sockets.size, rooms, sockets });
  });

  // -------------------------------------------------------------------------
  // POST /api/monitor-log - upload monitor log text (from monitor script)
  // -------------------------------------------------------------------------
  router.post('/api/monitor-log', requireWebhookSecret, (req, res) => {
    const agent = (req.body.Agent || '_default').trim();
    let logText = req.body.Log || '';

    // Sanitize: truncate to 50 KB max
    if (logText.length > MAX_LOG_SIZE) {
      logText = logText.slice(-MAX_LOG_SIZE);
    }

    monitorLogs[agent] = logText;
    res.json({ status: 'ok' });
  });

  // -------------------------------------------------------------------------
  // GET /api/monitor-log/:agent - retrieve stored log for an agent
  // -------------------------------------------------------------------------
  router.get('/api/monitor-log/:agent', requireAuth, requireAdmin, (req, res) => {
    const agent = req.params.agent || '_default';
    res.type('text/plain').send(monitorLogs[agent] || '(no log uploaded yet)');
  });

  // -------------------------------------------------------------------------
  // GET /api/monitor-log - list agents with log line counts
  // -------------------------------------------------------------------------
  router.get('/api/monitor-log', requireAuth, requireAdmin, (req, res) => {
    res.json(
      Object.keys(monitorLogs).map((k) => ({
        agent: k,
        lines: (monitorLogs[k] || '').split('\n').length,
      }))
    );
  });

  // -------------------------------------------------------------------------
  // GET /api/logs - server event log (admin only)
  // -------------------------------------------------------------------------
  router.get('/api/logs', requireAuth, requireAdmin, (req, res) => {
    res.json({ logs: getEventLog() });
  });

  // -------------------------------------------------------------------------
  // GET /api/call-stats - call statistics (agent-scoped)
  // -------------------------------------------------------------------------
  router.get('/api/call-stats', requireAuth, (req, res) => {
    try {
      const { db } = require('../db/index');
      const isAdmin = req.session.role === 'admin';
      const agent = req.session.username;

      // Ensure columns exist (VPS DB may not have them yet)
      try { db.exec("ALTER TABLE calls ADD COLUMN direction TEXT DEFAULT 'inbound'"); } catch (e) { /* exists */ }
      try { db.exec("ALTER TABLE calls ADD COLUMN call_status TEXT DEFAULT 'unknown'"); } catch (e) { /* exists */ }
      try { db.exec('ALTER TABLE calls ADD COLUMN duration INTEGER DEFAULT NULL'); } catch (e) { /* exists */ }

      function q(sql, ...params) {
        return db.prepare(sql).get(...params);
      }

      let total, inbound, outbound, answered, missed, avgDuration;
      let todayTotal, todayInbound, todayOutbound, todayAnswered, todayMissed;

      if (isAdmin) {
        total = q('SELECT COUNT(*) as c FROM calls').c;
        inbound = q("SELECT COUNT(*) as c FROM calls WHERE direction = 'inbound'").c;
        outbound = q("SELECT COUNT(*) as c FROM calls WHERE direction = 'outbound'").c;
        answered = q("SELECT COUNT(*) as c FROM calls WHERE call_status = 'answered'").c;
        missed = q("SELECT COUNT(*) as c FROM calls WHERE call_status = 'missed'").c;
        avgDuration = q('SELECT AVG(duration) as a FROM calls WHERE duration IS NOT NULL').a;
        todayTotal = q("SELECT COUNT(*) as c FROM calls WHERE date(timestamp) = date('now')").c;
        todayInbound = q("SELECT COUNT(*) as c FROM calls WHERE date(timestamp) = date('now') AND direction = 'inbound'").c;
        todayOutbound = q("SELECT COUNT(*) as c FROM calls WHERE date(timestamp) = date('now') AND direction = 'outbound'").c;
        todayAnswered = q("SELECT COUNT(*) as c FROM calls WHERE date(timestamp) = date('now') AND call_status = 'answered'").c;
        todayMissed = q("SELECT COUNT(*) as c FROM calls WHERE date(timestamp) = date('now') AND call_status = 'missed'").c;
      } else {
        total = q('SELECT COUNT(*) as c FROM calls WHERE agent = ?', agent).c;
        inbound = q("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND direction = 'inbound'", agent).c;
        outbound = q("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND direction = 'outbound'", agent).c;
        answered = q("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND call_status = 'answered'", agent).c;
        missed = q("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND call_status = 'missed'", agent).c;
        avgDuration = q('SELECT AVG(duration) as a FROM calls WHERE agent = ? AND duration IS NOT NULL', agent).a;
        todayTotal = q("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND date(timestamp) = date('now')", agent).c;
        todayInbound = q("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND date(timestamp) = date('now') AND direction = 'inbound'", agent).c;
        todayOutbound = q("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND date(timestamp) = date('now') AND direction = 'outbound'", agent).c;
        todayAnswered = q("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND date(timestamp) = date('now') AND call_status = 'answered'", agent).c;
        todayMissed = q("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND date(timestamp) = date('now') AND call_status = 'missed'", agent).c;
      }

      res.json({
        total, inbound, outbound, answered, missed,
        avgDuration: Math.round(avgDuration || 0),
        today: { total: todayTotal, inbound: todayInbound, outbound: todayOutbound, answered: todayAnswered, missed: todayMissed }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
