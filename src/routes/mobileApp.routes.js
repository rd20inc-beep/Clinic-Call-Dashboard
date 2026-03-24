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

  // Generate a simple token
  const token = require('crypto').randomBytes(32).toString('hex');
  appTokens[token] = { agent: agent_id, role: user.role, loginAt: Date.now() };

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

  // Update presence engine
  recordHeartbeatPresence(agent);
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
      'unknown'
    );

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
    // Call ended — update existing call with status and duration
    clearOnCall(agent);
    updateActivity(agent);

    // Find the most recent call for this agent and caller
    try {
      const { db } = require('../db/index');
      const recent = db.prepare(
        "SELECT id FROM calls WHERE agent = ? AND caller_number = ? ORDER BY timestamp DESC LIMIT 1"
      ).get(agent, caller);

      if (recent) {
        const finalStatus = call_status || 'answered';
        if (duration && parseInt(duration) > 0) {
          callsRepo.updateCallDuration(recent.id, parseInt(duration));
        } else {
          callsRepo.updateCallStatus(recent.id, finalStatus);
        }
        logEvent('info', 'Mobile call ended: ' + caller + ' (' + agent + ') — ' + finalStatus + ', ' + (duration || 0) + 's');
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

module.exports = router;
