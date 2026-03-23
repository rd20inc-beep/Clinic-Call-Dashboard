'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const helmet = require('helmet');
const path = require('path');

const { config } = require('./config/env');
const { sessionDb } = require('./db/index');
const { corsMiddleware } = require('./middleware/cors');
const { requireAuth } = require('./middleware/auth');
const { setIO: setLogIO } = require('./services/logging.service');
const { setIO: setAgentIO, startStaleChecker } = require('./services/agentRegistry.service');
const { setIO: setCallRouterIO } = require('./services/callRouter.service');
const { setupSockets } = require('./sockets');

// Import route modules
const authRoutes = require('./routes/auth.routes');
const callRoutes = require('./routes/call.routes');
const heartbeatRoutes = require('./routes/heartbeat.routes');
const installerRoutes = require('./routes/installer.routes');
const cliniceaRoutes = require('./routes/clinicea.routes');
const setupWhatsAppRoutes = require('./routes/whatsapp.routes');
const setupAdminRoutes = require('./routes/admin.routes');

// ---------------------------------------------------------------------------
// Create Express app + HTTP server + Socket.IO
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Wire the Socket.IO instance to every service that emits events
setLogIO(io);
setAgentIO(io);
setCallRouterIO(io);

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

// Trust proxy (number of hops or boolean)
app.set('trust proxy', config.TRUST_PROXY);

// Security headers via helmet.  CSP and cross-origin embedder are disabled
// because the dashboard serves inline scripts and the login page uses inline
// styles.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// CORS — handles preflight OPTIONS and sets headers for allowed origins
app.use(corsMiddleware);

// Body parsing
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Session middleware (shared with Socket.IO)
// ---------------------------------------------------------------------------

const sessionMiddleware = session({
  store: new SqliteStore({
    client: sessionDb,
    expired: { clear: true, intervalMs: 900000 },
  }),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
});

app.use(sessionMiddleware);

// ---------------------------------------------------------------------------
// Socket.IO — session sharing + room-based connection handler
// ---------------------------------------------------------------------------

setupSockets(io, sessionMiddleware);

// ---------------------------------------------------------------------------
// Mount routes (ORDER MATTERS)
// ---------------------------------------------------------------------------

// 1. Auth routes (login / logout / /api/me) — no session required for GET/POST /login
app.use(authRoutes);

// 2. Webhook routes (incoming_call, heartbeat) — authenticated via webhook
//    secret header, NOT via session
app.use(callRoutes);
app.use(heartbeatRoutes);

// 3. Installer routes (monitor script download, extension zip)
app.use(installerRoutes);

// 4. WhatsApp extension routes — uses extension-key auth, must come before
//    the static-files middleware so /api/whatsapp/* is not caught by it
app.use(setupWhatsAppRoutes(io));

// Wire up extension connectivity check for the service (avoids circular require)
const waService = require('./services/whatsapp.service');
waService.setExtensionConnectedCheck(setupWhatsAppRoutes.isExtensionConnected);

// 5. Protected static files — the root and all files under /public require
//    an authenticated session
app.get('/', requireAuth, (req, res, next) => next());
app.use(requireAuth, express.static(path.join(__dirname, '..', 'public')));

// 6. API routes that require an authenticated session
app.use(setupAdminRoutes(io));
app.use(cliniceaRoutes);

// ---------------------------------------------------------------------------
// Start the periodic stale-heartbeat checker
// ---------------------------------------------------------------------------

startStaleChecker();

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { app, server, io };
