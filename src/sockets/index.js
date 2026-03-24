'use strict';

const { logEvent } = require('../services/logging.service');
const { getClientIP } = require('../utils/security');
const { rememberAgentIP } = require('../services/agentRegistry.service');
const { IDLE_TIMEOUT_MS, IDLE_CHECK_INTERVAL, HEARTBEAT_STALE_MS } = require('../config/constants');

// ---------------------------------------------------------------------------
// Agent presence engine
// ---------------------------------------------------------------------------

/**
 * Per-agent state:
 *   online:        boolean — at least one source connected
 *   portalOnline:  boolean — web dashboard socket connected
 *   mobileOnline:  boolean — mobile app heartbeat active
 *   socketCount:   number  — how many browser tabs/sockets
 *   lastActivity:  number  — ms timestamp of last activity signal
 *   lastMobileHb:  number  — ms timestamp of last mobile heartbeat
 *   onCall:        boolean — currently handling a call
 *   status:        string  — computed: online | busy | idle | offline
 */
const agentPresence = {};

/** socket.id → username mapping for fast lookup */
const socketToAgent = {};

let _io = null;

// ---------------------------------------------------------------------------
// Status computation
// ---------------------------------------------------------------------------

function computeStatus(username) {
  const p = agentPresence[username];
  if (!p || !p.online) return 'offline';
  if (p.onCall) return 'busy';
  if (p.lastActivity && (Date.now() - p.lastActivity) > IDLE_TIMEOUT_MS) return 'idle';
  return 'online';
}

function persistAndBroadcast(username) {
  const p = agentPresence[username];
  if (!p) return;
  const newStatus = computeStatus(username);
  const changed = p.status !== newStatus;
  p.status = newStatus;

  // Persist to DB
  try {
    const usersRepo = require('../db/users.repo');
    usersRepo.setStatus(username, newStatus);
    if (newStatus === 'offline') usersRepo.updateLastSeen(username);
  } catch (e) { /* ignore */ }

  // Broadcast to admins (always, so dashboard stays fresh)
  if (_io) {
    _io.to('role:admin').emit('agent_status_update', {
      username,
      status: newStatus,
      lastActivity: p.lastActivity,
      onCall: p.onCall || false,
      changed,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API — called from routes/services
// ---------------------------------------------------------------------------

function getPresence(username) {
  return agentPresence[username] || { online: false, portalOnline: false, mobileOnline: false, lastActivity: null, lastMobileHb: null, socketCount: 0, onCall: false, status: 'offline' };
}

function getAllPresence() {
  return agentPresence;
}

/** Called when a call starts — sets agent to busy */
function setOnCall(username) {
  if (!username) return;
  ensurePresence(username);
  agentPresence[username].onCall = true;
  agentPresence[username].lastActivity = Date.now();
  persistAndBroadcast(username);
  logEvent('info', 'Agent ' + username + ' → busy (on call)');
}

/** Called when a call ends — clears busy */
function clearOnCall(username) {
  if (!username) return;
  ensurePresence(username);
  agentPresence[username].onCall = false;
  agentPresence[username].lastActivity = Date.now();
  persistAndBroadcast(username);
  logEvent('info', 'Agent ' + username + ' → call ended');
}

/** Called on any activity (heartbeat, frontend ping, call event) */
function updateActivity(username) {
  if (!username) return;
  ensurePresence(username);
  agentPresence[username].lastActivity = Date.now();
  // Only persist+broadcast if status would change (avoid spam)
  const current = agentPresence[username].status;
  const next = computeStatus(username);
  if (current !== next) persistAndBroadcast(username);
}

/** Called from heartbeat route — agent's call monitor / mobile app is alive */
function recordHeartbeatPresence(username, source) {
  if (!username) return;
  ensurePresence(username);
  agentPresence[username].lastActivity = Date.now();
  // Track which source the heartbeat came from
  if (source === 'mobile') {
    agentPresence[username].mobileOnline = true;
    agentPresence[username].lastMobileHb = Date.now();
  }
  // Heartbeat alone means online
  if (!agentPresence[username].online) {
    agentPresence[username].online = true;
  }
  const next = computeStatus(username);
  if (agentPresence[username].status !== next) persistAndBroadcast(username);
}

function ensurePresence(username) {
  if (!agentPresence[username]) {
    agentPresence[username] = { online: false, portalOnline: false, mobileOnline: false, lastActivity: null, lastMobileHb: null, socketCount: 0, onCall: false, status: 'offline' };
  }
}

// ---------------------------------------------------------------------------
// Idle sweep — runs periodically to detect agents gone idle
// ---------------------------------------------------------------------------

function startIdleSweep() {
  setInterval(() => {
    const now = Date.now();
    for (const [username, p] of Object.entries(agentPresence)) {
      // Check if mobile heartbeat went stale (no heartbeat for 90s)
      if (p.mobileOnline && p.lastMobileHb && (now - p.lastMobileHb) > HEARTBEAT_STALE_MS) {
        p.mobileOnline = false;
        // If portal is also disconnected, agent goes offline
        if (!p.portalOnline) p.online = false;
      }

      if (!p.online) continue;
      const prev = p.status;
      const next = computeStatus(username);
      if (prev !== next) {
        persistAndBroadcast(username);
      }
    }
  }, IDLE_CHECK_INTERVAL);
}

// ---------------------------------------------------------------------------
// Socket.IO setup
// ---------------------------------------------------------------------------

function getSocketIP(handshake) {
  const fakeReq = {
    headers: handshake.headers || {},
    ip: handshake.address || '',
    socket: { remoteAddress: handshake.address || '' },
  };
  return getClientIP(fakeReq);
}

function setupSockets(io, sessionMiddleware) {
  _io = io;
  io.engine.use(sessionMiddleware);

  // Start idle detection sweep
  startIdleSweep();

  io.on('connection', (socket) => {
    const session = socket.request.session;
    const username = session && session.username;
    const role = session && session.role;

    socket.agentUsername = username || null;
    socket.agentRole = role || null;

    if (username) {
      // Track socket → agent mapping
      socketToAgent[socket.id] = username;

      // Join rooms
      socket.join('agent:' + username);
      const rooms = ['agent:' + username];
      if (role === 'admin') { socket.join('role:admin'); rooms.push('role:admin'); }

      const ip = getSocketIP(socket.handshake);
      logEvent('info', 'Socket connected: ' + username + ' (' + role + ')', 'IP: ' + ip + ' | SID: ' + socket.id);

      // IP mapping for call monitor attribution
      if (role !== 'admin' && ip) {
        const fakeReq = { headers: socket.handshake.headers || {}, ip, socket: { remoteAddress: socket.handshake.address || '' } };
        rememberAgentIP(fakeReq, username);
      }

      // --- Update presence ---
      ensurePresence(username);
      agentPresence[username].socketCount++;
      agentPresence[username].online = true;
      agentPresence[username].portalOnline = true;
      agentPresence[username].lastActivity = Date.now();
      persistAndBroadcast(username);

      // Record login in DB
      try { require('../db/users.repo').recordLogin(username); } catch (e) { /* ignore */ }

      // --- Activity ping from frontend (every 60s) ---
      socket.on('activity', () => {
        updateActivity(username);
        try { require('../db/users.repo').updateLastSeen(username); } catch (e) { /* ignore */ }
      });

      socket.emit('join_confirm', { username, role, rooms, socketId: socket.id });
    } else {
      logEvent('warn', 'Socket connected (unauthenticated)', 'SID: ' + socket.id);
      socket.emit('join_confirm', { username: null, role: null, rooms: [], socketId: socket.id, error: 'Session not found — please log in again' });
    }

    // --- Disconnect ---
    socket.on('disconnect', () => {
      const agent = socketToAgent[socket.id];
      delete socketToAgent[socket.id];

      logEvent('info', 'Socket disconnected: ' + (agent || 'unknown'), 'SID: ' + socket.id);

      if (agent && agentPresence[agent]) {
        agentPresence[agent].socketCount = Math.max(0, agentPresence[agent].socketCount - 1);
        if (agentPresence[agent].socketCount === 0) {
          agentPresence[agent].portalOnline = false;
          // Only go offline if mobile is also not connected
          agentPresence[agent].online = agentPresence[agent].mobileOnline;
          agentPresence[agent].lastActivity = Date.now();
          if (!agentPresence[agent].online) agentPresence[agent].onCall = false;
          persistAndBroadcast(agent);
        }
      }
    });
  });
}

module.exports = {
  setupSockets,
  getPresence,
  getAllPresence,
  updateActivity,
  setOnCall,
  clearOnCall,
  recordHeartbeatPresence,
};
