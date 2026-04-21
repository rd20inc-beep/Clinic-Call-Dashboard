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
let lastQrDataUrl = null;
let sendTimeout = null;
let keepaliveInterval = null;
let reinitTimeout = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 15;
const BASE_RECONNECT_DELAY_MS = 15_000; // 15 seconds (faster first retry)

// ---------------------------------------------------------------------------
// Anti-spam pacing — WhatsApp flags numbers that burst-send on a fixed cadence.
// Every send is wrapped in randomized jitter + a typing indicator to look human,
// and hard hourly/24h caps cut the loop off before it can earn another strike.
// ---------------------------------------------------------------------------
const MIN_GAP_MS = 15_000;          // 15s minimum — caps worst-case at 4 msg/min
const MAX_GAP_MS = 25_000;          // 25s maximum — avg ~20s (~3 msg/min)
const TYPING_MIN_MS = 1_000;        // typing indicator shown for at least 1s
const TYPING_MAX_MS = 3_000;        // ...up to 3s before the message goes out
const HOURLY_CAP = 45;              // strictly below 50 per rolling hour
const DAILY_CAP = 400;              // per rolling 24h
const CAP_BACKOFF_MS = 5 * 60_000;  // pause 5 min when a cap is hit
const IDLE_POLL_MS = 5_000;         // gap between ticks when nothing to send

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setIO(socketIO) {
  io = socketIO;
}

// Emit to admin + agent1 (both have WA management rights)
function emitWA(event, data) {
  if (!io) return;
  io.to('role:admin').emit(event, data);
  io.to('agent:agent1').emit(event, data);
}

function getStatus() {
  return connectionStatus;
}

function getQrDataUrl() {
  return connectionStatus === 'qr' ? lastQrDataUrl : null;
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
// Approved message sender — self-rescheduling loop with randomized jitter,
// typing indicator, and rolling hourly/daily caps. One message per tick.
// ---------------------------------------------------------------------------

function scheduleNextSend(delayMs) {
  if (sendTimeout) clearTimeout(sendTimeout);
  sendTimeout = setTimeout(() => { sendTick().catch(() => {}); }, delayMs);
}

async function sendTick() {
  if (connectionStatus !== 'ready' || !client) {
    return scheduleNextSend(IDLE_POLL_MS);
  }
  if (!waService.isBotEnabled()) return scheduleNextSend(IDLE_POLL_MS);
  if (!isWithinBusinessHours()) return scheduleNextSend(IDLE_POLL_MS);

  try {
    waRepo.expireStaleMessages();

    // Rate limit guards — if a cap is hit, sleep long enough for the window to shift.
    if (waRepo.countSentInLastHour() >= HOURLY_CAP) {
      logEvent('warn', `WA hourly cap (${HOURLY_CAP}) reached — pausing ${CAP_BACKOFF_MS / 1000}s`);
      return scheduleNextSend(CAP_BACKOFF_MS);
    }
    if (waRepo.countSentInLast24h() >= DAILY_CAP) {
      logEvent('warn', `WA daily cap (${DAILY_CAP}) reached — pausing ${CAP_BACKOFF_MS / 1000}s`);
      return scheduleNextSend(CAP_BACKOFF_MS);
    }

    const pending = waRepo.getPendingOutgoing(); // LIMIT 1, marks as 'sending'
    if (pending.length === 0) {
      return scheduleNextSend(IDLE_POLL_MS);
    }

    const msg = pending[0];
    const chatId = toWAId(msg.phone);

    try {
      // Typing indicator — makes the send look like a human composing a reply.
      try {
        const chat = await client.getChat(chatId);
        await chat.sendStateTyping();
        await sleep(randInt(TYPING_MIN_MS, TYPING_MAX_MS));
      } catch (_) { /* typing is best-effort */ }

      await client.sendMessage(chatId, msg.message);
      waRepo.markMessageSent(msg.id);
      logEvent('info', 'WA message sent to ' + msg.phone);
    } catch (err) {
      waRepo.markMessageFailed(msg.id);
      logEvent('error', 'WA send failed for ' + msg.phone + ': ' + err.message);
    }
  } catch (err) {
    logEvent('error', 'WA send loop error: ' + err.message);
  }

  scheduleNextSend(randInt(MIN_GAP_MS, MAX_GAP_MS));
}

function startSendLoop() {
  scheduleNextSend(IDLE_POLL_MS);
}

// ---------------------------------------------------------------------------
// Initialize the WhatsApp client
// ---------------------------------------------------------------------------

async function initialize() {
  // Stop timers first to prevent concurrent re-entry
  if (keepaliveInterval) { clearInterval(keepaliveInterval); keepaliveInterval = null; }
  if (sendTimeout) { clearTimeout(sendTimeout); sendTimeout = null; }
  if (reinitTimeout) { clearTimeout(reinitTimeout); reinitTimeout = null; }

  // Clean up any existing client (with timeout — destroy can hang on dead browsers)
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
      // Kill any zombie Chromium processes left by the dead browser
      try {
        const browser = oldClient.pupBrowser;
        if (browser && browser.process()) {
          browser.process().kill('SIGKILL');
          logEvent('info', 'WA killed zombie browser process');
        }
      } catch (_) {}
    }
  }

  // Remove stale browser lock file (prevents "already running" errors)
  try {
    const authPath = require('path').resolve('.wwebjs_auth/session');
    const lockFile = require('path').join(authPath, 'SingletonLock');
    try { require('fs').unlinkSync(lockFile); } catch (_) {}
  } catch (_) {}

  connectionStatus = 'disconnected';
  lastQrDataUrl = null;

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000,
    webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/nicoverali/nicoverali.github.io/refs/heads/master/nicoverali/nicoverali.github.io/main/AltWebVersion' },
    puppeteer: {
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--single-process',
      ],
    },
  });

  // --- QR Code ---
  client.on('qr', async (qr) => {
    try {
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
      connectionStatus = 'qr';
      lastQrDataUrl = qrDataUrl;
      emitWA('wa_connection', { status: 'qr', qrDataUrl });
      logEvent('info', 'WA QR code generated — waiting for scan');
    } catch (err) {
      logEvent('error', 'WA QR generation error: ' + err.message);
    }
  });

  // --- Authenticated ---
  client.on('authenticated', () => {
    connectionStatus = 'authenticated';
    lastQrDataUrl = null;
    emitWA('wa_connection', { status: 'authenticated' });
    logEvent('info', 'WA client authenticated');
  });

  // --- Ready ---
  client.on('ready', () => {
    connectionStatus = 'ready';
    reconnectAttempts = 0;
    emitWA('wa_connection', { status: 'ready' });
    logEvent('info', 'WA client ready and connected');

    // Start keepalive — check connection every 3 minutes
    // Only reconnect after 2 consecutive failures (avoids false positives)
    let keepaliveFailCount = 0;
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    keepaliveInterval = setInterval(async () => {
      if (connectionStatus !== 'ready' || !client) return;
      try {
        const state = await client.getState();
        if (state === 'CONNECTED') {
          keepaliveFailCount = 0; // healthy
        } else {
          keepaliveFailCount++;
          logEvent('warn', 'WA keepalive: state is ' + state + ' (fail ' + keepaliveFailCount + '/2)');
          if (keepaliveFailCount >= 2) {
            logEvent('warn', 'WA keepalive: confirmed disconnected, reconnecting');
            connectionStatus = 'disconnected';
            emitWA('wa_connection', { status: 'disconnected', reason: 'keepalive_stale' });
            clearInterval(keepaliveInterval);
            keepaliveFailCount = 0;
            initialize().catch(e => logEvent('error', 'WA keepalive reconnect failed: ' + e.message));
          }
        }
      } catch (e) {
        keepaliveFailCount++;
        const isTargetClosed = e.message && e.message.includes('Target closed');
        // Target closed = browser is dead, no point waiting for a second failure
        const threshold = isTargetClosed ? 1 : 2;
        logEvent('warn', 'WA keepalive error: ' + e.message + ' (fail ' + keepaliveFailCount + '/' + threshold + ')');
        if (keepaliveFailCount >= threshold) {
          connectionStatus = 'disconnected';
          emitWA('wa_connection', { status: 'disconnected', reason: 'keepalive_error' });
          clearInterval(keepaliveInterval);
          keepaliveInterval = null;
          keepaliveFailCount = 0;
          initialize().catch(err => logEvent('error', 'WA keepalive reconnect failed: ' + err.message));
        }
      }
    }, 3 * 60 * 1000);
  });

  // --- Disconnected ---
  client.on('disconnected', (reason) => {
    connectionStatus = 'disconnected';
    emitWA('wa_connection', { status: 'disconnected', reason });
    logEvent('warn', 'WA client disconnected: ' + reason);

    // Exponential backoff reconnection
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logEvent('error', `WA reconnection abandoned after ${MAX_RECONNECT_ATTEMPTS} attempts — manual restart required`);
      emitWA('wa_connection', { status: 'disconnected', reason: 'max_retries_exceeded' });
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
    emitWA('wa_connection', { status: 'disconnected', reason: 'auth_failure: ' + msg });
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
      emitWA('wa_message', {
        phone, chatName, direction: 'in', text,
        reply: null, timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logEvent('error', 'WA message handler error: ' + err.message);
    }
  });

  // Start the client
  logEvent('info', 'WA client initializing...');
  emitWA('wa_connection', { status: 'authenticating' });
  try {
    await client.initialize();
  } catch (err) {
    logEvent('error', 'WA client.initialize() failed: ' + err.message);
    // Clean up the failed client
    try { if (client) { client.destroy().catch(() => {}); } } catch (_) {}
    client = null;
    connectionStatus = 'disconnected';
    emitWA('wa_connection', { status: 'disconnected', reason: 'init_failed' });
    // Schedule a backoff retry instead of leaving the system dead
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts), 5 * 60 * 1000);
      reconnectAttempts++;
      logEvent('info', `WA init retry ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay / 1000)}s`);
      reinitTimeout = setTimeout(() => {
        initialize().catch(e => logEvent('error', 'WA init retry failed: ' + e.message));
      }, delay);
    } else {
      logEvent('error', `WA initialization abandoned after ${MAX_RECONNECT_ATTEMPTS} attempts`);
    }
    return;
  }

  // Start the send loop
  startSendLoop();
}

// ---------------------------------------------------------------------------
// Logout (clears session, requires new QR scan)
// ---------------------------------------------------------------------------

async function logout() {
  if (reinitTimeout) { clearTimeout(reinitTimeout); reinitTimeout = null; }
  if (keepaliveInterval) { clearInterval(keepaliveInterval); keepaliveInterval = null; }
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
  emitWA('wa_connection', { status: 'disconnected', reason: 'manual_logout' });
}

// ---------------------------------------------------------------------------
// Destroy (for graceful shutdown, does not clear session)
// ---------------------------------------------------------------------------

async function destroy() {
  if (sendTimeout) clearTimeout(sendTimeout);
  if (keepaliveInterval) clearInterval(keepaliveInterval);
  if (reinitTimeout) clearTimeout(reinitTimeout);
  if (client) {
    try { await client.destroy(); } catch (e) { /* ignore */ }
    client = null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// Pacing constants surfaced so the send-queue API can compute ETAs without
// hardcoding the same numbers in two places.
function getPacing() {
  return {
    minGapMs: MIN_GAP_MS,
    maxGapMs: MAX_GAP_MS,
    avgGapMs: Math.round((MIN_GAP_MS + MAX_GAP_MS) / 2),
    typingMinMs: TYPING_MIN_MS,
    typingMaxMs: TYPING_MAX_MS,
    hourlyCap: HOURLY_CAP,
    dailyCap: DAILY_CAP,
    capBackoffMs: CAP_BACKOFF_MS,
  };
}

module.exports = {
  setIO,
  getStatus,
  getQrDataUrl,
  initialize,
  logout,
  destroy,
  isWithinBusinessHours,
  getPacing,
};
