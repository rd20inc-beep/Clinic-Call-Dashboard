'use strict';

// Load environment variables before anything else
require('dotenv').config();

// Set timezone to Pakistan Standard Time (UTC+5)
process.env.TZ = 'Asia/Karachi';

const { app, server, io } = require('./app');
const { config, isClinicaConfigured } = require('./config/env');
const { logEvent } = require('./services/logging.service');
const {
  syncAppointmentsAndScheduleMessages,
  setClinicaService,
} = require('./services/whatsapp.service');
const { initialize: initWhatsAppClient, destroy: destroyWAClient } = require('./services/whatsappClient.service');

// ---------------------------------------------------------------------------
// Wire Clinicea service into WhatsApp service (avoids circular dependency)
// ---------------------------------------------------------------------------

let cliniceaService = null;
try {
  cliniceaService = require('./services/clinicea.service');
} catch (e) {
  // clinicea.service.js may not be available yet — handle gracefully
}

if (cliniceaService && typeof setClinicaService === 'function') {
  setClinicaService(cliniceaService);
}

// ---------------------------------------------------------------------------
// Process stability handlers — keep the server alive on stray errors
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  try { logEvent('error', 'Uncaught exception: ' + err.message); } catch (e) { /* noop */ }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[FATAL] Unhandled rejection:', msg);
  try { logEvent('error', 'Unhandled rejection: ' + msg); } catch (e) { /* noop */ }
});

// Track interval handles for clean shutdown
const intervals = [];

process.on('SIGTERM', async () => {
  logEvent('info', 'Server shutting down (SIGTERM)');
  // Clear all intervals to allow clean exit
  for (const id of intervals) clearInterval(id);
  await destroyWAClient().catch(() => {});
  process.exit(0);
});

process.on('SIGINT', async () => {
  logEvent('info', 'Server shutting down (SIGINT)');
  for (const id of intervals) clearInterval(id);
  await destroyWAClient().catch(() => {});
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Start the HTTP server
// ---------------------------------------------------------------------------

const PORT = config.PORT;

server.listen(PORT, () => {
  logEvent('info', 'Server started on port ' + PORT);
  logEvent('info', 'Clinicea API: ' + (isClinicaConfigured() ? 'Configured' : 'Not configured'));

  // Preload Clinicea caches (today's appointments + full patient list)
  if (isClinicaConfigured() && cliniceaService && typeof cliniceaService.preloadCaches === 'function') {
    cliniceaService.preloadCaches().catch((e) => {
      logEvent('warn', 'Clinicea cache preload failed — starting without cache', e.message);
    });
  }

  // Initial WhatsApp appointment sync after a 10-second warm-up
  if (isClinicaConfigured()) {
    setTimeout(() => {
      syncAppointmentsAndScheduleMessages().catch((e) => {
        logEvent('error', 'Initial appointment sync failed', e.message);
      });
    }, 10000);
  }

  // Schedule periodic appointment sync every 30 minutes
  intervals.push(setInterval(() => {
    syncAppointmentsAndScheduleMessages().catch((e) => {
      logEvent('error', 'Periodic appointment sync failed', e.message);
    });
  }, 30 * 60 * 1000));

  // Auto-finalize stale unknown calls + auto-resolve callbacks every 2 minutes
  intervals.push(setInterval(() => {
    try {
      const callsRepo = require('./db/calls.repo');
      callsRepo.finalizeStale();
    } catch (e) { /* ignore */ }
    try {
      const cbRepo = require('./db/callbacks.repo');
      cbRepo.autoResolvePending();
    } catch (e) { /* ignore */ }
  }, 2 * 60 * 1000));

  // Initialize WhatsApp Web client (QR code auth)
  initWhatsAppClient().catch((err) => {
    logEvent('error', 'WhatsApp client init failed: ' + err.message);
  });

  // Midnight cleanup: clear stale pending/expired messages every hour,
  // full cleanup at midnight PKT (UTC+5 → 19:00 UTC)
  intervals.push(setInterval(() => {
    try {
      const pkHour = (new Date().getUTCHours() + 5) % 24;
      if (pkHour === 0) {
        const { db } = require('./db/index');
        // Clear all pending (unapproved) messages from previous days
        const cleared = db.prepare(
          "DELETE FROM wa_messages WHERE status = 'pending' AND date(created_at) < date('now')"
        ).run();
        // Also clear expired messages
        const expired = db.prepare(
          "DELETE FROM wa_messages WHERE status = 'expired' AND date(created_at) < date('now')"
        ).run();
        if (cleared.changes > 0 || expired.changes > 0) {
          logEvent('info', `Midnight cleanup: cleared ${cleared.changes} pending + ${expired.changes} expired messages`);
        }
      }
    } catch (e) { console.error('[cleanup] Midnight cleanup failed:', e.message); }
  }, 60 * 60 * 1000)); // check every hour
});
