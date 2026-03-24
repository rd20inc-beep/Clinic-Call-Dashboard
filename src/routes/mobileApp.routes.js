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

// In-memory token → agent map (simple auth for mobile app)
const appTokens = {};

// ---------------------------------------------------------------------------
// POST /api/agent/login — mobile app authentication
// ---------------------------------------------------------------------------
router.post('/api/agent/login', (req, res) => {
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
  for (const [existingToken, entry] of Object.entries(appTokens)) {
    if (entry.agent === agent_id) {
      delete appTokens[existingToken];
      logEvent('info', 'Mobile session invalidated for ' + agent_id + ' (new login from ' + getClientIP(req) + ')');
    }
  }

  // Generate a new token
  const token = require('crypto').randomBytes(32).toString('hex');
  appTokens[token] = { agent: agent_id, role: user.role, loginAt: Date.now(), ip: getClientIP(req) };

  // Record login in DB
  try {
    const usersRepo = require('../db/users.repo');
    usersRepo.recordLogin(agent_id);
    usersRepo.setStatus(agent_id, 'online');
  } catch (e) { /* ignore */ }

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
  // Try Bearer token first
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const entry = appTokens[token];
    if (entry) return entry.agent;
  }
  // Fall back to agent_id in body
  return req.body.agent_id || null;
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
  } catch (e) { /* ignore */ }

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
    'Status: ' + (call_status || '-') + ', Duration: ' + (duration || 0) + 's');

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

    // Save caller as patient
    try {
      const patientsRepo = require('../db/patients.repo');
      patientsRepo.upsertFromCall(caller_name, caller, null);
    } catch (e) { /* ignore */ }

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
        }).catch(() => {});
      }
    } catch (e) { /* clinicea not available */ }

    return res.json({ status: 'ok', callId });

  } else if (event === 'call_ended') {
    // Call ended — update existing call or create new one (outgoing calls skip ringing)
    clearOnCall(agent);
    updateActivity(agent);

    const finalStatus = call_status || 'answered';
    const dur = duration ? parseInt(duration) : 0;

    try {
      const { db } = require('../db/index');
      // Find matching recent call (within last 10 minutes for this agent + caller)
      const recent = db.prepare(
        "SELECT id, direction FROM calls WHERE agent = ? AND caller_number = ? AND timestamp >= datetime('now', '-10 minutes') ORDER BY timestamp DESC LIMIT 1"
      ).get(agent, caller);

      if (recent) {
        // Update existing call
        if (dur > 0) {
          callsRepo.updateCallDuration(recent.id, dur);
        } else {
          callsRepo.updateCallStatus(recent.id, finalStatus);
        }
        // Fix direction if call_ended has it but original didn't
        if (call_type && ((call_type === 'outgoing' && recent.direction !== 'outbound') || (call_type === 'incoming' && recent.direction !== 'inbound'))) {
          db.prepare('UPDATE calls SET direction = ? WHERE id = ?').run(direction, recent.id);
        }
        logEvent('info', 'Mobile call ended: ' + caller + ' (' + agent + ') — ' + finalStatus + ' ' + direction + ', ' + dur + 's');
      } else {
        // No matching ringing event — create new record (outgoing calls don't send ringing)
        const cliniceaUrl = config.CLINICEA_BASE_URL + '?tp=pat&m=' + encodeURIComponent(caller);
        const { callId } = callsRepo.insertCall(
          caller, 'mobile-' + Date.now(), cliniceaUrl, agent, 'mobile_app',
          sourceIp, direction, finalStatus, source || 'phone'
        );
        if (dur > 0) callsRepo.updateCallDuration(callId, dur);
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
