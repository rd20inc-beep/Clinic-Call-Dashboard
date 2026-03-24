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
};
