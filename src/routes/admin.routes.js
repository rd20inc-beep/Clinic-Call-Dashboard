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
const auditRepo = require('../db/audit.repo');
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
  // GET /api/call-analytics - charts data (admin only)
  // -------------------------------------------------------------------------
  router.get('/api/call-analytics', requireAuth, requireAdmin, (req, res) => {
    try {
      const { db } = require('../db/index');

      // 1. Calls per hour today (0-23)
      const hourlyRows = db.prepare(
        "SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, COUNT(*) as count FROM calls WHERE date(timestamp) = date('now') GROUP BY hour ORDER BY hour"
      ).all();
      const hourly = Array(24).fill(0);
      hourlyRows.forEach(function(r) { hourly[r.hour] = r.count; });

      // 2. Answered vs missed per hour today
      const answeredHourly = Array(24).fill(0);
      const missedHourly = Array(24).fill(0);
      db.prepare(
        "SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, call_status, COUNT(*) as count FROM calls WHERE date(timestamp) = date('now') AND call_status IN ('answered','missed') GROUP BY hour, call_status"
      ).all().forEach(function(r) {
        if (r.call_status === 'answered') answeredHourly[r.hour] = r.count;
        else missedHourly[r.hour] = r.count;
      });

      // 3. Daily trend (last 7 days)
      const dailyRows = db.prepare(
        "SELECT date(timestamp) as day, COUNT(*) as total, SUM(CASE WHEN call_status='answered' THEN 1 ELSE 0 END) as answered, SUM(CASE WHEN call_status='missed' THEN 1 ELSE 0 END) as missed FROM calls WHERE timestamp >= datetime('now', '-7 days') GROUP BY day ORDER BY day"
      ).all();

      // 4. Agent comparison (top agents this week by answered calls)
      const agentComp = db.prepare(
        "SELECT agent, COUNT(*) as total, SUM(CASE WHEN call_status='answered' THEN 1 ELSE 0 END) as answered, SUM(CASE WHEN call_status='missed' THEN 1 ELSE 0 END) as missed, COALESCE(SUM(duration),0) as talkTime FROM calls WHERE agent IS NOT NULL AND timestamp >= datetime('now', '-7 days') GROUP BY agent ORDER BY answered DESC LIMIT 10"
      ).all();

      res.json({ hourly, answeredHourly, missedHourly, dailyTrend: dailyRows, agentComparison: agentComp });
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

      // Extra metrics
      let longestToday = 0, longestWeek = 0, todayAnswered = 0;
      try {
        longestToday = db.prepare("SELECT COALESCE(MAX(duration),0) as m FROM calls WHERE agent = ? AND date(timestamp) = date('now') AND duration IS NOT NULL").get(username).m;
        longestWeek = db.prepare("SELECT COALESCE(MAX(duration),0) as m FROM calls WHERE agent = ? AND timestamp >= datetime('now', '-7 days') AND duration IS NOT NULL").get(username).m;
        todayAnswered = db.prepare("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND date(timestamp) = date('now') AND call_status = 'answered'").get(username).c;
      } catch (e) { /* ignore */ }

      // Performance score: answered +2, missed -3, talk time bonus
      const score = Math.max(0, (answeredCalls * 2) - (missedCalls * 3) + Math.floor(totalTalkTime / 300));

      // --- Compute presence status ---
      const pres = presence[username] || { online: false, lastActivity: null };
      const isAccountActive = user.source === 'db' ? (user.active !== false) : true;

      // Get persisted last_seen from DB
      let dbLastSeen = null;
      let dbLastLogin = null;
      try {
        const dbUser = usersRepo.getByUsername(username);
        if (dbUser) {
          dbLastSeen = dbUser.last_seen ? new Date(dbUser.last_seen).getTime() : null;
          dbLastLogin = dbUser.last_login ? new Date(dbUser.last_login).getTime() : null;
        }
      } catch (e) { /* env-based user, no DB record */ }

      // Best available "last seen" — prefer live presence, fall back to DB, then heartbeat
      const lastSeenTs = pres.lastActivity || dbLastSeen || (hb ? hb.lastHeartbeat : null);
      const hasEverConnected = !!(lastSeenTs || dbLastLogin);

      let presenceStatus = 'offline';
      if (!isAccountActive) {
        presenceStatus = 'disabled';
      } else if (!hasEverConnected) {
        presenceStatus = 'never_connected';
      } else if (pres.online) {
        const actAgo = pres.lastActivity ? (Date.now() - pres.lastActivity) / 1000 : 9999;
        presenceStatus = actAgo < 300 ? 'online' : 'idle';
      } else if (hb && hb.alive) {
        presenceStatus = 'online';
      } else {
        presenceStatus = 'offline';
      }

      agents.push({
        username,
        displayName: user.displayName || username,
        role: user.role,
        presenceStatus,
        active: isAccountActive,
        source: user.source || 'env',
        dbId: user.dbId || null,
        online: pres.online,
        monitorAlive: hb ? hb.alive : false,
        lastHeartbeat: hb ? hb.lastHeartbeat : null,
        lastSeen: lastSeenTs,
        lastLogin: dbLastLogin,
        todayCalls,
        todayAnswered,
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
        longestToday,
        longestWeek,
        lastCallAt,
        score,
      });
    }

    // Sort: by presence (online first), then admin last
    agents.sort(function(a, b) {
      if (a.role === 'admin' && b.role !== 'admin') return 1;
      if (a.role !== 'admin' && b.role === 'admin') return -1;
      var order = { online: 0, idle: 1, offline: 2, never_connected: 3, disabled: 4 };
      return (order[a.presenceStatus] || 3) - (order[b.presenceStatus] || 3);
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
    auditRepo.log('agent_created', username, 'Role: ' + (role || 'agent') + (displayName ? ', Name: ' + displayName : ''), req.session.username);
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
    auditRepo.log('agent_updated', username, 'Role: ' + role + ', Active: ' + active, req.session.username);
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
      auditRepo.log('password_changed', username, 'DB user', req.session.username);
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

    auditRepo.log('password_changed', username, 'Env user', req.session.username);
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
    auditRepo.log(active ? 'agent_activated' : 'agent_deactivated', username, null, req.session.username);
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
    auditRepo.log('agent_deleted', username, 'Soft-deleted (can be restored)', req.session.username);
    logEvent('info', 'Agent deleted: ' + username + ' by ' + req.session.username);
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // POST /api/agents/restore - restore a soft-deleted agent (admin only)
  // -------------------------------------------------------------------------
  router.post('/api/agents/restore', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.body;
    if (!id) return res.json({ error: 'ID required' });

    usersRepo.restore(id);
    auditRepo.log('agent_restored', 'id:' + id, null, req.session.username);
    logEvent('info', 'Agent #' + id + ' restored by ' + req.session.username);
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // GET /api/agents/archived - list soft-deleted agents (admin only)
  // -------------------------------------------------------------------------
  router.get('/api/agents/archived', requireAuth, requireAdmin, (req, res) => {
    const all = usersRepo.getAllIncludeDeleted();
    const archived = all.filter(function(u) { return u.deleted_at; });
    res.json({ agents: archived });
  });

  // -------------------------------------------------------------------------
  // GET /api/audit-log - admin audit log
  // -------------------------------------------------------------------------
  router.get('/api/audit-log', requireAuth, requireAdmin, (req, res) => {
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const logs = auditRepo.getRecent(limit);
    res.json({ logs });
  });

  // -------------------------------------------------------------------------
  // GET /api/audit-log/:target - audit log for specific target
  // -------------------------------------------------------------------------
  router.get('/api/audit-log/:target', requireAuth, requireAdmin, (req, res) => {
    const target = decodeURIComponent(req.params.target);
    const logs = auditRepo.getByTarget(target, 20);
    res.json({ logs });
  });

  // -------------------------------------------------------------------------
  // GET /api/weekly-report - comprehensive weekly report (admin only)
  // -------------------------------------------------------------------------
  router.get('/api/weekly-report', requireAuth, requireAdmin, (req, res) => {
    try {
      const { db } = require('../db/index');
      function q(sql, ...params) { return db.prepare(sql).get(...params); }
      function qa(sql, ...params) { return db.prepare(sql).all(...params); }

      // This week vs last week
      const thisWeek = q("SELECT COUNT(*) as calls, COALESCE(SUM(duration),0) as talkTime, SUM(CASE WHEN call_status='answered' THEN 1 ELSE 0 END) as answered, SUM(CASE WHEN call_status='missed' THEN 1 ELSE 0 END) as missed FROM calls WHERE timestamp >= datetime('now', '-7 days')");
      const lastWeek = q("SELECT COUNT(*) as calls, COALESCE(SUM(duration),0) as talkTime, SUM(CASE WHEN call_status='answered' THEN 1 ELSE 0 END) as answered, SUM(CASE WHEN call_status='missed' THEN 1 ELSE 0 END) as missed FROM calls WHERE timestamp >= datetime('now', '-14 days') AND timestamp < datetime('now', '-7 days')");

      // Change percentages
      const callChange = lastWeek.calls > 0 ? Math.round(((thisWeek.calls - lastWeek.calls) / lastWeek.calls) * 100) : null;
      const talkTimeChange = lastWeek.talkTime > 0 ? Math.round(((thisWeek.talkTime - lastWeek.talkTime) / lastWeek.talkTime) * 100) : null;

      // Best agents
      const bestByCalls = q("SELECT agent, COUNT(*) as c FROM calls WHERE agent IS NOT NULL AND timestamp >= datetime('now', '-7 days') GROUP BY agent ORDER BY c DESC LIMIT 1");
      const bestByTalkTime = q("SELECT agent, COALESCE(SUM(duration),0) as t FROM calls WHERE agent IS NOT NULL AND timestamp >= datetime('now', '-7 days') AND duration IS NOT NULL GROUP BY agent ORDER BY t DESC LIMIT 1");

      // Agent rankings
      const agentRankings = qa("SELECT agent, COUNT(*) as calls, SUM(CASE WHEN call_status='answered' THEN 1 ELSE 0 END) as answered, SUM(CASE WHEN call_status='missed' THEN 1 ELSE 0 END) as missed, COALESCE(SUM(duration),0) as talkTime, COALESCE(AVG(duration),0) as avgDuration FROM calls WHERE agent IS NOT NULL AND timestamp >= datetime('now', '-7 days') GROUP BY agent ORDER BY calls DESC");

      // Daily breakdown
      const dailyBreakdown = qa("SELECT date(timestamp) as day, COUNT(*) as calls, SUM(CASE WHEN call_status='answered' THEN 1 ELSE 0 END) as answered, SUM(CASE WHEN call_status='missed' THEN 1 ELSE 0 END) as missed, COALESCE(SUM(duration),0) as talkTime FROM calls WHERE timestamp >= datetime('now', '-7 days') GROUP BY day ORDER BY day");

      // Peak hours by calls and talk time
      const peakByCalls = qa("SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, COUNT(*) as count FROM calls WHERE timestamp >= datetime('now', '-7 days') GROUP BY hour ORDER BY count DESC LIMIT 5");
      const peakByTalkTime = qa("SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, COALESCE(SUM(duration),0) as talkTime FROM calls WHERE timestamp >= datetime('now', '-7 days') AND duration IS NOT NULL GROUP BY hour ORDER BY talkTime DESC LIMIT 5");

      // Low activity agents (< 5 calls this week)
      const users = getUsers();
      const allAgents = Object.keys(users).filter(u => users[u].role !== 'admin');
      const activeAgents = new Set(agentRankings.map(r => r.agent));
      const lowActivity = allAgents.filter(a => {
        const ranking = agentRankings.find(r => r.agent === a);
        return !ranking || ranking.calls < 5;
      });

      res.json({
        thisWeek: { calls: thisWeek.calls, talkTime: thisWeek.talkTime, answered: thisWeek.answered || 0, missed: thisWeek.missed || 0 },
        lastWeek: { calls: lastWeek.calls, talkTime: lastWeek.talkTime, answered: lastWeek.answered || 0, missed: lastWeek.missed || 0 },
        callChange,
        talkTimeChange,
        bestByCalls: bestByCalls ? { agent: bestByCalls.agent, calls: bestByCalls.c } : null,
        bestByTalkTime: bestByTalkTime ? { agent: bestByTalkTime.agent, talkTime: bestByTalkTime.t } : null,
        agentRankings,
        dailyBreakdown,
        peakByCalls,
        peakByTalkTime,
        lowActivity,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
