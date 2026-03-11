'use strict';

/**
 * Lightweight request-payload validators.
 *
 * Every validate* function returns:
 *   { valid: boolean, errors: string[], sanitized: { … } }
 *
 * Sanitised values are always strings (or undefined when the field is optional
 * and absent).  The caller should use the sanitised values rather than the raw
 * body to avoid injection.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ALPHANUMERIC_RE = /^[a-zA-Z0-9]+$/;
const PHONE_CHARS_RE = /[^0-9+\-() .]/g; // strip anything that isn't a phone char
const PHONE_LOOSE_RE = /^[+]?[0-9]{4,20}$/; // cleaned phone: optional +, 4-20 digits

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function clampString(v, maxLen) {
  if (typeof v !== 'string') return '';
  return v.slice(0, maxLen);
}

function isAlphanumeric(v) {
  return typeof v === 'string' && ALPHANUMERIC_RE.test(v);
}

// ---------------------------------------------------------------------------
// validateIncomingCall
// ---------------------------------------------------------------------------

/**
 * Validate the body of an incoming_call webhook.
 *
 * Fields (all optional):
 *  - From:    phone string, max 50 chars
 *  - CallSid: string identifier, max 100 chars
 *  - Agent:   alphanumeric, max 30 chars
 */
function validateIncomingCall(body) {
  const errors = [];
  const sanitized = {};

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Body must be a non-null object'], sanitized };
  }

  // From (optional) — can be a phone number or "contact:Name" for saved contacts
  if (body.From !== undefined && body.From !== null && body.From !== '') {
    const from = clampString(String(body.From), 50);
    if (from.startsWith('contact:')) {
      // Saved contact name — allow as-is (server will look up by name)
      sanitized.From = from;
    } else {
      // Strip non-phone characters for validation only; keep original (clamped) for storage
      const phoneOnly = from.replace(PHONE_CHARS_RE, '');
      if (phoneOnly.length === 0) {
        errors.push('From contains no valid phone characters');
      }
      sanitized.From = from;
    }
  }

  // CallSid (optional)
  if (body.CallSid !== undefined && body.CallSid !== null && body.CallSid !== '') {
    sanitized.CallSid = clampString(String(body.CallSid), 100);
  }

  // Agent (optional)
  if (body.Agent !== undefined && body.Agent !== null && body.Agent !== '') {
    const agent = clampString(String(body.Agent), 30);
    if (!isAlphanumeric(agent)) {
      errors.push('Agent must be alphanumeric');
    } else {
      sanitized.Agent = agent;
    }
  }

  return { valid: errors.length === 0, errors, sanitized };
}

// ---------------------------------------------------------------------------
// validateHeartbeat
// ---------------------------------------------------------------------------

/**
 * Validate the body of a heartbeat request.
 *
 * Fields:
 *  - Agent: optional, alphanumeric, max 30 chars
 */
function validateHeartbeat(body) {
  const errors = [];
  const sanitized = {};

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Body must be a non-null object'], sanitized };
  }

  if (body.Agent !== undefined && body.Agent !== null && body.Agent !== '') {
    const agent = clampString(String(body.Agent), 30);
    if (!isAlphanumeric(agent)) {
      errors.push('Agent must be alphanumeric');
    } else {
      sanitized.Agent = agent;
    }
  }

  return { valid: errors.length === 0, errors, sanitized };
}

// ---------------------------------------------------------------------------
// validateLogin
// ---------------------------------------------------------------------------

/**
 * Validate a login request body.
 *
 * Fields (both required):
 *  - username: alphanumeric, max 30 chars
 *  - password: any string, max 100 chars
 */
function validateLogin(body) {
  const errors = [];
  const sanitized = {};

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Body must be a non-null object'], sanitized };
  }

  // username — required
  if (!isNonEmptyString(body.username)) {
    errors.push('username is required');
  } else {
    const username = clampString(String(body.username).trim(), 30);
    if (!isAlphanumeric(username)) {
      errors.push('username must be alphanumeric');
    } else {
      sanitized.username = username;
    }
  }

  // password — required
  if (!isNonEmptyString(body.password)) {
    errors.push('password is required');
  } else {
    sanitized.password = clampString(String(body.password), 100);
  }

  return { valid: errors.length === 0, errors, sanitized };
}

// ---------------------------------------------------------------------------
// validatePhone
// ---------------------------------------------------------------------------

/**
 * Quick check whether a value looks like a phone number.
 *
 * @param {*} phone
 * @returns {boolean}
 */
function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const cleaned = phone.replace(/[\s\-().]/g, '');
  return PHONE_LOOSE_RE.test(cleaned);
}

// ---------------------------------------------------------------------------
// validateAgentId
// ---------------------------------------------------------------------------

/**
 * Check that a value is a valid agent identifier (alphanumeric, max 30).
 *
 * @param {*} agent
 * @returns {boolean}
 */
function validateAgentId(agent) {
  if (!agent || typeof agent !== 'string') return false;
  if (agent.length > 30) return false;
  return ALPHANUMERIC_RE.test(agent);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  validateIncomingCall,
  validateHeartbeat,
  validateLogin,
  validatePhone,
  validateAgentId,
};
