'use strict';

const path = require('path');

// Load .env from project root
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLINICEA_DOMAIN_ALLOWLIST = [
  'app.clinicea.com',
  'api.clinicea.com',
  'staging.clinicea.com',
  'demo.clinicea.com',
];

function validateClinicaUrl(url) {
  if (!url) return true; // will use default
  try {
    const parsed = new URL(url);
    return CLINICEA_DOMAIN_ALLOWLIST.some(
      (domain) => parsed.hostname === domain || parsed.hostname.endsWith('.' + domain)
    );
  } catch {
    return false;
  }
}

function requiredOrExit(name) {
  const val = process.env[name];
  if (!val || !val.trim()) {
    console.error(`FATAL: Required environment variable ${name} is not set. Exiting.`);
    process.exit(1);
  }
  return val.trim();
}

function optional(name, fallback) {
  const val = process.env[name];
  return val && val.trim() ? val.trim() : fallback;
}

function optionalInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Clinicea base URL validation
// ---------------------------------------------------------------------------

const rawClinicaBaseUrl = optional(
  'CLINICEA_BASE_URL',
  'https://app.clinicea.com/clinic.aspx'
);

if (!validateClinicaUrl(rawClinicaBaseUrl)) {
  console.error(
    `FATAL: CLINICEA_BASE_URL "${rawClinicaBaseUrl}" is not on the allowed domain list: ${CLINICEA_DOMAIN_ALLOWLIST.join(', ')}. Exiting.`
  );
  process.exit(1);
}

const rawClinicaApiBase = optional('CLINICEA_API_BASE', 'https://api.clinicea.com');

if (!validateClinicaUrl(rawClinicaApiBase)) {
  console.error(
    `FATAL: CLINICEA_API_BASE "${rawClinicaApiBase}" is not on the allowed domain list: ${CLINICEA_DOMAIN_ALLOWLIST.join(', ')}. Exiting.`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Required secrets
// ---------------------------------------------------------------------------

const SESSION_SECRET = requiredOrExit('SESSION_SECRET');
const WEBHOOK_SECRET = requiredOrExit('WEBHOOK_SECRET');

// ---------------------------------------------------------------------------
// CORS origins
// ---------------------------------------------------------------------------

function parseCorsList(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Exported config object
// ---------------------------------------------------------------------------

const config = Object.freeze({
  PORT: optionalInt('PORT', 3000),
  DOCTOR_PHONE: optional('DOCTOR_PHONE', ''),

  // Clinicea
  CLINICEA_BASE_URL: rawClinicaBaseUrl,
  CLINICEA_API_BASE: rawClinicaApiBase,
  CLINICEA_API_KEY: optional('CLINICEA_API_KEY', ''),
  CLINICEA_STAFF_USERNAME: optional('CLINICEA_STAFF_USERNAME', ''),
  CLINICEA_STAFF_PASSWORD: optional('CLINICEA_STAFF_PASSWORD', ''),

  // Secrets
  SESSION_SECRET,
  WEBHOOK_SECRET,

  // Optional keys
  GROQ_API_KEY: optional('GROQ_API_KEY', ''),
  EXTENSION_SECRET: optional('EXTENSION_SECRET', ''),
  MONITOR_URL: optional('MONITOR_URL', ''),

  // CORS
  ALLOWED_CORS_ORIGINS: parseCorsList(process.env.ALLOWED_CORS_ORIGINS),

  // Proxy
  TRUST_PROXY: optionalInt('TRUST_PROXY', 1),
});

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

const AGENT_NAMES = ['agent1', 'agent2', 'agent3', 'agent4', 'agent5'];
const ALL_USERS = ['admin', ...AGENT_NAMES];

/**
 * Build the user map from environment variables.
 *
 * Primary mode: USER_ADMIN_HASH, USER_AGENT1_HASH, etc. contain bcrypt hashes.
 * Migration mode: USER_ADMIN_PASS, USER_AGENT1_PASS contain plaintext passwords.
 *   - In migration mode a warning is logged so the operator knows to switch.
 *   - Plaintext passwords are stored as-is (the auth layer must handle compare
 *     differently based on whether the value looks like a bcrypt hash).
 *
 * Returns: { username: { passwordHash: string, role: 'admin'|'agent', isMigration: boolean } }
 */
function getUsers() {
  const users = {};

  // 1. PRIMARY: Load from database (all agents are DB-driven after migration)
  try {
    const usersRepo = require('../db/users.repo');
    const dbUsers = usersRepo.getAll();
    for (const u of dbUsers) {
      if (!u.active) continue; // skip deactivated users
      const full = usersRepo.getByUsername(u.username);
      users[u.username] = {
        passwordHash: full ? full.password_hash : '',
        role: u.role || 'agent',
        displayName: u.display_name,
        status: u.status || 'offline',
        lastLogin: u.last_login,
        lastSeen: u.last_seen,
        isMigration: false,
        source: 'db',
        dbId: u.id,
      };
    }
  } catch (e) {
    // DB not available yet during early init — fall through to env
  }

  // 2. FALLBACK: Load from env vars (only if DB is empty / first boot)
  if (Object.keys(users).length === 0) {
    for (const name of ALL_USERS) {
      const envKey = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      const hashVar = `USER_${envKey}_HASH`;
      const passVar = `USER_${envKey}_PASS`;
      const hash = process.env[hashVar] && process.env[hashVar].trim();
      const pass = process.env[passVar] && process.env[passVar].trim();

      if (hash) {
        users[name] = { passwordHash: hash, role: name === 'admin' ? 'admin' : 'agent', isMigration: false, source: 'env' };
      } else if (pass) {
        users[name] = { passwordHash: pass, role: name === 'admin' ? 'admin' : 'agent', isMigration: true, source: 'env' };
      }
    }
  }

  // 3. Last resort defaults if nothing configured anywhere
  if (Object.keys(users).length === 0) {
    console.warn('[env] WARNING: No users configured. Using built-in defaults.');
    const defaults = {
      admin: 'clinicea2025',
      agent1: 'password1',
      agent2: 'password2',
      agent3: 'password3',
      agent4: 'password4',
      agent5: 'password5',
    };
    for (const [name, pass] of Object.entries(defaults)) {
      users[name] = {
        passwordHash: pass,
        role: name === 'admin' ? 'admin' : 'agent',
        isMigration: true,
      };
    }
  }

  return users;
}

// ---------------------------------------------------------------------------
// Monitor tokens
// ---------------------------------------------------------------------------

/**
 * Returns a map { agent: token } for per-agent monitor authentication tokens.
 * Environment variable pattern: MONITOR_TOKEN_AGENT1, MONITOR_TOKEN_AGENT2, …
 */
function getMonitorTokens() {
  const tokens = {};

  for (const agent of AGENT_NAMES) {
    const envKey = `MONITOR_TOKEN_${agent.toUpperCase()}`;
    const val = process.env[envKey] && process.env[envKey].trim();
    if (val) {
      tokens[agent] = val;
    }
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Feature detection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the minimum Clinicea API credentials are present.
 */
function isClinicaConfigured() {
  return !!(
    config.CLINICEA_API_KEY &&
    config.CLINICEA_STAFF_USERNAME &&
    config.CLINICEA_STAFF_PASSWORD
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  config,
  getUsers,
  getMonitorTokens,
  isClinicaConfigured,
};
