'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { logEvent } = require('./logging.service');
const waRepo = require('../db/whatsapp.repo');
const waService = require('./whatsapp.service');

// ---------------------------------------------------------------------------
// Business hours check (configurable, default 9 AM - 7 PM Pakistan time)
// ---------------------------------------------------------------------------
function isWithinBusinessHours() {
  const now = new Date();
  const pkHour = (now.getUTCHours() + 5) % 24;
  const startHour = parseInt(waRepo.getSetting('business_hour_start') || '9', 10);
  const endHour = parseInt(waRepo.getSetting('business_hour_end') || '19', 10);
  return pkHour >= startHour && pkHour < endHour;
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------
let client = null;
let io = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'qr' | 'authenticated' | 'ready'
let sendInterval = null;
let reinitTimeout = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 30_000; // 30 seconds

function setIO(socketIO) {
  io = socketIO;
}

function getStatus() {
  return connectionStatus;
}

// ---------------------------------------------------------------------------
// Phone normalization helpers
// ---------------------------------------------------------------------------

/** Convert stored phone (+923001234567) to WhatsApp chat ID (923001234567@c.us) */
function toWAId(phone) {
  return phone.replace(/[^0-9]/g, '') + '@c.us';
}

/** Convert WhatsApp chat ID (923001234567@c.us) to stored phone (+923001234567) */
function fromWAId(waId) {
  return '+' + waId.replace(/@.*$/, '');
}

// ---------------------------------------------------------------------------
// Approved message sender (polls every 5 seconds)
// ---------------------------------------------------------------------------

function startSendLoop() {
  if (sendInterval) clearInterval(sendInterval);
  sendInterval = setInterval(async () => {
    if (connectionStatus !== 'ready' || !client) return;
    if (!waService.isBotEnabled()) return; // Admin can pause all message sending
    // if (!isWithinBusinessHours()) return; // TEMPORARILY DISABLED FOR TESTING

    try {
      waRepo.expireStaleMessages();
      const pending = waRepo.getPendingOutgoing(); // gets approved, marks as 'sending'

      for (const msg of pending) {
        try {
          const chatId = toWAId(msg.phone);
          await client.sendMessage(chatId, msg.message);
          waRepo.markMessageSent(msg.id);
          logEvent('info', 'WA message sent to ' + msg.phone);
        } catch (err) {
          waRepo.markMessageFailed(msg.id);
          logEvent('error', 'WA send failed for ' + msg.phone + ': ' + err.message);
        }
      }
    } catch (err) {
      logEvent('error', 'WA send loop error: ' + err.message);
    }
  }, 5000);
}

// ---------------------------------------------------------------------------
// Initialize the WhatsApp client
// ---------------------------------------------------------------------------

async function initialize() {
  // Clean up any existing client (with timeout — destroy can hang)
  if (client) {
    const oldClient = client;
    client = null;
    try {
      await Promise.race([
        oldClient.destroy(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('destroy timeout')), 10000)),
      ]);
    } catch (e) {
      logEvent('warn', 'WA old client cleanup: ' + e.message);
    }
  }
  if (reinitTimeout) {
    clearTimeout(reinitTimeout);
    reinitTimeout = null;
  }

  // Kill any orphaned Chrome processes using the session directory
  try {
    const { execSync } = require('child_process');
    const authPath = require('path').resolve('.wwebjs_auth/session');
    // Find and kill Chrome processes using this data dir
    execSync(`pkill -f "${authPath}" 2>/dev/null || true`, { timeout: 5000 });
    // Also remove the stale lock file if present
    const lockFile = require('path').join(authPath, 'SingletonLock');
    try { require('fs').unlinkSync(lockFile); } catch (_) {}
    logEvent('info', 'WA cleaned up stale browser processes');
  } catch (e) {
    logEvent('warn', 'WA browser cleanup: ' + e.message);
  }

  connectionStatus = 'disconnected';

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
      ],
    },
  });

  // --- QR Code ---
  client.on('qr', async (qr) => {
    try {
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
      connectionStatus = 'qr';
      if (io) io.to('role:admin').emit('wa_connection', { status: 'qr', qrDataUrl });
      logEvent('info', 'WA QR code generated — waiting for scan');
    } catch (err) {
      logEvent('error', 'WA QR generation error: ' + err.message);
    }
  });

  // --- Authenticated ---
  client.on('authenticated', () => {
    connectionStatus = 'authenticated';
    if (io) io.to('role:admin').emit('wa_connection', { status: 'authenticated' });
    logEvent('info', 'WA client authenticated');
  });

  // --- Ready ---
  client.on('ready', () => {
    connectionStatus = 'ready';
    reconnectAttempts = 0; // reset backoff on successful connection
    if (io) io.to('role:admin').emit('wa_connection', { status: 'ready' });
    logEvent('info', 'WA client ready and connected');
  });

  // --- Disconnected ---
  client.on('disconnected', (reason) => {
    connectionStatus = 'disconnected';
    if (io) io.to('role:admin').emit('wa_connection', { status: 'disconnected', reason });
    logEvent('warn', 'WA client disconnected: ' + reason);

    // Exponential backoff reconnection
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logEvent('error', `WA reconnection abandoned after ${MAX_RECONNECT_ATTEMPTS} attempts — manual restart required`);
      if (io) io.to('role:admin').emit('wa_connection', { status: 'disconnected', reason: 'max_retries_exceeded' });
      return;
    }
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts), 5 * 60 * 1000); // max 5 min
    reconnectAttempts++;
    logEvent('info', `WA reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay / 1000)}s`);
    reinitTimeout = setTimeout(() => {
      initialize().catch((err) => {
        logEvent('error', 'WA reconnect failed: ' + err.message);
      });
    }, delay);
  });

  // --- Auth failure ---
  client.on('auth_failure', (msg) => {
    connectionStatus = 'disconnected';
    if (io) io.to('role:admin').emit('wa_connection', { status: 'disconnected', reason: 'auth_failure: ' + msg });
    logEvent('error', 'WA auth failure: ' + msg);
  });

  // --- Incoming message ---
  client.on('message', async (msg) => {
    try {
      // Only handle direct messages, not groups
      if (!msg.from || !msg.from.endsWith('@c.us')) return;
      // Skip status broadcasts
      if (msg.from === 'status@broadcast') return;

      const phone = fromWAId(msg.from);
      const text = msg.body;
      if (!text) return;

      const contact = await msg.getContact();
      const chatName = contact.pushname || contact.name || null;
      const messageId = msg.id._serialized || null;

      // Dedup check
      if (messageId && waRepo.isMessageDuplicate(messageId)) {
        return;
      }

      logEvent('info', 'WA message from ' + (chatName || phone) + ': ' + text.substring(0, 50));

      // Store incoming message
      waRepo.insertMessage(phone, chatName, 'in', text, 'chat', 'sent', null, messageId);

      // Notify admin dashboard of incoming message (no auto-reply)
      // System only sends queued messages (confirmations, reminders, manual sends)
      if (io) io.to('role:admin').emit('wa_message', {
        phone, chatName, direction: 'in', text,
        reply: null, timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logEvent('error', 'WA message handler error: ' + err.message);
    }
  });

  // Start the client
  logEvent('info', 'WA client initializing...');
  if (io) io.to('role:admin').emit('wa_connection', { status: 'authenticating' });
  await client.initialize();

  // Start the send loop
  startSendLoop();
}

// ---------------------------------------------------------------------------
// Logout (clears session, requires new QR scan)
// ---------------------------------------------------------------------------

async function logout() {
  if (reinitTimeout) {
    clearTimeout(reinitTimeout);
    reinitTimeout = null;
  }
  if (client) {
    try {
      await client.logout();
    } catch (e) { /* may already be disconnected */ }
    try {
      await client.destroy();
    } catch (e) { /* ignore */ }
    client = null;
  }
  connectionStatus = 'disconnected';
  if (io) io.to('role:admin').emit('wa_connection', { status: 'disconnected', reason: 'manual_logout' });
}

// ---------------------------------------------------------------------------
// Destroy (for graceful shutdown, does not clear session)
// ---------------------------------------------------------------------------

async function destroy() {
  if (sendInterval) clearInterval(sendInterval);
  if (reinitTimeout) clearTimeout(reinitTimeout);
  if (client) {
    try { await client.destroy(); } catch (e) { /* ignore */ }
    client = null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  setIO,
  getStatus,
  initialize,
  logout,
  destroy,
  isWithinBusinessHours,
};
