'use strict';

let io = null;

/**
 * Set the Socket.IO instance (call once during boot).
 * @param {import('socket.io').Server} socketIO
 */
function setIO(socketIO) {
  io = socketIO;
}

/**
 * Route a call event to the appropriate sockets.
 *
 * STRICT: never broadcast to all — always target specific rooms.
 *   - If the event has a known agent, emit to `agent:<name>` AND `role:admin`.
 *   - If the agent is unknown/null, emit to `role:admin` only.
 *
 * @param {string} eventName  Socket.IO event name (e.g. 'incoming_call')
 * @param {Object} callEvent  Payload to emit
 * @returns {{ agentSockets: number, adminSockets: number }}
 */
function routeCallEvent(eventName, callEvent) {
  const agent = callEvent.agent;
  const result = { agentSockets: 0, adminSockets: 0 };

  if (agent) {
    const agentRoom = io.sockets.adapter.rooms.get('agent:' + agent);
    const adminRoom = io.sockets.adapter.rooms.get('role:admin');
    result.agentSockets = agentRoom ? agentRoom.size : 0;
    result.adminSockets = adminRoom ? adminRoom.size : 0;

    io.to('agent:' + agent).emit(eventName, callEvent);
    io.to('role:admin').emit(eventName, callEvent);
  } else {
    const adminRoom = io.sockets.adapter.rooms.get('role:admin');
    result.adminSockets = adminRoom ? adminRoom.size : 0;

    io.to('role:admin').emit(eventName, callEvent);
  }

  return result;
}

/**
 * Emit monitor_status to the appropriate rooms.
 *
 * @param {string|null} agent  Agent username, or null for untagged monitors
 * @param {boolean}     alive  Whether the monitor is alive
 */
function emitMonitorStatus(agent, alive) {
  if (!io) return;

  if (agent) {
    io.to('agent:' + agent).emit('monitor_status', { alive, agent });
    io.to('role:admin').emit('monitor_status', { alive, agent });
  } else {
    io.to('role:admin').emit('monitor_status', { alive, agent: null });
  }
}

module.exports = { setIO, routeCallEvent, emitMonitorStatus };
