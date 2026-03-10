// Creates a rate limiter middleware
// Options: { windowMs, max, message, keyFn }
// keyFn defaults to IP-based

function createRateLimiter({ windowMs = 60000, max = 60, message = 'Too many requests', keyFn } = {}) {
  const hits = new Map();

  // Cleanup old entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const [key, data] of hits) {
      if (now - data.start > windowMs) hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : (req.ip || req.connection.remoteAddress);
    const now = Date.now();
    const record = hits.get(key);

    if (!record || now - record.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }

    record.count++;
    if (record.count > max) {
      return res.status(429).json({ error: message });
    }

    next();
  };
}

// Pre-configured limiters
const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 15, message: 'Too many login attempts' });
const heartbeatLimiter = createRateLimiter({ windowMs: 60000, max: 120, message: 'Heartbeat rate limit exceeded' });
const callLimiter = createRateLimiter({ windowMs: 60000, max: 30, message: 'Call rate limit exceeded' });
const apiLimiter = createRateLimiter({ windowMs: 60000, max: 60 });

module.exports = { createRateLimiter, loginLimiter, heartbeatLimiter, callLimiter, apiLimiter };
