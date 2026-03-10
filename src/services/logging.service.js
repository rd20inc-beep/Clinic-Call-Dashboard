'use strict';

const { MAX_EVENT_LOG } = require('../config/constants');

let io = null;
const eventLog = [];

/**
 * Set the Socket.IO instance (can be called lazily after server boot).
 * @param {import('socket.io').Server} socketIO
 */
function setIO(socketIO) {
  io = socketIO;
}

/**
 * Record a server event, push it to the in-memory log, emit to admin
 * sockets, and write to the console.
 *
 * @param {'info'|'warn'|'error'|'debug'} type
 * @param {string} message
 * @param {string|null} [details]
 */
function logEvent(type, message, details) {
  const entry = {
    type,
    message,
    details: details || null,
    time: new Date().toISOString(),
  };

  // Maintain a capped ring-buffer of the last MAX_LOG entries
  eventLog.push(entry);
  if (eventLog.length > MAX_EVENT_LOG) {
    eventLog.shift();
  }

  // Emit ONLY to the admin room — NEVER io.emit() to all sockets
  if (io) {
    io.to('role:admin').emit('server_log', entry);
  }

  // Console output — skip debug unless development mode
  if (type === 'debug' && process.env.NODE_ENV !== 'development') {
    return;
  }

  const prefix =
    type === 'error' ? '[ERROR]' :
    type === 'warn'  ? '[WARN]'  :
    type === 'debug' ? '[DEBUG]' :
    '[INFO]';

  console.log(`${prefix} ${message}${details ? ' | ' + details : ''}`);
}

/**
 * Return the current in-memory event log (up to MAX_LOG entries).
 * @returns {Array<{type: string, message: string, details: string|null, time: string}>}
 */
function getEventLog() {
  return eventLog;
}

module.exports = { setIO, logEvent, getEventLog };
