'use strict';

// Load environment variables before anything else
require('dotenv').config();

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

process.on('SIGTERM', async () => {
  logEvent('info', 'Server shutting down (SIGTERM)');
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
    cliniceaService.preloadCaches().catch(() => { /* swallow — preload is best-effort */ });
  }

  // Initial WhatsApp appointment sync after a 10-second warm-up
  if (isClinicaConfigured()) {
    setTimeout(() => {
      syncAppointmentsAndScheduleMessages().catch(() => { /* swallow */ });
    }, 10000);
  }

  // Schedule periodic appointment sync every 30 minutes
  setInterval(() => {
    syncAppointmentsAndScheduleMessages().catch(() => { /* swallow */ });
  }, 30 * 60 * 1000);

  // Initialize WhatsApp Web client (QR code auth)
  initWhatsAppClient().catch((err) => {
    logEvent('error', 'WhatsApp client init failed: ' + err.message);
  });
});
