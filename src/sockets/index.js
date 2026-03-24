'use strict';

const { logEvent } = require('../services/logging.service');
const { getClientIP } = require('../utils/security');
const { rememberAgentIP } = require('../services/agentRegistry.service');

// ---------------------------------------------------------------------------
// Live agent presence tracking
// ---------------------------------------------------------------------------

// { username: { online: true, lastActivity: Date.now(), socketCount: 0 } }
const agentPresence = {};

function getPresence(username) {
  return agentPresence[username] || { online: false, lastActivity: null, socketCount: 0 };
}

function getAllPresence() {
  return agentPresence;
}

function updateActivity(username) {
  if (!username) return;
  if (!agentPresence[username]) agentPresence[username] = { online: false, lastActivity: null, socketCount: 0 };
  agentPresence[username].lastActivity = Date.now();
}

/**
 * Extract the client IP from a Socket.IO handshake object.
 *
 * getClientIP() expects a req-like object with `.headers`, `.ip`, and
 * `.socket.remoteAddress`.  The Socket.IO handshake has `.headers` and
 * `.address` but not the Express helpers, so we build a thin shim.
 *
 * @param {object} handshake - socket.handshake
 * @returns {string}
 */
function getSocketIP(handshake) {
  // Build a req-like object that getClientIP can consume
  const fakeReq = {
    headers: handshake.headers || {},
    ip: handshake.address || '',
    socket: { remoteAddress: handshake.address || '' },
  };
  return getClientIP(fakeReq);
}

/**
 * Set up Socket.IO connection handling with session-based rooms.
 *
 * Preserves the exact room-joining behaviour from the original server.js
 * (lines 2220-2271):
 *   - Authenticated users join `agent:<username>`.
 *   - Admins additionally join `role:admin`.
 *   - Unauthenticated sockets join NO rooms and receive nothing.
 *   - Non-admin agents seed the IP-to-agent map so the call monitor on the
 *     same machine can be attributed.
 *
 * @param {import('socket.io').Server} io
 * @param {import('express').RequestHandler} sessionMiddleware
 */
function setupSockets(io, sessionMiddleware) {
  // Share the Express session middleware with the Socket.IO engine so that
  // socket.request.session is populated on every connection.
  io.engine.use(sessionMiddleware);

  io.on('connection', (socket) => {
    const session = socket.request.session;
    const username = session && session.username;
    const role = session && session.role;

    // Store identity on the socket instance for IP-based agent resolution
    // (used by agentRegistry.service when scanning connected sockets).
    socket.agentUsername = username || null;
    socket.agentRole = role || null;

    if (username) {
      // Each user joins ONLY their own agent room
      socket.join('agent:' + username);
      const rooms = ['agent:' + username];

      if (role === 'admin') {
        socket.join('role:admin');
        rooms.push('role:admin');
      }

      const ip = getSocketIP(socket.handshake);

      logEvent(
        'info',
        'Socket connected: ' + username + ' (' + role + ')',
        'Rooms: ' + rooms.join(', ') + ' | IP: ' + ip + ' | SID: ' + socket.id
      );

      // Seed IP-to-agent mapping from socket connections so that the call
      // monitor running on the same PC can be attributed to this agent.
      if (role !== 'admin' && ip) {
        // rememberAgentIP expects a req-like object with headers /
        // connection.remoteAddress — build one from the handshake.
        const fakeReq = {
          headers: socket.handshake.headers || {},
          ip: ip,
          socket: { remoteAddress: socket.handshake.address || '' },
        };
        rememberAgentIP(fakeReq, username);
        logEvent('info', 'IP-to-agent mapped: ' + ip + ' => ' + username + ' (from socket)');
      }

      // Track presence
      if (!agentPresence[username]) agentPresence[username] = { online: false, lastActivity: null, socketCount: 0 };
      agentPresence[username].socketCount++;
      agentPresence[username].online = true;
      agentPresence[username].lastActivity = Date.now();

      // Broadcast presence update to admins
      io.to('role:admin').emit('agent_presence', {
        username, status: 'online', lastActivity: agentPresence[username].lastActivity,
      });

      // Listen for activity pings from frontend
      socket.on('activity', function() {
        updateActivity(username);
        // Persist last_seen to DB (throttled — only every 60s via frontend ping)
        try {
          const usersRepo = require('../db/users.repo');
          usersRepo.updateLastSeen(username);
        } catch (e) { /* ignore */ }
      });

      // Tell the client which rooms it joined so the frontend can verify
      socket.emit('join_confirm', {
        username: username,
        role: role,
        rooms: rooms,
        socketId: socket.id,
      });
    } else {
      // Unauthenticated sockets join NO rooms — they receive nothing
      logEvent(
        'warn',
        'Socket connected (unauthenticated) — no rooms joined',
        'SID: ' + socket.id
      );
      socket.emit('join_confirm', {
        username: null,
        role: null,
        rooms: [],
        socketId: socket.id,
        error: 'Session not found — please log in again',
      });
    }

    socket.on('disconnect', () => {
      logEvent(
        'info',
        'Socket disconnected: ' + (username || 'unknown'),
        'SID: ' + socket.id
      );

      // Update presence
      if (username && agentPresence[username]) {
        agentPresence[username].socketCount = Math.max(0, agentPresence[username].socketCount - 1);
        if (agentPresence[username].socketCount === 0) {
          agentPresence[username].online = false;
          agentPresence[username].lastActivity = Date.now();
          // Broadcast to admins
          io.to('role:admin').emit('agent_presence', {
            username, status: 'offline', lastActivity: agentPresence[username].lastActivity,
          });
        }
      }
    });
  });
}

module.exports = { setupSockets, getPresence, getAllPresence, updateActivity };
