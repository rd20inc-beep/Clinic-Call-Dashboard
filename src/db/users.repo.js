'use strict';

const { db } = require('./index');
const bcrypt = require('bcryptjs');

// --- Prepared statements ---

const stmtGetAll = db.prepare(
  'SELECT id, username, display_name, role, active, notes, created_at, updated_at FROM users ORDER BY role ASC, username ASC'
);

const stmtGetByUsername = db.prepare(
  'SELECT * FROM users WHERE username = ?'
);

const stmtInsert = db.prepare(`
  INSERT INTO users (username, password_hash, display_name, role, active, notes)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const stmtUpdate = db.prepare(`
  UPDATE users SET display_name = ?, role = ?, active = ?, notes = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const stmtUpdatePassword = db.prepare(
  "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
);

const stmtDelete = db.prepare(
  'DELETE FROM users WHERE id = ?'
);

const stmtSetActive = db.prepare(
  "UPDATE users SET active = ?, updated_at = datetime('now') WHERE id = ?"
);

const stmtCountAdmins = db.prepare(
  "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND active = 1"
);

module.exports = {
  /** Get all users (without password hashes). */
  getAll() {
    return stmtGetAll.all();
  },

  /** Get a user by username (includes password hash for auth). */
  getByUsername(username) {
    return stmtGetByUsername.get(username) || null;
  },

  /** Create a new user. Returns the new user ID. */
  create(username, password, displayName, role, notes) {
    const hash = bcrypt.hashSync(password, 10);
    const result = stmtInsert.run(
      username,
      hash,
      displayName || null,
      role || 'agent',
      1,
      notes || null
    );
    return result.lastInsertRowid;
  },

  /** Update user details (not password). */
  update(id, displayName, role, active, notes) {
    stmtUpdate.run(displayName || null, role || 'agent', active ? 1 : 0, notes || null, id);
  },

  /** Change a user's password. */
  changePassword(id, newPassword) {
    const hash = bcrypt.hashSync(newPassword, 10);
    stmtUpdatePassword.run(hash, id);
  },

  /** Activate or deactivate a user. */
  setActive(id, active) {
    stmtSetActive.run(active ? 1 : 0, id);
  },

  /** Delete a user permanently. */
  deleteUser(id) {
    stmtDelete.run(id);
  },

  /** Count active admin users in DB. */
  countActiveAdmins() {
    return stmtCountAdmins.get().count;
  },

  /** Check if a username is already taken. */
  usernameExists(username) {
    return !!stmtGetByUsername.get(username);
  },
};
