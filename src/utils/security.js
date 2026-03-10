'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// timingSafeEqual
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison to prevent timing attacks.
 *
 * Both inputs are converted to UTF-8 Buffers.  If lengths differ the
 * comparison still runs in constant time (we pad the shorter one and always
 * return false).
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  // Lengths must match for crypto.timingSafeEqual; pad the shorter buffer and
  // force a mismatch flag so the result is always false when lengths differ.
  if (bufA.length !== bufB.length) {
    // Compare bufA against itself so the timing is still constant, but always
    // return false.
    const dummy = Buffer.alloc(bufA.length);
    dummy.fill(0);
    crypto.timingSafeEqual(bufA, dummy);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// redactSecret
// ---------------------------------------------------------------------------

/**
 * Redact a secret value for safe logging.
 * Shows the first 4 characters followed by '***'.
 *
 * @param {*} value
 * @returns {string}
 */
function redactSecret(value) {
  if (!value || typeof value !== 'string') return '***';
  if (value.length <= 4) return '***';
  return value.slice(0, 4) + '***';
}

// ---------------------------------------------------------------------------
// sanitizeLogEntry
// ---------------------------------------------------------------------------

/**
 * Make a string safe for logging:
 *  - Truncate to maxLen
 *  - Strip patterns that look like secrets (Bearer tokens, long hex strings,
 *    password fields, API keys)
 *  - Strip control characters except newlines
 *
 * @param {*}      text
 * @param {number} [maxLen=200]
 * @returns {string}
 */
function sanitizeLogEntry(text, maxLen) {
  if (maxLen === undefined) maxLen = 200;
  if (!text) return '';
  var str = typeof text === 'string' ? text : String(text);

  // Truncate
  if (str.length > maxLen) {
    str = str.slice(0, maxLen) + '...[truncated]';
  }

  // Redact Bearer / token patterns
  str = str.replace(/Bearer\s+[A-Za-z0-9\-_.~+/]+=*/gi, 'Bearer ***');

  // Redact anything that looks like a long hex or base64 secret (32+ chars)
  str = str.replace(/[A-Fa-f0-9]{32,}/g, '[REDACTED_HEX]');
  str = str.replace(/[A-Za-z0-9+/]{40,}={0,3}/g, '[REDACTED_B64]');

  // Redact password= or api_key= style key-value pairs
  str = str.replace(
    /(password|passwd|secret|api_key|apikey|token|authorization)\s*[:=]\s*\S+/gi,
    '$1=[REDACTED]'
  );

  // Strip control characters (keep \n, \r, \t)
  str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return str;
}

// ---------------------------------------------------------------------------
// getClientIP
// ---------------------------------------------------------------------------

/**
 * Extract the real client IP from a request, handling:
 *  - ::ffff: IPv4-mapped IPv6 prefix
 *  - x-real-ip header (from reverse proxies like nginx)
 *  - x-forwarded-for header (first IP in the chain)
 *  - Falls back to req.ip / req.socket.remoteAddress
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function getClientIP(req) {
  var ip = '';

  // Prefer x-real-ip (set by trusted reverse proxy)
  var realIp = req.headers['x-real-ip'];
  if (realIp && typeof realIp === 'string') {
    ip = realIp.trim();
  }

  // Fall back to x-forwarded-for (first entry)
  if (!ip) {
    var forwarded = req.headers['x-forwarded-for'];
    if (forwarded && typeof forwarded === 'string') {
      var first = forwarded.split(',')[0];
      if (first) {
        ip = first.trim();
      }
    }
  }

  // Fall back to Express / raw socket
  if (!ip) {
    ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  }

  // Strip IPv4-mapped IPv6 prefix
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  return ip;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  timingSafeEqual,
  redactSecret,
  sanitizeLogEntry,
  getClientIP,
};
