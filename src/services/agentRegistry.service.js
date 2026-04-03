'use strict';

const { IP_AGENT_TTL_MS } = require('../config/constants');
const { getUsers } = require('../config/env');
const { getClientIP } = require('../utils/security');
const { logEvent } = require('./logging.service');

let io = null;

// IP → agent cache: { ip: { agent, lastSeen } }
const ipToAgent = {};

// Only warn once per unknown raw Agent value to avoid log spam
const warnedBadAgents = new Set();

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
 * Resolve the agent identity from a request.
 *
 * Priority:
 *   1. Explicit Agent field    → must be a known user
 *   2. IP fallback (map)       → ipToAgent cache
 *   3. IP fallback (sockets)   → exactly one non-admin agent socket from same IP
 *   4. null (unknown)
 *
 * @param {import('express').Request} req
 * @returns {{ agent: string|null, method: string }}
 */
function resolveAgent(req) {
  // --- 1. Explicit Agent field in body ---
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

  // --- 2. IP map fallback ---
  const ip = getClientIP(req);
  const entry = ipToAgent[ip];
  if (entry && (Date.now() - entry.lastSeen) < IP_AGENT_TTL_MS) {
    return { agent: entry.agent, method: 'ip_map' };
  }

  // --- 3. IP socket fallback ---
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

  // --- 4. Unknown ---
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
  isKnownUser,
  getUserRole,
  getClientIP,
};
