const { getUsers } = require('../config/env');
const bcrypt = require('bcryptjs');

// Resolve agent from mobile app bearer token (lazy-loaded to avoid circular deps)
function resolveFromBearerToken(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const mobileRoutes = require('../routes/mobileApp.routes');
    const appTokens = mobileRoutes.appTokens;
    if (!appTokens) return null;
    const entry = appTokens.get(token);
    if (!entry) return null;
    // Check TTL (7 days)
    if (Date.now() - entry.loginAt > 7 * 24 * 60 * 60 * 1000) {
      appTokens.delete(token);
      return null;
    }
    return entry;
  } catch (e) { return null; }
}

// requireAuth - checks session.loggedIn OR valid bearer token
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();

  // Try bearer token (mobile app)
  const tokenEntry = resolveFromBearerToken(req);
  if (tokenEntry) {
    // Populate session-like properties so downstream code works
    req.session = req.session || {};
    req.session.loggedIn = true;
    req.session.username = tokenEntry.agent;
    req.session.role = tokenEntry.role || 'agent';
    return next();
  }

  if (
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) ||
    req.path.startsWith('/api/')
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login');
}

// requireAdmin - checks session.role === 'admin' (works with both session and bearer token)
function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin only' });
}

// verifyPassword - compares password against stored hash or plaintext (migration mode)
// Returns boolean. If the user entry has a bcrypt hash (starts with $2), use bcrypt.compareSync
// Otherwise do a plain comparison (migration mode - log a warning)
async function verifyPassword(username, password) {
  const users = getUsers();
  const user = users[username];
  if (!user) return false;

  if (user.passwordHash && user.passwordHash.startsWith('$2')) {
    return bcrypt.compareSync(password, user.passwordHash);
  }
  // Migration mode - plaintext comparison, auto-hash to bcrypt
  if (user.passwordHash === password) {
    // Auto-migrate: hash the password and save it
    try {
      const usersRepo = require('../db/users.repo');
      const dbUser = usersRepo.getByUsername(username);
      if (dbUser) {
        usersRepo.changePassword(dbUser.id, password);
        console.log(`[SECURITY] Auto-migrated "${username}" from plaintext to bcrypt`);
      }
    } catch (e) { console.error('[auth] Bcrypt migration failed for ' + username + ':', e.message); }
    return true;
  }
  return false;
}

// requireAdminOrDoctor - allows admin or doctor role
function requireAdminOrDoctor(req, res, next) {
  if (req.session && (req.session.role === 'admin' || req.session.role === 'doctor')) return next();
  return res.status(403).json({ error: 'Admin or Doctor only' });
}

module.exports = { requireAuth, requireAdmin, requireAdminOrDoctor, verifyPassword };
