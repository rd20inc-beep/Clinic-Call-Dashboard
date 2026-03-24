'use strict';

const { db } = require('./index');
const bcrypt = require('bcryptjs');

// --- Prepared statements ---

const stmtGetAll = db.prepare(
  'SELECT id, username, display_name, role, active, status, notes, last_login, last_seen, created_at, updated_at FROM users WHERE deleted_at IS NULL ORDER BY role ASC, username ASC'
);

const stmtGetAllIncludeDeleted = db.prepare(
  'SELECT id, username, display_name, role, active, notes, created_at, updated_at, deleted_at FROM users ORDER BY deleted_at DESC, role ASC, username ASC'
);

const stmtGetByUsername = db.prepare(
  'SELECT * FROM users WHERE username = ? AND deleted_at IS NULL'
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

const stmtSoftDelete = db.prepare(
  "UPDATE users SET deleted_at = datetime('now'), active = 0 WHERE id = ?"
);

const stmtRestore = db.prepare(
  "UPDATE users SET deleted_at = NULL, active = 1, updated_at = datetime('now') WHERE id = ?"
);

const stmtHardDelete = db.prepare(
  'DELETE FROM users WHERE id = ?'
);

const stmtSetActive = db.prepare(
  "UPDATE users SET active = ?, updated_at = datetime('now') WHERE id = ?"
);

const stmtUpdateLastLogin = db.prepare(
  "UPDATE users SET last_login = datetime('now'), last_seen = datetime('now'), status = 'online' WHERE username = ?"
);

const stmtUpdateLastSeen = db.prepare(
  "UPDATE users SET last_seen = datetime('now') WHERE username = ?"
);

const stmtSetStatus = db.prepare(
  "UPDATE users SET status = ? WHERE username = ?"
);

const stmtGetById = db.prepare(
  'SELECT * FROM users WHERE id = ? AND deleted_at IS NULL'
);

const stmtCountAdmins = db.prepare(
  "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND active = 1 AND deleted_at IS NULL"
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

  /** Soft-delete a user (can be restored). */
  deleteUser(id) {
    stmtSoftDelete.run(id);
  },

  /** Permanently delete a user (no undo). */
  hardDelete(id) {
    stmtHardDelete.run(id);
  },

  /** Restore a soft-deleted user. */
  restore(id) {
    stmtRestore.run(id);
  },

  /** Get all users including soft-deleted ones. */
  getAllIncludeDeleted() {
    return stmtGetAllIncludeDeleted.all();
  },

  /** Record login timestamp for a user. */
  recordLogin(username) {
    stmtUpdateLastLogin.run(username);
  },

  /** Update last seen timestamp for a user. */
  updateLastSeen(username) {
    stmtUpdateLastSeen.run(username);
  },

  /** Set agent status (online, offline, idle, busy). */
  setStatus(username, status) {
    stmtSetStatus.run(status, username);
  },

  /** Get user by ID. */
  getById(id) {
    return stmtGetById.get(id) || null;
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
