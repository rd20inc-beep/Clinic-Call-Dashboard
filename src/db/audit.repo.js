'use strict';

const { db } = require('./index');

const stmtInsert = db.prepare(
  'INSERT INTO audit_log (action, target, details, performed_by) VALUES (?, ?, ?, ?)'
);

const stmtGetRecent = db.prepare(
  'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?'
);

const stmtGetByTarget = db.prepare(
  'SELECT * FROM audit_log WHERE target = ? ORDER BY created_at DESC LIMIT ?'
);

module.exports = {
  /** Log an admin action. */
  log(action, target, details, performedBy) {
    stmtInsert.run(action, target || null, details || null, performedBy);
  },

  /** Get recent audit entries. */
  getRecent(limit) {
    return stmtGetRecent.all(limit || 50);
  },

  /** Get audit entries for a specific target (e.g. username). */
  getByTarget(target, limit) {
    return stmtGetByTarget.all(target, limit || 20);
  },
};
