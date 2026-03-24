const { getUsers } = require('../config/env');
const bcrypt = require('bcryptjs');

// requireAuth - checks session.loggedIn, redirects to /login or returns 401 for JSON
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  // Return JSON 401 for API calls (detected by Accept header, Content-Type, or /api/ path)
  if (
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) ||
    req.path.startsWith('/api/')
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login');
}

// requireAdmin - checks session.role === 'admin'
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
  // Migration mode - plaintext comparison (log warning)
  if (user.passwordHash === password) {
    console.warn(`[SECURITY] User "${username}" using plaintext password - migrate to bcrypt hash`);
    return true;
  }
  return false;
}

module.exports = { requireAuth, requireAdmin, verifyPassword };
