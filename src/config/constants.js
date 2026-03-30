'use strict';

/**
 * Application-wide timing and sizing constants.
 *
 * Keep all magic numbers here so they can be tuned from one place.
 */

module.exports = Object.freeze({
  /** Number of records per page in paginated API responses. */
  PAGE_SIZE: 10,

  /** A monitor heartbeat older than this (ms) marks the agent as stale / offline. */
  HEARTBEAT_STALE_MS: 90_000,

  /** How often (ms) the server sweeps for stale heartbeats. */
  HEARTBEAT_CHECK_INTERVAL: 15_000,

  /** Grace period after server start (ms) before stale-heartbeat checks kick in. */
  STARTUP_GRACE_MS: 120_000,

  /** How long (ms) an IP → agent mapping is remembered. */
  IP_AGENT_TTL_MS: 300_000,

  /** Generic in-memory cache TTL (ms). */
  CACHE_TTL: 5 * 60 * 1000,

  /** Patient-lookup cache TTL (ms) — slightly longer to reduce API load. */
  PATIENT_CACHE_TTL: 10 * 60 * 1000,

  /** Maximum number of entries kept in the in-memory event log ring buffer. */
  MAX_EVENT_LOG: 50,

  /** De-duplication window (seconds) for repeated incoming-call webhooks. */
  DEDUP_WINDOW_S: 30,

  /** Agent goes idle after this many ms of no activity (2 minutes). */
  IDLE_TIMEOUT_MS: 120_000,

  /** How often (ms) to sweep for idle agents. */
  IDLE_CHECK_INTERVAL: 30_000,

  /** Auto-clear "on call" status after this many ms if no call_ended received (2 minutes). */
  ON_CALL_TIMEOUT_MS: 120_000,
});
