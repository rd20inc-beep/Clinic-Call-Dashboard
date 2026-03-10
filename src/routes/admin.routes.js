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

  return router;
};
