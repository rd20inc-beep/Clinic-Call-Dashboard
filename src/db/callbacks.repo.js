'use strict';

const { db } = require('./index');

// --- Prepared statements ---

const stmtInsert = db.prepare(`
  INSERT INTO callbacks (call_id, caller_number, patient_name, original_agent, callback_status, call_time)
  VALUES (?, ?, ?, ?, 'pending', ?)
`);

const stmtExistsForCall = db.prepare(
  'SELECT id FROM callbacks WHERE call_id = ? LIMIT 1'
);

const stmtExistsForNumber = db.prepare(
  "SELECT id FROM callbacks WHERE caller_number = ? AND callback_status IN ('pending', 'assigned') LIMIT 1"
);

const stmtGetAll = db.prepare(
  'SELECT * FROM callbacks ORDER BY created_at DESC LIMIT ? OFFSET ?'
);

const stmtGetByStatus = db.prepare(
  'SELECT * FROM callbacks WHERE callback_status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
);

const stmtGetOverdue = db.prepare(
  "SELECT * FROM callbacks WHERE callback_status IN ('pending', 'assigned') AND created_at < datetime('now', '-2 hours') ORDER BY created_at ASC LIMIT ? OFFSET ?"
);

const stmtCountAll = db.prepare('SELECT COUNT(*) as c FROM callbacks');
const stmtCountByStatus = db.prepare('SELECT COUNT(*) as c FROM callbacks WHERE callback_status = ?');
const stmtCountOverdue = db.prepare("SELECT COUNT(*) as c FROM callbacks WHERE callback_status IN ('pending', 'assigned') AND created_at < datetime('now', '-2 hours')");

const stmtUpdateStatus = db.prepare(
  "UPDATE callbacks SET callback_status = ?, callback_attempts = callback_attempts + 1, last_attempt_at = datetime('now') WHERE id = ?"
);

const stmtResolve = db.prepare(
  "UPDATE callbacks SET callback_status = ?, resolved_at = datetime('now'), last_attempt_at = datetime('now') WHERE id = ?"
);

const stmtAssign = db.prepare(
  "UPDATE callbacks SET assigned_agent = ?, callback_status = 'assigned' WHERE id = ?"
);

const stmtSummary = db.prepare(`
  SELECT
    SUM(CASE WHEN callback_status = 'pending' THEN 1 ELSE 0 END) as pending,
    SUM(CASE WHEN callback_status = 'assigned' THEN 1 ELSE 0 END) as assigned,
    SUM(CASE WHEN callback_status IN ('pending','assigned') AND created_at < datetime('now','-2 hours') THEN 1 ELSE 0 END) as overdue,
    SUM(CASE WHEN callback_status IN ('called_back','resolved') THEN 1 ELSE 0 END) as resolved,
    COUNT(*) as total
  FROM callbacks
`);

module.exports = {
  /** Create a callback from a missed call. Skips if already exists for this call or number. */
  createFromMissedCall(callId, callerNumber, patientName, agent, callTime) {
    // Skip invalid numbers (WhatsApp contacts, Unknown, Anonymous)
    if (!this.isValidCallbackNumber(callerNumber)) return null;
    // Don't create duplicate
    if (callId && stmtExistsForCall.get(callId)) return null;
    if (callerNumber && stmtExistsForNumber.get(callerNumber)) return null;
    const result = stmtInsert.run(callId || null, callerNumber, patientName || null, agent || null, callTime || new Date().toISOString());
    return result.lastInsertRowid;
  },

  /** Get callbacks with optional status filter and pagination. */
  getCallbacks({ status, overdue, page = 1, limit = 25 } = {}) {
    const offset = (page - 1) * limit;
    let rows, total;

    if (overdue) {
      rows = stmtGetOverdue.all(limit, offset);
      total = stmtCountOverdue.get().c;
    } else if (status) {
      rows = stmtGetByStatus.all(status, limit, offset);
      total = stmtCountByStatus.get(status).c;
    } else {
      rows = stmtGetAll.all(limit, offset);
      total = stmtCountAll.get().c;
    }

    return { callbacks: rows, total, page, totalPages: Math.ceil(total / limit) || 1 };
  },

  /** Get summary counts. */
  getSummary() {
    const row = stmtSummary.get();
    const total = row.total || 0;
    const resolved = row.resolved || 0;
    return {
      pending: row.pending || 0,
      assigned: row.assigned || 0,
      overdue: row.overdue || 0,
      resolved,
      total,
      recovery_rate: total > 0 ? Math.round((resolved / total) * 100) : 0,
    };
  },

  /** Update callback status. */
  updateStatus(id, status) {
    if (status === 'resolved' || status === 'no_callback_needed' || status === 'called_back') {
      stmtResolve.run(status, id);
    } else {
      stmtUpdateStatus.run(status, id);
    }
  },

  /** Assign a callback to an agent. */
  assign(id, agent) {
    stmtAssign.run(agent, id);
  },

  /** Update callback notes. */
  updateNotes(id, notes) {
    db.prepare("UPDATE callbacks SET callback_notes = ? WHERE id = ?").run(notes, id);
  },

  /** Bulk dismiss all pending/overdue callbacks. */
  dismissAllPending() {
    return db.prepare("UPDATE callbacks SET callback_status = 'no_callback_needed', resolved_at = datetime('now') WHERE callback_status IN ('pending', 'assigned')").run().changes;
  },

  /** Bulk dismiss callbacks older than X days. */
  dismissOlderThan(days) {
    return db.prepare("UPDATE callbacks SET callback_status = 'no_callback_needed', resolved_at = datetime('now') WHERE callback_status IN ('pending', 'assigned') AND created_at < datetime('now', '-' || ? || ' days')").run(days).changes;
  },

  /**
   * Auto-resolve pending callbacks where the patient has been contacted since.
   * Checks: outbound call made, inbound call answered, or appointment booked.
   * Returns count of resolved callbacks.
   */
  autoResolvePending() {
    const pending = db.prepare(
      "SELECT id, caller_number, call_time FROM callbacks WHERE callback_status IN ('pending', 'assigned')"
    ).all();

    if (pending.length === 0) return 0;

    let resolved = 0;
    for (const cb of pending) {
      const phone = (cb.caller_number || '').replace(/[\s\-()]/g, '');
      if (!phone || phone.length < 7) continue;
      const phoneSuffix = '%' + phone.slice(-10) + '%';

      // Check 1: outbound call made to this number after the missed call
      const outbound = db.prepare(
        "SELECT id FROM calls WHERE caller_number LIKE ? AND direction = 'outbound' AND timestamp > ? LIMIT 1"
      ).get(phoneSuffix, cb.call_time);

      // Check 2: inbound call answered from this number after the missed call
      const answered = db.prepare(
        "SELECT id FROM calls WHERE caller_number LIKE ? AND call_status = 'answered' AND timestamp > ? LIMIT 1"
      ).get(phoneSuffix, cb.call_time);

      // Check 3: appointment booked for this phone after the missed call
      const appointment = db.prepare(
        "SELECT id FROM wa_appointment_tracking WHERE patient_phone LIKE ? AND created_at > ? LIMIT 1"
      ).get(phoneSuffix, cb.call_time);

      if (outbound || answered || appointment) {
        const reason = outbound ? 'called_back' : answered ? 'resolved' : 'resolved';
        db.prepare(
          "UPDATE callbacks SET callback_status = ?, resolved_at = datetime('now'), callback_notes = COALESCE(callback_notes || ' | ', '') || ? WHERE id = ?"
        ).run(reason, 'Auto-resolved: ' + (outbound ? 'outbound call made' : answered ? 'call answered' : 'appointment booked'), cb.id);
        resolved++;
      }
    }
    return resolved;
  },

  /** Don't create callbacks for WhatsApp contact names (not real phone numbers). */
  isValidCallbackNumber(number) {
    if (!number) return false;
    if (number.startsWith('whatsapp:')) return false;
    if (number === 'Unknown' || number === 'Anonymous') return false;
    return true;
  },
};
