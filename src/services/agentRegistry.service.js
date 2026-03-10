'use strict';

const { IP_AGENT_TTL_MS, HEARTBEAT_STALE_MS, STARTUP_GRACE_MS, HEARTBEAT_CHECK_INTERVAL } = require('../config/constants');
const { getUsers, getMonitorTokens } = require('../config/env');
const { getClientIP, timingSafeEqual } = require('../utils/security');
const { logEvent } = require('./logging.service');

let io = null;

// IP → agent cache: { ip: { agent, lastSeen } }
const ipToAgent = {};

// Per-agent heartbeat state: { agentKey: { lastHeartbeat, alive } }
const agentHeartbeats = {};

// Only warn once per unknown raw Agent value to avoid log spam
const warnedBadAgents = new Set();

const serverStartTime = Date.now();

/**
 * Set the Socket.IO instance (call once during boot).
 * @param {import('socket.io').Server} socketIO
 */
function setIO(socketIO) {
  io = socketIO;
}

// ---------------------------------------------------------------------------
// Agent identity resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the agent identity from a request in strict deterministic order.
 *
 * Priority:
 *   1. X-Monitor-Token header  → matched against per-agent tokens
 *   2. Explicit Agent field    → must be a known user
 *   3. IP fallback (map)       → ipToAgent cache
 *   4. IP fallback (sockets)   → exactly one non-admin agent socket from same IP
 *   5. null (unknown)
 *
 * @param {import('express').Request} req
 * @returns {{ agent: string|null, method: string }}
 */
function resolveAgent(req) {
  // --- 1. Monitor token ---
  const tokenHeader = req.headers['x-monitor-token'];
  if (tokenHeader) {
    const tokens = getMonitorTokens();
    for (const [username, token] of Object.entries(tokens)) {
      if (timingSafeEqual(tokenHeader, token)) {
        return { agent: username, method: 'token' };
      }
    }
    // Token provided but didn't match any agent — fall through
  }

  // --- 2. Explicit Agent field in body ---
  const rawAgent = (req.body && req.body.Agent || '').trim();
  if (rawAgent) {
    const users = getUsers();
    if (users[rawAgent]) {
      return { agent: rawAgent, method: 'explicit' };
    }
    // Warn once about unrecognised agent values
    if (!warnedBadAgents.has(rawAgent)) {
      warnedBadAgents.add(rawAgent);
      logEvent('warn', `Unknown Agent value in request: "${rawAgent}"`, `IP: ${getClientIP(req)}`);
    }
  }

  // --- 3. IP map fallback ---
  const ip = getClientIP(req);
  const entry = ipToAgent[ip];
  if (entry && (Date.now() - entry.lastSeen) < IP_AGENT_TTL_MS) {
    return { agent: entry.agent, method: 'ip_map' };
  }

  // --- 4. IP socket fallback ---
  if (io) {
    const normalizedIP = ip.replace(/^::ffff:/, '');
    const candidates = [];
    for (const [, socket] of io.sockets.sockets) {
      if (!socket.agentUsername || socket.agentRole === 'admin') continue;
      const hdrs = socket.handshake.headers || {};
      const socketIP = (
        hdrs['x-real-ip'] ||
        hdrs['x-forwarded-for'] ||
        socket.handshake.address ||
        ''
      ).split(',')[0].trim().replace(/^::ffff:/, '');
      if (socketIP === normalizedIP) {
        candidates.push(socket.agentUsername);
      }
    }
    // Only infer when exactly one non-admin agent is connected from this IP
    if (candidates.length === 1) {
      return { agent: candidates[0], method: 'ip_socket' };
    }
  }

  // --- 5. Unknown ---
  return { agent: null, method: 'unknown' };
}

/**
 * Remember an IP → agent mapping so that future requests from the same IP
 * without an Agent field can be attributed.
 */
function rememberAgentIP(req, agent) {
  const ip = getClientIP(req);
  if (ip && agent) {
    ipToAgent[ip] = { agent, lastSeen: Date.now() };
  }
}

/**
 * Legacy helper: resolve agent from IP only (map + socket fallback).
 * Used by code that already tried explicit resolution.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function resolveAgentFromIP(req) {
  const ip = getClientIP(req);

  // Check explicit IP-to-agent map
  const entry = ipToAgent[ip];
  if (entry && (Date.now() - entry.lastSeen) < IP_AGENT_TTL_MS) {
    return entry.agent;
  }

  // Fallback: find an agent socket connected from the same IP
  if (!io) return null;
  const normalizedIP = ip.replace(/^::ffff:/, '');
  const candidates = [];
  for (const [, socket] of io.sockets.sockets) {
    if (!socket.agentUsername || socket.agentRole === 'admin') continue;
    const hdrs = socket.handshake.headers || {};
    const socketIP = (
      hdrs['x-real-ip'] ||
      hdrs['x-forwarded-for'] ||
      socket.handshake.address ||
      ''
    ).split(',')[0].trim().replace(/^::ffff:/, '');
    if (socketIP === normalizedIP) {
      candidates.push(socket.agentUsername);
    }
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Heartbeat tracking
// ---------------------------------------------------------------------------

/**
 * Record a heartbeat for the given agent (or '_default' if null).
 * @param {string|null} agent
 * @returns {{ key: string, wasDown: boolean }}
 */
function recordHeartbeat(agent) {
  const key = agent || '_default';
  const prev = agentHeartbeats[key] || { lastHeartbeat: 0, alive: false };
  const wasDown = !prev.alive;
  const now = Date.now();
  agentHeartbeats[key] = { lastHeartbeat: now, alive: true };
  return { key, wasDown };
}

/**
 * Get heartbeat state for a single agent.
 * @param {string} agent
 * @returns {{ lastHeartbeat: number, alive: boolean }|undefined}
 */
function getHeartbeatState(agent) {
  return agentHeartbeats[agent];
}

/**
 * Get the full heartbeat map (all agents).
 * @returns {Object<string, { lastHeartbeat: number, alive: boolean }>}
 */
function getAllHeartbeats() {
  return agentHeartbeats;
}

/**
 * Returns true if the server is still within the startup grace period
 * (monitors haven't had time to check in yet).
 */
function isInStartupGrace() {
  return (Date.now() - serverStartTime) < STARTUP_GRACE_MS;
}

/**
 * Start the periodic stale-heartbeat checker.  Should be called once at boot.
 * Marks agents as dead when their heartbeat exceeds HEARTBEAT_STALE_MS and
 * emits monitor_status to the appropriate rooms.
 *
 * @returns {NodeJS.Timer} the interval handle (for cleanup in tests)
 */
function startStaleChecker() {
  return setInterval(() => {
    const now = Date.now();

    // During startup grace period, don't mark anything dead
    if ((now - serverStartTime) < STARTUP_GRACE_MS) return;

    const users = getUsers();

    for (const [key, state] of Object.entries(agentHeartbeats)) {
      if (state.alive && (now - state.lastHeartbeat) > HEARTBEAT_STALE_MS) {
        const staleSec = Math.round((now - state.lastHeartbeat) / 1000);
        state.alive = false;

        if (key !== '_default' && users[key]) {
          // Known agent — notify agent room + admin room
          if (io) {
            io.to('agent:' + key).emit('monitor_status', { alive: false, agent: key });
            io.to('role:admin').emit('monitor_status', { alive: false, agent: key });
          }
          logEvent('warn', `Call monitor disconnected: ${key}`, `No heartbeat for ${staleSec}s`);
        } else {
          // Untagged / unknown — admin only
          if (io) {
            io.to('role:admin').emit('monitor_status', { alive: false, agent: null });
          }
          logEvent('warn', 'Call monitor disconnected (untagged)', `No heartbeat for ${staleSec}s`);
        }
      }
    }
  }, HEARTBEAT_CHECK_INTERVAL);
}

// ---------------------------------------------------------------------------
// User helpers
// ---------------------------------------------------------------------------

/**
 * Check if a username corresponds to a known user.
 * @param {string} username
 * @returns {boolean}
 */
function isKnownUser(username) {
  return !!getUsers()[username];
}

/**
 * Get the role of a known user.
 * @param {string} username
 * @returns {string|undefined}
 */
function getUserRole(username) {
  const user = getUsers()[username];
  return user ? user.role : undefined;
}

module.exports = {
  setIO,
  resolveAgent,
  rememberAgentIP,
  resolveAgentFromIP,
  recordHeartbeat,
  getHeartbeatState,
  getAllHeartbeats,
  isInStartupGrace,
  startStaleChecker,
  isKnownUser,
  getUserRole,
  getClientIP,
};
