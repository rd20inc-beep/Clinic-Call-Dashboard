'use strict';

const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');
const { getEventLog, logEvent } = require('../services/logging.service');
const { requireWebhookSecret } = require('../middleware/webhookAuth');
const { getUsers } = require('../config/env');
const { getAllHeartbeats } = require('../services/agentRegistry.service');
const { getAllPresence } = require('../sockets/index');
const usersRepo = require('../db/users.repo');
const bcrypt = require('bcryptjs');

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

      // Extra admin data
      let todayTalkTime = 0, agentSnapshot = [], recentCalls = [], alerts = [];
      if (isAdmin) {
        todayTalkTime = q("SELECT COALESCE(SUM(duration),0) as s FROM calls WHERE date(timestamp) = date('now') AND duration IS NOT NULL").s;

        // Agent snapshot
        const presence = getAllPresence();
        const users = getUsers();
        let activeCount = 0, idleCount = 0, offlineCount = 0;
        for (const [uname, user] of Object.entries(users)) {
          if (user.role === 'admin') continue;
          const p = presence[uname] || {};
          if (p.online) {
            const actAgo = p.lastActivity ? (Date.now() - p.lastActivity) / 1000 : 9999;
            if (actAgo < 300) activeCount++; else idleCount++;
          } else {
            offlineCount++;
          }
        }
        agentSnapshot = [activeCount, idleCount, offlineCount];

        // Recent calls (last 5)
        try {
          recentCalls = db.prepare("SELECT caller_number, agent, direction, call_status, timestamp FROM calls ORDER BY timestamp DESC LIMIT 5").all();
        } catch (e) { /* ignore */ }

        // Alerts
        if (todayMissed > 5) alerts.push({ type: 'warn', text: todayMissed + ' missed calls today' });
        if (offlineCount > 0 && activeCount === 0) alerts.push({ type: 'error', text: 'No active agents — all offline or idle' });
        const lastHourMissed = q("SELECT COUNT(*) as c FROM calls WHERE call_status = 'missed' AND timestamp >= datetime('now', '-1 hour')").c;
        if (lastHourMissed > 3) alerts.push({ type: 'warn', text: lastHourMissed + ' missed calls in the last hour' });
      }

      res.json({
        total, inbound, outbound, answered, missed,
        avgDuration: Math.round(avgDuration || 0),
        today: { total: todayTotal, inbound: todayInbound, outbound: todayOutbound, answered: todayAnswered, missed: todayMissed, talkTime: todayTalkTime },
        agentSnapshot,
        recentCalls,
        alerts,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/agents - list all agents with status (admin only)
  // -------------------------------------------------------------------------
  router.get('/api/agents', requireAuth, requireAdmin, (req, res) => {
    const users = getUsers();
    const heartbeats = getAllHeartbeats();
    const presence = getAllPresence();
    const { db } = require('../db/index');

    const agents = [];
    for (const [username, user] of Object.entries(users)) {
      const hb = heartbeats[username];
      let todayCalls = 0, totalCalls = 0, answeredCalls = 0, missedCalls = 0;
      let weekCalls = 0, weekAnswered = 0;
      let avgDuration = 0, todayTalkTime = 0, weekTalkTime = 0, totalTalkTime = 0;
      let lastCallAt = null;
      try {
        todayCalls = db.prepare("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND date(timestamp) = date('now')").get(username).c;
        totalCalls = db.prepare("SELECT COUNT(*) as c FROM calls WHERE agent = ?").get(username).c;
        answeredCalls = db.prepare("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND call_status = 'answered'").get(username).c;
        missedCalls = db.prepare("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND call_status = 'missed'").get(username).c;
        weekCalls = db.prepare("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND timestamp >= datetime('now', '-7 days')").get(username).c;
        weekAnswered = db.prepare("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND call_status = 'answered' AND timestamp >= datetime('now', '-7 days')").get(username).c;
        avgDuration = db.prepare("SELECT AVG(duration) as a FROM calls WHERE agent = ? AND duration IS NOT NULL").get(username).a || 0;
        todayTalkTime = db.prepare("SELECT COALESCE(SUM(duration),0) as s FROM calls WHERE agent = ? AND date(timestamp) = date('now') AND duration IS NOT NULL").get(username).s;
        weekTalkTime = db.prepare("SELECT COALESCE(SUM(duration),0) as s FROM calls WHERE agent = ? AND timestamp >= datetime('now', '-7 days') AND duration IS NOT NULL").get(username).s;
        totalTalkTime = db.prepare("SELECT COALESCE(SUM(duration),0) as s FROM calls WHERE agent = ? AND duration IS NOT NULL").get(username).s;
        const lastRow = db.prepare("SELECT timestamp FROM calls WHERE agent = ? ORDER BY timestamp DESC LIMIT 1").get(username);
        lastCallAt = lastRow ? lastRow.timestamp : null;
      } catch (e) { /* ignore */ }

      // Performance score: answered +2, missed -3, talk time bonus
      const score = Math.max(0, (answeredCalls * 2) - (missedCalls * 3) + Math.floor(totalTalkTime / 300));

      // Determine status using presence + heartbeat
      const pres = presence[username] || { online: false, lastActivity: null };
      let status = 'offline';
      if (pres.online) {
        // Socket connected — check activity recency
        const lastAct = pres.lastActivity || 0;
        const actAgo = (Date.now() - lastAct) / 1000;
        if (actAgo < 300) status = 'active';  // activity within 5 min
        else status = 'idle';
      }
      // Override with heartbeat if monitor is alive (agent has call monitor running)
      if (hb && hb.alive) {
        const hbAgo = (Date.now() - hb.lastHeartbeat) / 1000;
        if (hbAgo < 30) status = 'active';
      }

      agents.push({
        username,
        displayName: user.displayName || username,
        role: user.role,
        status,
        active: user.source === 'db' ? (user.active !== false) : true,
        source: user.source || 'env',
        dbId: user.dbId || null,
        online: pres.online,
        monitorAlive: hb ? hb.alive : false,
        lastHeartbeat: hb ? hb.lastHeartbeat : null,
        lastActivity: pres.lastActivity || (hb ? hb.lastHeartbeat : null),
        todayCalls,
        weekCalls,
        weekAnswered,
        totalCalls,
        answeredCalls,
        missedCalls,
        answerRate: totalCalls > 0 ? Math.round((answeredCalls / totalCalls) * 100) : 0,
        avgDuration: Math.round(avgDuration),
        todayTalkTime,
        weekTalkTime,
        totalTalkTime,
        lastCallAt,
        score,
      });
    }

    // Sort: agents first (by status: active > idle > offline), admin last
    agents.sort(function(a, b) {
      if (a.role === 'admin' && b.role !== 'admin') return 1;
      if (a.role !== 'admin' && b.role === 'admin') return -1;
      var order = { active: 0, idle: 1, offline: 2 };
      return (order[a.status] || 2) - (order[b.status] || 2);
    });

    res.json({ agents });
  });

  // -------------------------------------------------------------------------
  // POST /api/agents/create - create a new agent (admin only)
  // -------------------------------------------------------------------------
  router.post('/api/agents/create', requireAuth, requireAdmin, (req, res) => {
    const { username, password, displayName, role, notes } = req.body;
    if (!username || !password) return res.json({ error: 'Username and password required' });
    if (username.length < 3) return res.json({ error: 'Username must be at least 3 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.json({ error: 'Username can only contain letters, numbers, and underscores' });
    if (password.length < 6) return res.json({ error: 'Password must be at least 6 characters' });
    if (usersRepo.usernameExists(username)) return res.json({ error: 'Username already exists' });

    // Also check env-based users
    const envUsers = getUsers();
    if (envUsers[username]) return res.json({ error: 'Username already exists' });

    const id = usersRepo.create(username, password, displayName, role || 'agent', notes);
    logEvent('info', 'Agent created: ' + username + ' by ' + req.session.username);
    res.json({ ok: true, id });
  });

  // -------------------------------------------------------------------------
  // POST /api/agents/update - update agent details (admin only)
  // -------------------------------------------------------------------------
  router.post('/api/agents/update', requireAuth, requireAdmin, (req, res) => {
    const { username, displayName, role, active, notes } = req.body;
    if (!username) return res.json({ error: 'Username required' });

    const dbUser = usersRepo.getByUsername(username);
    if (!dbUser) return res.json({ error: 'Agent not found in database (env-based agents cannot be edited)' });

    // Prevent deactivating the last admin
    if (role !== 'admin' || !active) {
      if (dbUser.role === 'admin' && usersRepo.countActiveAdmins() <= 1) {
        return res.json({ error: 'Cannot deactivate the last admin account' });
      }
    }

    usersRepo.update(dbUser.id, displayName, role, active, notes);
    logEvent('info', 'Agent updated: ' + username + ' by ' + req.session.username);
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // POST /api/agents/change-password - change agent password (admin only)
  // -------------------------------------------------------------------------
  router.post('/api/agents/change-password', requireAuth, requireAdmin, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ error: 'Username and password required' });
    if (password.length < 6) return res.json({ error: 'Password must be at least 6 characters' });

    // Try DB user first
    const dbUser = usersRepo.getByUsername(username);
    if (dbUser) {
      usersRepo.changePassword(dbUser.id, password);
      logEvent('info', 'Password changed for ' + username + ' by ' + req.session.username);
      return res.json({ ok: true });
    }

    // Fallback to env-based user
    const users = getUsers();
    if (!users[username]) return res.json({ error: 'Unknown user: ' + username });

    const hash = bcrypt.hashSync(password, 10);
    const envKey = 'USER_' + username.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_HASH';
    process.env[envKey] = hash;
    const passKey = 'USER_' + username.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_PASS';
    delete process.env[passKey];

    logEvent('info', 'Password changed for ' + username + ' by ' + req.session.username);
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // POST /api/agents/toggle-active - activate/deactivate agent (admin only)
  // -------------------------------------------------------------------------
  router.post('/api/agents/toggle-active', requireAuth, requireAdmin, (req, res) => {
    const { username, active } = req.body;
    if (!username) return res.json({ error: 'Username required' });

    const dbUser = usersRepo.getByUsername(username);
    if (!dbUser) return res.json({ error: 'Only DB-managed agents can be activated/deactivated' });

    // Prevent deactivating last admin
    if (!active && dbUser.role === 'admin' && usersRepo.countActiveAdmins() <= 1) {
      return res.json({ error: 'Cannot deactivate the last admin account' });
    }

    usersRepo.setActive(dbUser.id, !!active);
    logEvent('info', 'Agent ' + (active ? 'activated' : 'deactivated') + ': ' + username + ' by ' + req.session.username);
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // POST /api/agents/delete - delete agent (admin only)
  // -------------------------------------------------------------------------
  router.post('/api/agents/delete', requireAuth, requireAdmin, (req, res) => {
    const { username } = req.body;
    if (!username) return res.json({ error: 'Username required' });

    const dbUser = usersRepo.getByUsername(username);
    if (!dbUser) return res.json({ error: 'Only DB-managed agents can be deleted' });

    // Prevent deleting last admin
    if (dbUser.role === 'admin' && usersRepo.countActiveAdmins() <= 1) {
      return res.json({ error: 'Cannot delete the last admin account' });
    }

    // Prevent self-deletion
    if (username === req.session.username) {
      return res.json({ error: 'Cannot delete your own account' });
    }

    usersRepo.deleteUser(dbUser.id);
    logEvent('info', 'Agent deleted: ' + username + ' by ' + req.session.username);
    res.json({ ok: true });
  });

  return router;
};
