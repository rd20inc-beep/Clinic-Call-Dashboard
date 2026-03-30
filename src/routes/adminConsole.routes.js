'use strict';

/**
 * Adapter routes for the legacy admin console (remote_admin.html).
 * Maps /admin/* endpoints to our existing /api/* endpoints so the
 * old dashboard HTML works without modification.
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin, requireAdminOrDoctor } = require('../middleware/auth');
const { getUsers } = require('../config/env');
const { getAllHeartbeats } = require('../services/agentRegistry.service');
const { getAllPresence, getPresence } = require('../sockets/index');
const usersRepo = require('../db/users.repo');
const callsRepo = require('../db/calls.repo');
const auditRepo = require('../db/audit.repo');
const { logEvent } = require('../services/logging.service');
const bcrypt = require('bcryptjs');

// All /admin routes require auth; most require admin role, appointments also allow doctors
router.use('/admin', requireAuth, (req, res, next) => {
  // Allow doctors to access appointments endpoint
  if (req.path.startsWith('/appointments') && req.session && req.session.role === 'doctor') {
    return next();
  }
  return requireAdmin(req, res, next);
});

// -------------------------------------------------------------------------
// GET /admin/analytics/overview
// -------------------------------------------------------------------------
router.get('/admin/analytics/overview', async (req, res) => {
  try {
    const { db } = require('../db/index');
    const users = getUsers();
    const presence = getAllPresence();
    const heartbeats = getAllHeartbeats();

    function q(sql) { return db.prepare(sql).get(); }

    // Fetch today's appointments from Clinicea (async)
    let todayAppointments = [];
    try {
      const today = new Date().toISOString().split('T')[0];
      const { isClinicaConfigured } = require('../config/env');
      if (isClinicaConfigured()) {
        const cliniceaRoutes = require('./clinicea.routes');
        // Use internal fetch to our own endpoint
        const aptRes = await new Promise((resolve) => {
          const fakeReq = { query: { date: today, refresh: '0' }, session: { loggedIn: true, role: 'admin' } };
          const fakeRes = { json: (data) => resolve(data) };
          // Direct DB/cache approach instead
          resolve({ appointments: [] });
        });
        todayAppointments = aptRes.appointments || [];
      }
    } catch (e) { console.error('[admin-console] Appointments fetch failed:', e.message); }

    // If direct fetch didn't work, try wa_appointment_tracking table
    let appointmentsTotal = 0;
    let appointmentsToday = 0;
    try {
      appointmentsTotal = db.prepare("SELECT COUNT(*) as c FROM wa_appointment_tracking").get().c;
      appointmentsToday = db.prepare("SELECT COUNT(*) as c FROM wa_appointment_tracking WHERE date(appointment_date) = date('now')").get().c;
    } catch (e) { console.error('[admin-console] Query failed:', e.message); }

    // Match appointments to agents via phone numbers
    // An appointment is "attributed" to an agent if the agent handled a call from that phone
    let appointmentsMatched = 0;
    const agentAppointments = {};
    try {
      const trackingRows = db.prepare(
        "SELECT patient_phone FROM wa_appointment_tracking WHERE confirmation_sent = 1"
      ).all();
      for (const row of trackingRows) {
        if (!row.patient_phone) continue;
        const phone = row.patient_phone.replace(/[\s\-()]/g, '');
        const match = db.prepare(
          "SELECT agent FROM calls WHERE caller_number LIKE ? AND agent IS NOT NULL ORDER BY timestamp DESC LIMIT 1"
        ).get('%' + phone.slice(-10) + '%');
        if (match && match.agent) {
          appointmentsMatched++;
          agentAppointments[match.agent] = (agentAppointments[match.agent] || 0) + 1;
        }
      }
    } catch (e) { console.error('[admin-console] Query failed:', e.message); }

    const callsToday = q("SELECT COUNT(*) as c FROM calls WHERE date(timestamp) = date('now')").c;
    const answeredToday = q("SELECT COUNT(*) as c FROM calls WHERE date(timestamp) = date('now') AND call_status = 'answered'").c;
    const missedToday = q("SELECT COUNT(*) as c FROM calls WHERE date(timestamp) = date('now') AND call_status = 'missed'").c;
    const rejectedToday = q("SELECT COUNT(*) as c FROM calls WHERE date(timestamp) = date('now') AND call_status = 'rejected'").c;
    const outgoingToday = q("SELECT COUNT(*) as c FROM calls WHERE date(timestamp) = date('now') AND direction = 'outbound'").c;
    const talkTimeToday = q("SELECT COALESCE(SUM(duration),0) as s FROM calls WHERE date(timestamp) = date('now') AND duration IS NOT NULL").s;
    const avgDuration = q("SELECT COALESCE(AVG(duration),0) as a FROM calls WHERE date(timestamp) = date('now') AND duration IS NOT NULL AND duration > 0").a;
    const answerRate = callsToday > 0 ? Math.round((answeredToday / callsToday) * 100) : 0;

    // Agent stats
    const agentStats = [];
    let activeAgents = 0, portalOnline = 0, mobileOnline = 0;

    const now = Date.now();
    const STALE_MS = require('../config/constants').HEARTBEAT_STALE_MS;

    for (const [username, user] of Object.entries(users)) {
      if (user.role === 'admin') continue;
      const p = getPresence(username);
      const hb = heartbeats[username];

      // Compute live freshness at query time (don't rely on cached booleans)
      const mobileAlive = !!(p.mobileOnline && p.lastMobileHb && (now - p.lastMobileHb) < STALE_MS);
      const monitorAlive = !!(hb && hb.alive && hb.lastHeartbeat && (now - hb.lastHeartbeat) < STALE_MS);
      const portalAlive = !!p.portalOnline;

      let status = 'offline';
      if (portalAlive) portalOnline++;
      if (mobileAlive) mobileOnline++;
      if (portalAlive || mobileAlive) { status = p.onCall ? 'busy' : ((now - (p.lastActivity || 0)) < 120000 ? 'online' : 'idle'); }
      else if (monitorAlive) { status = 'online'; }
      if (status !== 'offline') activeAgents++;

      let todayCalls = 0, todayAnswered = 0, todayMissed = 0, todayTalkTime = 0, weekCalls = 0;
      try {
        todayCalls = db.prepare("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND date(timestamp) = date('now')").get(username).c;
        todayAnswered = db.prepare("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND date(timestamp) = date('now') AND call_status = 'answered'").get(username).c;
        todayMissed = db.prepare("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND date(timestamp) = date('now') AND call_status = 'missed'").get(username).c;
        todayTalkTime = db.prepare("SELECT COALESCE(SUM(duration),0) as s FROM calls WHERE agent = ? AND date(timestamp) = date('now') AND duration IS NOT NULL").get(username).s;
        weekCalls = db.prepare("SELECT COUNT(*) as c FROM calls WHERE agent = ? AND timestamp >= datetime('now', '-7 days')").get(username).c;
      } catch (e) { console.error('[admin-console] Query failed:', e.message); }

      // Get DB ID and last_seen
      let dbId = null, lastSeen = null, avgDur = 0;
      try {
        const dbUser = usersRepo.getByUsername(username);
        if (dbUser) { dbId = dbUser.id; lastSeen = dbUser.last_seen; }
        avgDur = todayCalls > 0 ? db.prepare("SELECT COALESCE(AVG(duration),0) as a FROM calls WHERE agent = ? AND date(timestamp) = date('now') AND duration IS NOT NULL AND duration > 0").get(username).a : 0;
      } catch (e) { console.error('[admin-console] Query failed:', e.message); }

      agentStats.push({
        id: dbId,
        username,
        full_name: user.displayName || username,
        status: status,
        portal_online: portalAlive,
        mobile_online: mobileAlive,
        monitor_online: monitorAlive,
        today: todayCalls,
        answered_today: todayAnswered,
        missed_today: todayMissed,
        answer_rate: todayCalls > 0 ? Math.round((todayAnswered / todayCalls) * 100) : 0,
        talk_time_today: todayTalkTime,
        avg_duration: Math.round(avgDur),
        calls_week: weekCalls,
        week: weekCalls,
        appointments: agentAppointments[username] || 0,
        on_call: p.onCall || false,
        last_activity: p.lastActivity || null,
        last_seen: lastSeen,
      });
    }

    // Week + month totals for status strip
    let callsWeek = 0, callsMonth = 0, inboundTalkToday = 0, outboundTalkToday = 0;
    try {
      callsWeek = q("SELECT COUNT(*) as c FROM calls WHERE timestamp >= datetime('now', '-7 days')").c;
      callsMonth = q("SELECT COUNT(*) as c FROM calls WHERE timestamp >= datetime('now', '-30 days')").c;
      inboundTalkToday = q("SELECT COALESCE(SUM(duration),0) as s FROM calls WHERE date(timestamp) = date('now') AND direction = 'inbound' AND duration IS NOT NULL").s;
      outboundTalkToday = q("SELECT COALESCE(SUM(duration),0) as s FROM calls WHERE date(timestamp) = date('now') AND direction = 'outbound' AND duration IS NOT NULL").s;
    } catch (e) { console.error('[admin-console] Query failed:', e.message); }

    // Response matches exact field names expected by remote_admin.html
    res.json({
      callsToday: callsToday,
      answeredToday: answeredToday,
      missedToday: missedToday,
      rejectedToday: rejectedToday,
      outgoingToday: outgoingToday,
      answerRate: answerRate,
      talkTimeToday: talkTimeToday,
      avgDurationAll: Math.round(avgDuration),
      activeAgents: activeAgents,
      portalOnline: portalOnline,
      mobileOnline: mobileOnline,
      pendingCallbacks: (() => { try { return require('../db/callbacks.repo').getSummary().pending; } catch(e) { return 0; } })(),
      appointmentsMatched: appointmentsMatched,
      appointmentsScheduledToday: appointmentsToday,
      appointmentsTotal: appointmentsTotal,
      callsWeek: callsWeek,
      callsMonth: callsMonth,
      inboundTalkToday: inboundTalkToday,
      outboundTalkToday: outboundTalkToday,
      agentStats: agentStats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------------
// GET /admin/agents
// -------------------------------------------------------------------------
router.get('/admin/agents', (req, res) => {
  const all = usersRepo.getAll();
  const agents = all.map(u => ({
    id: u.id,
    username: u.username,
    full_name: u.display_name || u.username,
    role: u.role,
    status: u.active ? 'active' : 'disabled',
    phone: u.phone || '',
    email: u.email || '',
    device_info: u.device_info || '',
    last_login: u.last_login,
    last_seen: u.last_seen,
    activity_reset_at: u.activity_reset_at,
    created_at: u.created_at,
  }));
  res.json({ agents });
});

// -------------------------------------------------------------------------
// GET /admin/agents/:id
// -------------------------------------------------------------------------
router.get('/admin/agents/:id', (req, res) => {
  const u = usersRepo.getById(parseInt(req.params.id));
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ agent: { id: u.id, username: u.username, full_name: u.display_name, role: u.role, status: u.active ? 'active' : 'disabled', phone: u.phone, email: u.email } });
});

// -------------------------------------------------------------------------
// POST /admin/agents (create)
// -------------------------------------------------------------------------
router.post('/admin/agents', (req, res) => {
  const { username, password, full_name, role, phone, email } = req.body;
  if (!username) return res.json({ error: 'Username required' });
  if (!password || password.length < 4) return res.json({ error: 'Password must be 4+ chars' });
  if (usersRepo.usernameExists(username)) return res.json({ error: 'Username exists' });
  const id = usersRepo.create(username, password, full_name, role || 'agent', null, phone, email);
  auditRepo.log('agent_created', username, 'Role: ' + (role || 'agent'), req.session.username);
  res.json({ success: true, id });
});

// -------------------------------------------------------------------------
// PUT /admin/agents/:id (update)
// -------------------------------------------------------------------------
router.put('/admin/agents/:id', (req, res) => {
  const u = usersRepo.getById(parseInt(req.params.id));
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { full_name, role, phone, email } = req.body;
  usersRepo.update(u.id, full_name, role || u.role, u.active, u.notes, phone, email);
  auditRepo.log('agent_updated', u.username, 'Updated via admin console', req.session.username);
  res.json({ success: true });
});

// -------------------------------------------------------------------------
// PUT /admin/agents/:id/password
// -------------------------------------------------------------------------
router.put('/admin/agents/:id/password', (req, res) => {
  const u = usersRepo.getById(parseInt(req.params.id));
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { password } = req.body;
  if (!password || password.length < 4) return res.json({ error: 'Password must be 4+ chars' });
  usersRepo.changePassword(u.id, password);
  auditRepo.log('password_changed', u.username, 'Admin console', req.session.username);
  res.json({ success: true });
});

// -------------------------------------------------------------------------
// PUT /admin/agents/:id/status
// -------------------------------------------------------------------------
router.put('/admin/agents/:id/status', (req, res) => {
  const u = usersRepo.getById(parseInt(req.params.id));
  if (!u) return res.status(404).json({ error: 'Not found' });
  const active = req.body.status === 'active' ? 1 : 0;
  usersRepo.setActive(u.id, active);
  auditRepo.log(active ? 'agent_activated' : 'agent_deactivated', u.username, null, req.session.username);
  res.json({ success: true });
});

// -------------------------------------------------------------------------
// POST /admin/agents/:id/force-logout
// -------------------------------------------------------------------------
router.post('/admin/agents/:id/force-logout', (req, res) => {
  const u = usersRepo.getById(parseInt(req.params.id));
  if (!u) return res.status(404).json({ error: 'Not found' });
  // Would need io reference — for now return 0
  auditRepo.log('force_logout', u.username, null, req.session.username);
  res.json({ success: true, sessionsDestroyed: 0 });
});

// -------------------------------------------------------------------------
// POST /admin/agents/:id/clear-activity
// -------------------------------------------------------------------------
router.post('/admin/agents/:id/clear-activity', (req, res) => {
  const u = usersRepo.getById(parseInt(req.params.id));
  if (!u) return res.status(404).json({ error: 'Not found' });
  usersRepo.resetActivity(u.id);
  auditRepo.log('activity_cleared', u.username, null, req.session.username);
  res.json({ success: true });
});

// -------------------------------------------------------------------------
// POST /admin/activity/clear-all
// -------------------------------------------------------------------------
router.post('/admin/activity/clear-all', (req, res) => {
  const count = usersRepo.resetAllActivity();
  auditRepo.log('all_activity_cleared', null, count + ' agents', req.session.username);
  res.json({ success: true, agentsReset: count });
});

// -------------------------------------------------------------------------
// POST /admin/agents/:id/clear-history
// -------------------------------------------------------------------------
router.post('/admin/agents/:id/clear-history', (req, res) => {
  const u = usersRepo.getById(parseInt(req.params.id));
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { db } = require('../db/index');
  const result = db.prepare('DELETE FROM calls WHERE agent = ?').run(u.username);
  auditRepo.log('history_deleted', u.username, result.changes + ' calls', req.session.username);
  res.json({ success: true, deleted: result.changes });
});

// -------------------------------------------------------------------------
// POST /admin/history/clear-all
// -------------------------------------------------------------------------
router.post('/admin/history/clear-all', (req, res) => {
  const { db } = require('../db/index');
  const result = db.prepare('DELETE FROM calls').run();
  auditRepo.log('all_history_deleted', null, result.changes + ' calls', req.session.username);
  res.json({ success: true, deleted: result.changes });
});

// -------------------------------------------------------------------------
// DELETE /admin/agents/:id
// -------------------------------------------------------------------------
router.delete('/admin/agents/:id', (req, res) => {
  const u = usersRepo.getById(parseInt(req.params.id));
  if (!u) return res.status(404).json({ error: 'Not found' });
  usersRepo.deleteUser(u.id);
  auditRepo.log('agent_deleted', u.username, null, req.session.username);
  res.json({ success: true });
});

// -------------------------------------------------------------------------
// GET /admin/agents/:id/performance
// -------------------------------------------------------------------------
router.get('/admin/agents/:id/performance', (req, res) => {
  const u = usersRepo.getById(parseInt(req.params.id));
  if (!u) return res.status(404).json({ error: 'Not found' });
  try {
    const { db } = require('../db/index');
    const today = callsRepo.getPerformanceToday().find(r => r.agent === u.username) || {};
    const week = callsRepo.getPerformanceWeek().find(r => r.agent === u.username) || {};
    const all = callsRepo.getPerformanceAll().find(r => r.agent === u.username) || {};
    const hourly = callsRepo.getAgentHourlyToday(u.username);

    // Recent calls
    const recent = db.prepare("SELECT * FROM calls WHERE agent = ? ORDER BY timestamp DESC LIMIT 20").all(u.username);

    // Get month stats + peak hour
    const month = callsRepo.getPerformanceMonth().find(r => r.agent === u.username) || {};
    let peakHour = null;
    if (hourly.length > 0) {
      let maxCalls = 0;
      hourly.forEach(function(h) { if (h.calls > maxCalls) { maxCalls = h.calls; peakHour = h.hour; } });
    }

    // Get presence
    const pres = getPresence(u.username);
    const hb = getAllHeartbeats()[u.username];

    // 14-day daily breakdown for performance chart
    let dailyCalls = [];
    try {
      dailyCalls = db.prepare(
        "SELECT date(timestamp) as day, " +
        "SUM(CASE WHEN call_status = 'answered' THEN 1 ELSE 0 END) as answered, " +
        "SUM(CASE WHEN call_status = 'missed' THEN 1 ELSE 0 END) as missed " +
        "FROM calls WHERE agent = ? AND timestamp >= datetime('now', '-14 days') " +
        "GROUP BY day ORDER BY day"
      ).all(u.username);
    } catch (e) { console.error('[admin-console] Query failed:', e.message); }

    // Calculate online time today (time since last_login if logged in today)
    let loggedInToday = 0;
    try {
      if (u.last_login) {
        const loginDate = new Date(u.last_login);
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        if (loginDate >= todayStart) {
          loggedInToday = Math.round((Date.now() - loginDate.getTime()) / 1000);
        }
      }
    } catch (e) { console.error('[admin-console] Query failed:', e.message); }

    // Appointments attributed to this agent (phone match)
    let agentAppointments = [];
    try {
      const trackingRows = db.prepare("SELECT * FROM wa_appointment_tracking WHERE confirmation_sent = 1 ORDER BY appointment_date DESC").all();
      for (const row of trackingRows) {
        if (!row.patient_phone) continue;
        const phone = row.patient_phone.replace(/[\s\-()]/g, '');
        const match = db.prepare("SELECT agent FROM calls WHERE caller_number LIKE ? AND agent = ? ORDER BY timestamp DESC LIMIT 1").get('%' + phone.slice(-10) + '%', u.username);
        if (match) {
          agentAppointments.push({
            appointment_date: row.appointment_date,
            patient_name: row.patient_name,
            patient_phone: row.patient_phone,
            doctor_name: row.doctor_name,
            service: row.service,
          });
        }
      }
    } catch (e) { console.error('[admin-console] Query failed:', e.message); }

    res.json({
      agent: {
        username: u.username, full_name: u.display_name, role: u.role,
        portal_online: !!pres.portalOnline,
        mobile_online: !!(pres.mobileOnline && pres.lastMobileHb && (Date.now() - pres.lastMobileHb) < require('../config/constants').HEARTBEAT_STALE_MS),
        monitor_online: !!(hb && hb.alive && hb.lastHeartbeat && (Date.now() - hb.lastHeartbeat) < require('../config/constants').HEARTBEAT_STALE_MS),
        last_activity: pres.lastActivity, last_seen: u.last_seen,
      },
      stats: {
        today: today.total_calls || 0, answered_today: today.answered_calls || 0, missed_today: today.missed_calls || 0,
        answer_rate: (today.total_calls || 0) > 0 ? Math.round(((today.answered_calls || 0) / today.total_calls) * 100) : 0,
        talk_time_today: today.total_talk_time || 0, talk_time_week: week.total_talk_time || 0,
        avg_duration: Math.round(today.avg_duration || 0), longest_call: today.longest_call || 0,
        peak_hour: peakHour,
        week: week.total_calls || 0, month: month.total_calls || 0, total: all.total_calls || 0,
        logged_in_today: loggedInToday,
      },
      hourly,
      recentCalls: recent,
      daily: dailyCalls,
      appointments: agentAppointments,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------------
// GET /admin/audit-log
// -------------------------------------------------------------------------
router.get('/admin/audit-log', (req, res) => {
  const entries = auditRepo.getRecent(100);
  // Map to old format
  res.json({ entries: entries.map(e => ({ id: e.id, admin_username: e.performed_by, action: e.action, target_username: e.target, details: e.details, created_at: e.created_at })) });
});

// -------------------------------------------------------------------------
// GET /admin/leaderboard
// -------------------------------------------------------------------------
router.get('/admin/leaderboard', (req, res) => {
  try {
    callsRepo.finalizeStale();
    const period = req.query.period || 'week';
    let rows;
    if (period === 'today') rows = callsRepo.getPerformanceToday();
    else if (period === 'month') rows = callsRepo.getPerformanceMonth();
    else if (period === 'all') rows = callsRepo.getPerformanceAll();
    else rows = callsRepo.getPerformanceWeek();

    // Count appointments per agent (phone match)
    const agentAppts = {};
    try {
      const { db } = require('../db/index');
      const trackingRows = db.prepare("SELECT patient_phone FROM wa_appointment_tracking WHERE confirmation_sent = 1").all();
      for (const row of trackingRows) {
        if (!row.patient_phone) continue;
        const phone = row.patient_phone.replace(/[\s\-()]/g, '');
        const match = db.prepare("SELECT agent FROM calls WHERE caller_number LIKE ? AND agent IS NOT NULL ORDER BY timestamp DESC LIMIT 1").get('%' + phone.slice(-10) + '%');
        if (match && match.agent) agentAppts[match.agent] = (agentAppts[match.agent] || 0) + 1;
      }
    } catch (e) { console.error('[admin-console] Query failed:', e.message); }

    const users = getUsers();
    const ranked = rows.map((r, i) => ({
      rank: i + 1,
      username: r.agent,
      full_name: (users[r.agent] && users[r.agent].displayName) || r.agent,
      total_calls: r.total_calls,
      answered: r.answered_calls,
      missed: r.missed_calls,
      outgoing: 0,
      answer_rate: r.total_calls > 0 ? Math.round((r.answered_calls / r.total_calls) * 100) : 0,
      talk_time: r.total_talk_time,
      avg_duration: Math.round(r.avg_duration || 0),
      appointments: agentAppts[r.agent] || 0,
      last_call: r.last_call_at,
    }));

    res.json({ period, leaderboard: ranked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------------
// GET /admin/calls/history (legacy format)
// -------------------------------------------------------------------------
router.get('/admin/calls/history', (req, res) => {
  try {
    const { db } = require('../db/index');
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];
    if (req.query.agent) { conditions.push('agent = ?'); params.push(req.query.agent); }
    if (req.query.status) { conditions.push('call_status = ?'); params.push(req.query.status); }
    if (req.query.type === 'incoming') { conditions.push("direction = 'inbound'"); }
    if (req.query.type === 'outgoing') { conditions.push("direction = 'outbound'"); }
    const dateFrom = req.query.from || req.query.date_from;
    const dateTo = req.query.to || req.query.date_to;
    if (dateFrom) { conditions.push('timestamp >= ?'); params.push(dateFrom + ' 00:00:00'); }
    if (dateTo) { conditions.push('timestamp <= ?'); params.push(dateTo + ' 23:59:59'); }
    if (req.query.search) { conditions.push("(caller_number LIKE ? OR patient_name LIKE ?)"); params.push('%' + req.query.search + '%', '%' + req.query.search + '%'); }

    const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
    const total = db.prepare('SELECT COUNT(*) as c FROM calls' + where).get(...params).c;
    const calls = db.prepare('SELECT * FROM calls' + where + ' ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(...params, limit, offset);

    res.json({ calls, total, page, totalPages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------------
// GET /admin/analytics/trends - daily trends for charts
// -------------------------------------------------------------------------
router.get('/admin/analytics/trends', (req, res) => {
  try {
    const { db } = require('../db/index');
    const days = parseInt(req.query.days) || 14;
    const agent = req.query.agent || '';

    const agentWhere = agent ? ' AND agent = ?' : '';
    const params = agent ? [agent] : [];

    const rows = db.prepare(
      "SELECT date(timestamp) as day, " +
      "SUM(CASE WHEN call_status = 'answered' THEN 1 ELSE 0 END) as answered, " +
      "SUM(CASE WHEN call_status = 'missed' THEN 1 ELSE 0 END) as missed, " +
      "SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outgoing, " +
      "COALESCE(SUM(duration), 0) as talk_time " +
      "FROM calls WHERE timestamp >= datetime('now', '-' || ? || ' days')" + agentWhere +
      " GROUP BY day ORDER BY day"
    ).all(days, ...params);

    res.json({ trends: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------------
// Callbacks — real implementation backed by callbacks table
// -------------------------------------------------------------------------
const callbacksRepo = require('../db/callbacks.repo');

router.get('/admin/callbacks/summary', (req, res) => {
  res.json(callbacksRepo.getSummary());
});

router.get('/admin/callbacks', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const status = req.query.status || '';
  const overdue = req.query.overdue === '1';
  res.json(callbacksRepo.getCallbacks({ status: status || undefined, overdue, page }));
});

// The old HTML uses POST for status updates
router.post('/admin/callbacks/:id/status', (req, res) => {
  const id = parseInt(req.params.id);
  const { status } = req.body;
  if (!id || !status) return res.json({ error: 'id and status required' });
  callbacksRepo.updateStatus(id, status);
  auditRepo.log('callback_' + status, 'callback:' + id, null, req.session.username);
  res.json({ success: true });
});

// Also support PUT (the old HTML uses both)
router.put('/admin/callbacks/:id/status', (req, res) => {
  const id = parseInt(req.params.id);
  const { status } = req.body;
  if (!id || !status) return res.json({ error: 'id and status required' });
  callbacksRepo.updateStatus(id, status);
  auditRepo.log('callback_' + status, 'callback:' + id, null, req.session.username);
  res.json({ success: true });
});

// -------------------------------------------------------------------------
// POST /admin/callbacks/:id/assign — assign callback to agent
// -------------------------------------------------------------------------
router.post('/admin/callbacks/:id/assign', (req, res) => {
  const id = parseInt(req.params.id);
  const { agent } = req.body;
  if (!id || !agent) return res.json({ error: 'id and agent required' });
  callbacksRepo.assign(id, agent);
  auditRepo.log('callback_assigned', 'callback:' + id, 'Assigned to ' + agent, req.session.username);
  res.json({ success: true });
});

// -------------------------------------------------------------------------
// POST /admin/callbacks/:id/notes — update callback notes
// -------------------------------------------------------------------------
router.post('/admin/callbacks/:id/notes', (req, res) => {
  const id = parseInt(req.params.id);
  const { notes } = req.body;
  if (!id) return res.json({ error: 'id required' });
  callbacksRepo.updateNotes(id, (notes || '').substring(0, 500));
  res.json({ success: true });
});

// -------------------------------------------------------------------------
// POST /admin/callbacks/dismiss-all — dismiss all pending callbacks
// -------------------------------------------------------------------------
router.post('/admin/callbacks/dismiss-all', (req, res) => {
  const count = callbacksRepo.dismissAllPending();
  auditRepo.log('callbacks_dismissed_all', null, count + ' callbacks', req.session.username);
  res.json({ success: true, dismissed: count });
});

// -------------------------------------------------------------------------
// POST /admin/callbacks/dismiss-old — dismiss callbacks older than X days
// -------------------------------------------------------------------------
router.post('/admin/callbacks/dismiss-old', (req, res) => {
  const days = parseInt(req.body.days) || 7;
  const count = callbacksRepo.dismissOlderThan(days);
  auditRepo.log('callbacks_dismissed_old', null, count + ' callbacks older than ' + days + ' days', req.session.username);
  res.json({ success: true, dismissed: count, days });
});

// -------------------------------------------------------------------------
// Admin → Agent Direct Messaging (via Socket.IO)
// -------------------------------------------------------------------------
router.post('/admin/message-agent', (req, res) => {
  const { agent, message } = req.body;
  if (!agent || !message) return res.status(400).json({ error: 'agent and message required' });
  const { db } = require('../db/index');

  // Persist message
  db.prepare('INSERT INTO internal_messages (from_user, to_user, message) VALUES (?, ?, ?)').run(req.session.username, agent, message.trim());

  // Real-time delivery via Socket.IO
  const io = require('../app').io;
  if (io) {
    io.to('agent:' + agent).emit('admin_message', {
      from: req.session.username,
      message: message.trim(),
      timestamp: new Date().toISOString(),
    });
    io.to('agent:' + agent).emit('chat_message', {
      from: req.session.username,
      to: agent,
      message: message.trim(),
      timestamp: new Date().toISOString(),
    });
  }

  auditRepo.log('message_sent', agent, message.substring(0, 50), req.session.username);
  logEvent('info', 'Admin message to ' + agent + ': ' + message.substring(0, 50));
  res.json({ success: true });
});

// -------------------------------------------------------------------------
// Broadcast to all active agents
// -------------------------------------------------------------------------
router.post('/admin/broadcast', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const { db } = require('../db/index');

  // Get all active agents
  const agents = db.prepare("SELECT username FROM users WHERE active = 1 AND role = 'agent' AND deleted_at IS NULL").all();

  const io = require('../app').io;
  let sent = 0;
  for (const a of agents) {
    // Persist each message
    db.prepare('INSERT INTO internal_messages (from_user, to_user, message) VALUES (?, ?, ?)').run(req.session.username, a.username, message.trim());

    // Real-time delivery
    if (io) {
      io.to('agent:' + a.username).emit('admin_message', {
        from: req.session.username,
        message: message.trim(),
        timestamp: new Date().toISOString(),
        broadcast: true,
      });
    }
    sent++;
  }

  auditRepo.log('broadcast', null, sent + ' agents: ' + message.substring(0, 50), req.session.username);
  logEvent('info', 'Admin broadcast to ' + sent + ' agents: ' + message.substring(0, 50));
  res.json({ success: true, sent_to: sent });
});

// -------------------------------------------------------------------------
// Internal Chat API — used by both admin and agents
// -------------------------------------------------------------------------
router.post('/api/chat/send', requireAuth, (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });
  const from = req.session.username;
  const { db } = require('../db/index');
  db.prepare('INSERT INTO internal_messages (from_user, to_user, message) VALUES (?, ?, ?)').run(from, to, message.trim());

  const io = require('../app').io;
  if (io) {
    const payload = { from, to, message: message.trim(), timestamp: new Date().toISOString() };
    io.to('agent:' + to).emit('chat_message', payload);
    io.to('agent:' + from).emit('chat_message', payload);
  }
  res.json({ success: true });
});

router.get('/api/chat/history/:user', requireAuth, (req, res) => {
  const me = req.session.username;
  const other = req.params.user;
  const { db } = require('../db/index');
  const messages = db.prepare(
    'SELECT * FROM internal_messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY created_at ASC LIMIT 100'
  ).all(me, other, other, me);
  // Mark as read
  db.prepare('UPDATE internal_messages SET read = 1 WHERE to_user = ? AND from_user = ? AND read = 0').run(me, other);
  res.json({ messages });
});

router.get('/api/chat/unread', requireAuth, (req, res) => {
  const me = req.session.username;
  const { db } = require('../db/index');
  const unread = db.prepare('SELECT from_user, COUNT(*) as count FROM internal_messages WHERE to_user = ? AND read = 0 GROUP BY from_user').all(me);
  const total = unread.reduce((s, r) => s + r.count, 0);
  res.json({ unread, total });
});

router.get('/api/chat/contacts', requireAuth, (req, res) => {
  const me = req.session.username;
  const { db } = require('../db/index');
  const contacts = db.prepare("SELECT username, display_name as full_name, role, status FROM users WHERE username != ? AND active = 1 AND deleted_at IS NULL ORDER BY role DESC, username ASC").all(me);
  res.json({ contacts });
});

// -------------------------------------------------------------------------
// Fix call status (admin can correct a call's status)
// -------------------------------------------------------------------------
router.post('/api/calls/:id/status', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { status } = req.body;
  if (!id || !status) return res.json({ error: 'id and status required' });
  const valid = ['answered', 'missed', 'rejected', 'outgoing', 'no_answer'];
  if (!valid.includes(status)) return res.json({ error: 'Invalid status' });
  callsRepo.updateCallStatus(id, status);
  auditRepo.log('call_status_fixed', 'call:' + id, 'Changed to: ' + status, req.session.username);
  res.json({ success: true });
});

// -------------------------------------------------------------------------
// GET /admin/wa-sessions — WhatsApp client status
// -------------------------------------------------------------------------
router.get('/admin/wa-sessions', (req, res) => {
  try {
    const waClient = require('../services/whatsappClient.service');
    const status = waClient.getStatus();
    const sessions = {};
    // Show the shared WhatsApp session
    sessions['clinic'] = { status: status === 'ready' ? 'connected' : status === 'qr' ? 'qr_pending' : 'disconnected' };
    res.json({ sessions });
  } catch (e) {
    res.json({ sessions: {} });
  }
});

// -------------------------------------------------------------------------
// GET /admin/appointments — today's appointments from tracking table
// -------------------------------------------------------------------------
router.get('/admin/appointments', (req, res) => {
  try {
    const { db } = require('../db/index');
    const period = req.query.period || 'today';
    const agent = req.query.agent || '';
    const service = req.query.service || '';

    let dateFilter = "date(appointment_date) = date('now')";
    if (period === 'week') dateFilter = "appointment_date >= datetime('now', '-7 days')";
    else if (period === 'month') dateFilter = "appointment_date >= datetime('now', '-30 days')";
    else if (period === '') dateFilter = '1=1';

    let where = 'WHERE ' + dateFilter;
    const params = [];

    // Filters
    if (service) { where += ' AND service LIKE ?'; params.push('%' + service + '%'); }
    const doctor = req.query.doctor || '';
    if (doctor) { where += ' AND doctor_name LIKE ?'; params.push('%' + doctor + '%'); }

    const appointments = db.prepare(
      'SELECT * FROM wa_appointment_tracking ' + where + ' ORDER BY appointment_date DESC LIMIT 200'
    ).all(...params);

    // Get unique values for filter dropdowns
    const services = db.prepare("SELECT DISTINCT service FROM wa_appointment_tracking WHERE service IS NOT NULL AND service != '' ORDER BY service").all().map(r => r.service);
    const doctors = db.prepare("SELECT DISTINCT doctor_name FROM wa_appointment_tracking WHERE doctor_name IS NOT NULL AND doctor_name != '' ORDER BY doctor_name").all().map(r => r.doctor_name);

    // Get agents who handled these patients' calls
    const agents = [];
    try {
      const agentRows = db.prepare("SELECT DISTINCT agent FROM calls WHERE agent IS NOT NULL ORDER BY agent").all();
      agentRows.forEach(r => agents.push(r.agent));
    } catch (e) { console.error('[admin-console] Query failed:', e.message); }

    res.json({ appointments, agents, services, doctors, total: appointments.length });
  } catch (err) {
    res.status(500).json({ error: err.message, appointments: [] });
  }
});

// -------------------------------------------------------------------------
// GET /admin/analytics/export — CSV export of call data
// -------------------------------------------------------------------------
router.get('/admin/analytics/export', (req, res) => {
  try {
    const { db } = require('../db/index');
    const range = req.query.range || 'week';
    const agent = req.query.agent || '';

    let dateFilter = "timestamp >= datetime('now', '-7 days')";
    if (range === 'today') dateFilter = "date(timestamp) = date('now')";
    else if (range === 'month') dateFilter = "timestamp >= datetime('now', '-30 days')";
    else if (range === 'all') dateFilter = '1=1';

    let where = 'WHERE ' + dateFilter;
    const params = [];
    if (agent) { where += ' AND agent = ?'; params.push(agent); }

    const calls = db.prepare('SELECT * FROM calls ' + where + ' ORDER BY timestamp DESC').all(...params);

    // Build CSV
    const headers = ['ID', 'Timestamp', 'Caller', 'Patient', 'Agent', 'Direction', 'Status', 'Duration', 'Source'];
    let csv = headers.join(',') + '\n';
    calls.forEach(c => {
      csv += [
        c.id,
        c.timestamp || '',
        '"' + (c.caller_number || '').replace(/"/g, '""') + '"',
        '"' + (c.patient_name || '').replace(/"/g, '""') + '"',
        c.agent || '',
        c.direction || '',
        c.call_status || '',
        c.duration || '',
        c.routing_method || '',
      ].join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="calls_export_' + range + '.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).send('Export failed: ' + err.message);
  }
});

module.exports = router;
