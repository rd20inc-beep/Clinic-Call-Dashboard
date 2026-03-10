const { config } = require('../config/env');
const { timingSafeEqual, getClientIP } = require('../utils/security');
const { logEvent } = require('../services/logging.service');

function requireWebhookSecret(req, res, next) {
  if (!config.WEBHOOK_SECRET) {
    logEvent('warn', 'Webhook auth skipped — no secret configured');
    return next();
  }

  // Check header first, then body
  const provided = req.headers['x-webhook-secret'] || req.body?.secret;

  if (!provided || !timingSafeEqual(provided, config.WEBHOOK_SECRET)) {
    const ip = getClientIP(req);
    logEvent('error', 'Webhook auth failed', `IP: ${ip}`);
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  next();
}

module.exports = { requireWebhookSecret };
