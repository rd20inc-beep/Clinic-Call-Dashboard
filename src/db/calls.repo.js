'use strict';

const { db } = require('./index');

// --- Prepared statements ---

// Ensure direction/call_status/duration columns exist
try { db.exec("ALTER TABLE calls ADD COLUMN direction TEXT DEFAULT 'inbound'"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE calls ADD COLUMN call_status TEXT DEFAULT 'unknown'"); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN duration INTEGER DEFAULT NULL'); } catch (e) { /* exists */ }

const stmtInsertCall = db.prepare(`
  INSERT INTO calls (caller_number, call_sid, clinicea_url, agent, routing_method, source_ip, direction, call_status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtUpdateCallStatus = db.prepare(
  'UPDATE calls SET call_status = ? WHERE id = ?'
);

const stmtUpdateCallDuration = db.prepare(
  'UPDATE calls SET duration = ?, call_status = ? WHERE id = ?'
);

const stmtUpdatePatientName = db.prepare(
  'UPDATE calls SET patient_name = ? WHERE id = ?'
);

const stmtUpdatePatientId = db.prepare(
  'UPDATE calls SET patient_id = ? WHERE id = ?'
);

// Counts
const stmtCountAll = db.prepare('SELECT COUNT(*) AS total FROM calls');
const stmtCountByAgent = db.prepare(
  'SELECT COUNT(*) AS total FROM calls WHERE agent = ?'
);

// Paginated selects
const stmtSelectAll = db.prepare(
  'SELECT * FROM calls ORDER BY timestamp DESC LIMIT ? OFFSET ?'
);
const stmtSelectByAgent = db.prepare(
  'SELECT * FROM calls WHERE agent = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
);

// ---------------------------------------------------------------------------
// Finalized call filter:
//   call_status IN ('answered','missed','rejected','completed','failed','cancelled')
//   OR (call_status = 'unknown' AND timestamp < datetime('now', '-5 minutes'))
// This excludes calls still ringing (< 5 min old with unknown status)
// ---------------------------------------------------------------------------
const FINALIZED_WHERE = "(call_status IN ('answered','missed','rejected','completed','failed','cancelled') OR (call_status = 'unknown' AND timestamp < datetime('now', '-5 minutes')))";

// Per-agent performance aggregation — parameterized by date filter
function buildPerfQuery(dateFilter) {
  const dateWhere = dateFilter ? ' AND ' + dateFilter : '';
  return db.prepare(`
    SELECT
      agent,
      COUNT(*) as total_calls,
      SUM(CASE WHEN call_status = 'answered' THEN 1 ELSE 0 END) as answered_calls,
      SUM(CASE WHEN call_status = 'missed' THEN 1 ELSE 0 END) as missed_calls,
      COALESCE(SUM(CASE WHEN duration IS NOT NULL THEN duration ELSE 0 END), 0) as total_talk_time,
      COALESCE(AVG(CASE WHEN duration IS NOT NULL AND duration > 0 THEN duration END), 0) as avg_duration,
      COALESCE(MAX(duration), 0) as longest_call,
      MAX(timestamp) as last_call_at
    FROM calls
    WHERE agent IS NOT NULL AND ${FINALIZED_WHERE}${dateWhere}
    GROUP BY agent
    ORDER BY total_calls DESC
  `);
}

const stmtPerfToday = buildPerfQuery("date(timestamp) = date('now')");
const stmtPerfWeek = buildPerfQuery("timestamp >= datetime('now', '-7 days')");
const stmtPerfMonth = buildPerfQuery("timestamp >= datetime('now', '-30 days')");
const stmtPerfAll = buildPerfQuery('');

// Single agent performance with custom date range
const stmtPerfAgentRange = db.prepare(`
  SELECT
    COUNT(*) as total_calls,
    SUM(CASE WHEN call_status = 'answered' THEN 1 ELSE 0 END) as answered_calls,
    SUM(CASE WHEN call_status = 'missed' THEN 1 ELSE 0 END) as missed_calls,
    COALESCE(SUM(CASE WHEN duration IS NOT NULL THEN duration ELSE 0 END), 0) as total_talk_time,
    COALESCE(AVG(CASE WHEN duration IS NOT NULL AND duration > 0 THEN duration END), 0) as avg_duration,
    COALESCE(MAX(duration), 0) as longest_call,
    MAX(timestamp) as last_call_at
  FROM calls
  WHERE agent = ? AND ${FINALIZED_WHERE} AND timestamp >= ? AND timestamp <= ?
`);

// Hourly breakdown for an agent
const stmtAgentHourly = db.prepare(`
  SELECT
    CAST(strftime('%H', timestamp) AS INTEGER) as hour,
    COUNT(*) as calls,
    COALESCE(SUM(CASE WHEN duration IS NOT NULL THEN duration ELSE 0 END), 0) as talk_time
  FROM calls
  WHERE agent = ? AND ${FINALIZED_WHERE} AND date(timestamp) = date('now')
  GROUP BY hour ORDER BY hour
`);

// Auto-finalize stale unknown calls (older than 5 minutes, still unknown → missed)
const stmtFinalizeStale = db.prepare(`
  UPDATE calls SET call_status = 'missed'
  WHERE call_status = 'unknown' AND timestamp < datetime('now', '-5 minutes')
`);

const DEFAULT_PAGE_SIZE = 10;

module.exports = {
  /**
   * Insert a new call record.
   * @returns {{ callId: number }}
   */
  insertCall(callerNumber, callSid, cliniceaUrl, agent, routingMethod, sourceIp, direction, callStatus) {
    const result = stmtInsertCall.run(
      callerNumber,
      callSid || null,
      cliniceaUrl || null,
      agent || null,
      routingMethod || null,
      sourceIp || null,
      direction || 'inbound',
      callStatus || 'unknown'
    );
    return { callId: result.lastInsertRowid };
  },

  /**
   * Update call status.
   */
  updateCallStatus(callId, status) {
    stmtUpdateCallStatus.run(status, callId);
  },

  /**
   * Update call duration and mark as answered.
   */
  updateCallDuration(callId, duration) {
    stmtUpdateCallDuration.run(duration, 'answered', callId);
  },

  /**
   * Update the patient name for a call.
   */
  updatePatientName(callId, name) {
    stmtUpdatePatientName.run(name, callId);
  },

  /**
   * Update the patient ID for a call.
   */
  updatePatientId(callId, patientId) {
    stmtUpdatePatientId.run(patientId, callId);
  },

  /**
   * Retrieve paginated call history.
   * @param {{ page?: number, limit?: number, agent?: string, isAdmin?: boolean }} opts
   * @returns {{ calls: object[], total: number, page: number, totalPages: number }}
   */
  getCalls({ page = 1, limit = DEFAULT_PAGE_SIZE, agent, isAdmin = false } = {}) {
    page = Math.max(1, parseInt(page, 10) || 1);
    limit = Math.min(100, Math.max(1, parseInt(limit, 10) || DEFAULT_PAGE_SIZE));
    const offset = (page - 1) * limit;

    let total, calls;

    if (isAdmin) {
      total = stmtCountAll.get().total;
      calls = stmtSelectAll.all(limit, offset);
    } else {
      total = stmtCountByAgent.get(agent).total;
      calls = stmtSelectByAgent.all(agent, limit, offset);
    }

    return {
      calls,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
    };
  },

  // ---------------------------------------------------------------------------
  // Performance analytics (SQL-driven, not frontend guesses)
  // ---------------------------------------------------------------------------

  /** Auto-finalize stale unknown calls as missed. Returns count finalized. */
  finalizeStale() {
    return stmtFinalizeStale.run().changes;
  },

  /** Get per-agent performance for today. */
  getPerformanceToday() {
    return stmtPerfToday.all();
  },

  /** Get per-agent performance for this week. */
  getPerformanceWeek() {
    return stmtPerfWeek.all();
  },

  /** Get per-agent performance for this month (30 days). */
  getPerformanceMonth() {
    return stmtPerfMonth.all();
  },

  /** Get per-agent performance for all time. */
  getPerformanceAll() {
    return stmtPerfAll.all();
  },

  /** Get performance for a single agent within a date range. */
  getAgentPerformanceRange(agent, from, to) {
    return stmtPerfAgentRange.get(agent, from, to);
  },

  /** Get hourly call + talk time breakdown for an agent today. */
  getAgentHourlyToday(agent) {
    return stmtAgentHourly.all(agent);
  },
};
