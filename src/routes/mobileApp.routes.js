'use strict';

/**
 * Mobile App (CallerIDApp) API endpoints.
 *
 * The Android app uses these endpoints:
 *   POST /api/agent/login    — authenticate agent
 *   POST /api/app/heartbeat  — keep-alive ping (every 60s)
 *   POST /api/incoming-call  — report call events (ringing, call_ended)
 */

const express = require('express');
const router = express.Router();
const { getUsers } = require('../config/env');
const { logEvent } = require('../services/logging.service');
const { normalizePKPhone } = require('../utils/phone');
const { getClientIP } = require('../utils/security');
const { rememberAgentIP, recordHeartbeat } = require('../services/agentRegistry.service');
const { emitMonitorStatus } = require('../services/callRouter.service');
const { routeCallEvent } = require('../services/callRouter.service');
const { setOnCall, clearOnCall, updateActivity, recordHeartbeatPresence } = require('../sockets/index');
const callsRepo = require('../db/calls.repo');
const { config } = require('../config/env');
const bcrypt = require('bcryptjs');

// DB-backed token store (survives restarts, works with multiple instances)
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Thin wrapper around the app_tokens table
const appTokens = {
  get(token) {
    try {
      const { db } = require('../db/index');
      return db.prepare('SELECT token, agent, role, login_at AS loginAt, ip FROM app_tokens WHERE token = ?').get(token) || undefined;
    } catch (e) { return undefined; }
  },
  set(token, entry) {
    try {
      const { db } = require('../db/index');
      db.prepare('INSERT OR REPLACE INTO app_tokens (token, agent, role, login_at, ip) VALUES (?, ?, ?, ?, ?)').run(
        token, entry.agent, entry.role || 'agent', entry.loginAt, entry.ip || null
      );
    } catch (e) { console.error('[app-tokens] set failed:', e.message); }
  },
  delete(token) {
    try {
      const { db } = require('../db/index');
      db.prepare('DELETE FROM app_tokens WHERE token = ?').run(token);
    } catch (e) {}
  },
  deleteByAgent(agent) {
    try {
      const { db } = require('../db/index');
      db.prepare('DELETE FROM app_tokens WHERE agent = ?').run(agent);
    } catch (e) {}
  },
};

// Cleanup expired tokens every 30 minutes
setInterval(() => {
  try {
    const { db } = require('../db/index');
    const cutoff = Date.now() - TOKEN_TTL_MS;
    db.prepare('DELETE FROM app_tokens WHERE login_at < ?').run(cutoff);
  } catch (e) {}
}, 30 * 60 * 1000);

function evictOldestTokens() {
  // DB handles this — no memory cap needed
}

// ---------------------------------------------------------------------------
// POST /api/agent/login — mobile app authentication (rate limited)
// ---------------------------------------------------------------------------
const { loginLimiter } = require('../middleware/rateLimit');
router.post('/api/agent/login', loginLimiter, (req, res) => {
  const { agent_id, password } = req.body;

  if (!agent_id || !password) {
    return res.status(400).json({ error: 'agent_id and password required' });
  }

  const users = getUsers();
  const user = users[agent_id];

  if (!user) {
    logEvent('warn', 'Mobile login failed: unknown agent ' + agent_id, 'IP: ' + getClientIP(req));
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Verify password (bcrypt hash or plaintext migration)
  let valid = false;
  if (user.passwordHash && user.passwordHash.startsWith('$2')) {
    valid = bcrypt.compareSync(password, user.passwordHash);
  } else {
    valid = (password === user.passwordHash);
  }

  if (!valid) {
    logEvent('warn', 'Mobile login failed: wrong password for ' + agent_id, 'IP: ' + getClientIP(req));
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Single device enforcement: invalidate all previous tokens for this agent
  appTokens.deleteByAgent(agent_id);
  logEvent('info', 'Mobile sessions invalidated for ' + agent_id + ' (new login from ' + getClientIP(req) + ')');

  // Generate a new token
  const token = require('crypto').randomBytes(32).toString('hex');
  appTokens.set(token, { agent: agent_id, role: user.role, loginAt: Date.now(), ip: getClientIP(req) });
  evictOldestTokens();

  // Record login in DB
  try {
    const usersRepo = require('../db/users.repo');
    usersRepo.recordLogin(agent_id);
    usersRepo.setStatus(agent_id, 'online');
  } catch (e) { console.error('[mobile] recordLogin failed for ' + agent_id + ':', e.message); }

  // Remember IP mapping
  const fakeReq = { headers: req.headers, ip: getClientIP(req), socket: { remoteAddress: req.ip } };
  rememberAgentIP(fakeReq, agent_id);

  logEvent('info', 'Mobile login: ' + agent_id, 'IP: ' + getClientIP(req));

  res.json({
    success: true,
    token,
    agent: agent_id,
    role: user.role,
    name: user.displayName || agent_id,
  });
});

// ---------------------------------------------------------------------------
// Middleware: resolve agent from Bearer token or agent_id in body
// ---------------------------------------------------------------------------
function resolveAppAgent(req) {
  // SECURITY: Only accept Bearer token — never trust agent_id from body
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const entry = appTokens.get(token);
    if (entry) {
      if (Date.now() - entry.loginAt > TOKEN_TTL_MS) {
        appTokens.delete(token);
        return null;
      }
      return entry.agent;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /api/app/heartbeat — mobile app keep-alive
// ---------------------------------------------------------------------------
router.post('/api/app/heartbeat', (req, res) => {
  const agent = resolveAppAgent(req);

  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Record heartbeat in agent registry
  const { wasDown } = recordHeartbeat(agent);
  emitMonitorStatus(agent, true);

  // Update presence engine (mark as mobile source)
  recordHeartbeatPresence(agent, 'mobile');
  updateActivity(agent);

  // Update last_seen in DB
  try {
    const usersRepo = require('../db/users.repo');
    usersRepo.updateLastSeen(agent);
    usersRepo.setStatus(agent, 'online');
  } catch (e) { console.error('[mobile] heartbeat DB update failed for ' + agent + ':', e.message); }

  // Remember IP mapping
  const fakeReq = { headers: req.headers, ip: getClientIP(req), socket: { remoteAddress: req.ip } };
  rememberAgentIP(fakeReq, agent);

  if (wasDown) {
    logEvent('info', 'Mobile app connected: ' + agent, 'IP: ' + getClientIP(req));
  }

  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// POST /api/incoming-call — mobile app reports a call event
//
// Body: { phone_number, agent_id, timestamp, source, event, caller_name,
//         call_type, call_status, duration }
// ---------------------------------------------------------------------------
router.post('/api/incoming-call', (req, res) => {
  const agent = resolveAppAgent(req);
  if (!agent) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const {
    phone_number,
    timestamp,
    source,
    event,
    caller_name,
    call_type,
    call_status,
    duration,
  } = req.body;

  if (!phone_number) {
    return res.status(400).json({ error: 'phone_number required' });
  }

  const caller = normalizePKPhone(phone_number) || phone_number;
  const direction = call_type === 'outgoing' ? 'outbound' : 'inbound';
  const sourceIp = getClientIP(req);

  logEvent('info', 'Mobile call: ' + event + ' from ' + caller + ' (' + agent + ')',
    'Raw: ' + phone_number + ', Normalized: ' + caller + ', Status: ' + (call_status || '-') + ', Duration: ' + (duration || 0) + 's, Type: ' + (call_type || '-'));

  if (event === 'ringing') {
    // New call — insert to DB
    const cliniceaUrl = config.CLINICEA_BASE_URL + '?tp=pat&m=' + encodeURIComponent(caller);
    const { callId } = callsRepo.insertCall(
      caller,
      'mobile-' + Date.now(),
      cliniceaUrl,
      agent,
      'mobile_app',
      sourceIp,
      direction,
      'unknown',
      source || 'phone'
    );

    // Save contact name as patient name on the call record
    if (caller_name) {
      callsRepo.updatePatientName(callId, caller_name);
    }

    // Save caller as patient in local DB
    try {
      const patientsRepo = require('../db/patients.repo');
      patientsRepo.upsertFromCall(caller_name, caller, null);
    } catch (e) { console.error('[mobile] patient upsert failed for ' + caller + ':', e.message); }

    // Mark agent busy
    setOnCall(agent);
    updateActivity(agent);

    // Route to dashboard
    routeCallEvent('incoming_call', {
      caller,
      callSid: 'mobile-' + callId,
      cliniceaUrl,
      callId,
      agent,
      direction,
      source: source || 'phone',
      patientName: caller_name || null,
      timestamp: timestamp || new Date().toISOString(),
    });

    // Patient lookup (async, non-blocking)
    try {
      const clinicea = require('../services/clinicea.service');
      if (clinicea && typeof clinicea.findPatientByPhone === 'function') {
        clinicea.findPatientByPhone(caller).then(patient => {
          if (patient && patient.name) {
            callsRepo.updatePatientName(callId, patient.name);
            if (patient.patientId) callsRepo.updatePatientId(callId, patient.patientId);
          }
        }).catch((e) => { console.error('[mobile] Clinicea patient lookup failed for ' + caller + ':', e.message); });
      }
    } catch (e) { console.error('[mobile] Clinicea service not available:', e.message); }

    return res.json({ status: 'ok', callId });

  } else if (event === 'call_ended') {
    // Call ended — update existing call or create new one (outgoing calls skip ringing)
    clearOnCall(agent);
    updateActivity(agent);

    const finalStatus = call_status || 'answered';
    const dur = duration ? parseInt(duration) : 0;

    try {
      const { db } = require('../db/index');
      const { getPhoneVariants } = require('../utils/phone');
      // Find matching recent call (within last 30 minutes for this agent + caller)
      // Use phone variants to handle format differences between ringing and call_ended
      const variants = [...getPhoneVariants(caller)];
      if (!variants.includes(caller)) variants.unshift(caller);
      const placeholders = variants.map(() => '?').join(',');
      const recent = db.prepare(
        `SELECT id, direction FROM calls WHERE agent = ? AND caller_number IN (${placeholders}) AND call_status = 'unknown' AND timestamp >= datetime('now', '-30 minutes') ORDER BY timestamp DESC LIMIT 1`
      ).get(agent, ...variants);

      logEvent('info', 'call_ended match: agent=' + agent + ', caller=' + caller + ', variants=' + variants.join('|') + ', matched=' + (recent ? recent.id : 'NONE'));

      if (recent) {
        // Always update status + duration together
        callsRepo.updateCallStatus(recent.id, finalStatus);
        if (dur > 0) {
          callsRepo.updateCallDuration(recent.id, dur);
        }
        // Fix direction if call_ended has it but original didn't
        if (call_type && ((call_type === 'outgoing' && recent.direction !== 'outbound') || (call_type === 'incoming' && recent.direction !== 'inbound'))) {
          db.prepare('UPDATE calls SET direction = ? WHERE id = ?').run(direction, recent.id);
        }
        // Update patient name from contact if available
        if (caller_name) callsRepo.updatePatientName(recent.id, caller_name);
        logEvent('info', 'Mobile call ended: ' + caller + ' (' + agent + ') — ' + finalStatus + ' ' + direction + ', ' + dur + 's');
      } else {
        // No matching ringing event — create new record (outgoing calls don't send ringing)
        const cliniceaUrl = config.CLINICEA_BASE_URL + '?tp=pat&m=' + encodeURIComponent(caller);
        const { callId } = callsRepo.insertCall(
          caller, 'mobile-' + Date.now(), cliniceaUrl, agent, 'mobile_app',
          sourceIp, direction, finalStatus, source || 'phone'
        );
        if (dur > 0) callsRepo.updateCallDuration(callId, dur);
        if (caller_name) callsRepo.updatePatientName(callId, caller_name);
        logEvent('info', 'Mobile call (new): ' + caller + ' (' + agent + ') — ' + finalStatus + ' ' + direction + ', ' + dur + 's');

        // Route to dashboard for outgoing calls too
        routeCallEvent('incoming_call', {
          caller, callSid: 'mobile-' + callId, cliniceaUrl, callId, agent,
          direction, source: source || 'phone',
          timestamp: timestamp || new Date().toISOString(),
        });
      }
    } catch (e) {
      logEvent('error', 'Failed to update call end: ' + e.message);
    }

    return res.json({ status: 'ok' });

  } else {
    // Unknown event — just log it
    logEvent('info', 'Mobile event: ' + event + ' from ' + caller + ' (' + agent + ')');
    return res.json({ status: 'ok' });
  }
});

// Expose appTokens for admin force-logout
router.appTokens = appTokens;

module.exports = router;
