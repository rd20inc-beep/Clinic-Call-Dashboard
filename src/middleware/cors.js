const { config } = require('../config/env');

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();

  // Check against explicit allowed origins from env
  const allowedOrigins = config.ALLOWED_CORS_ORIGINS || [];

  const isAllowed = allowedOrigins.some(allowed => {
    if (origin === allowed) return true;
    // Support wildcard patterns like chrome-extension://SPECIFIC_ID
    if (allowed.endsWith('*') && origin.startsWith(allowed.slice(0, -1))) return true;
    return false;
  });

  if (isAllowed) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Credentials', 'true');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
}

module.exports = { corsMiddleware };
