'use strict';

const Database = require('better-sqlite3');
const path = require('path');

// Resolve database paths relative to project root
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CALLS_DB_PATH = path.join(PROJECT_ROOT, 'calls.db');
const SESSIONS_DB_PATH = path.join(PROJECT_ROOT, 'sessions.db');

// --- Main database ---
const db = new Database(CALLS_DB_PATH);
db.pragma('journal_mode = WAL');

// --- Session database ---
const sessionDb = new Database(SESSIONS_DB_PATH);
sessionDb.pragma('journal_mode = WAL');

// --- Create tables ---

db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caller_number TEXT NOT NULL,
    call_sid TEXT,
    clinicea_url TEXT,
    patient_name TEXT,
    patient_id TEXT,
    agent TEXT,
    routing_method TEXT,
    source_ip TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Add columns that may be missing on existing databases
try { db.exec('ALTER TABLE calls ADD COLUMN patient_name TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN patient_id TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN agent TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN routing_method TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN source_ip TEXT'); } catch (e) { /* already exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS wa_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    chat_name TEXT,
    direction TEXT NOT NULL,
    message TEXT NOT NULL,
    message_type TEXT DEFAULT 'chat',
    status TEXT DEFAULT 'sent',
    agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try { db.exec('ALTER TABLE wa_messages ADD COLUMN agent TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE wa_messages ADD COLUMN sent_at DATETIME'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE wa_messages ADD COLUMN wa_message_id TEXT'); } catch (e) { /* already exists */ }

// --- Local patients table (supplements Clinicea API cache) ---
// Check if table exists and has UNIQUE on phone, recreate if not
try {
  // Test if UNIQUE constraint works
  const testStmt = db.prepare("INSERT INTO patients (name, phone) VALUES ('_test_', '_test_unique_check_') ON CONFLICT(phone) DO UPDATE SET name = name");
  testStmt.run();
  db.prepare("DELETE FROM patients WHERE phone = '_test_unique_check_'").run();
} catch (e) {
  // Table doesn't exist or lacks UNIQUE — recreate
  try { db.exec('ALTER TABLE patients RENAME TO patients_old'); } catch(e2) { /* doesn't exist */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clinicea_id TEXT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE,
      email TEXT,
      gender TEXT,
      file_no TEXT,
      doctor TEXT,
      last_service TEXT,
      last_appointment DATETIME,
      source TEXT DEFAULT 'appointment',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Migrate data from old table if it existed
  try {
    db.exec("INSERT OR IGNORE INTO patients SELECT * FROM patients_old");
    db.exec("DROP TABLE patients_old");
    console.log('[MIGRATION] Recreated patients table with UNIQUE constraint');
  } catch(e3) { /* no old table */ }
}

// Seed patients from existing appointment tracking (one-time migration)
try {
  const existingPatients = db.prepare('SELECT COUNT(*) as c FROM patients').get().c;
  if (existingPatients === 0) {
    const apts = db.prepare("SELECT DISTINCT patient_id, patient_name, patient_phone, doctor_name, service, appointment_date FROM wa_appointment_tracking WHERE patient_phone IS NOT NULL AND patient_phone != ''").all();
    if (apts.length > 0) {
      const pInsert = db.prepare("INSERT OR IGNORE INTO patients (clinicea_id, name, phone, doctor, last_service, last_appointment, source) VALUES (?, ?, ?, ?, ?, ?, 'appointment')");
      let seeded = 0;
      for (const a of apts) {
        try {
          pInsert.run(a.patient_id, a.patient_name || 'Patient', a.patient_phone.replace(/[\s\-()]/g, ''), a.doctor_name, a.service, a.appointment_date);
          seeded++;
        } catch (e) { /* duplicate phone */ }
      }
      if (seeded > 0) console.log('[MIGRATION] Seeded ' + seeded + ' patients from appointments');
    }
    // Also seed from calls
    const calls = db.prepare("SELECT DISTINCT caller_number, patient_name FROM calls WHERE caller_number IS NOT NULL AND caller_number != '' AND caller_number != 'Unknown' AND caller_number != 'Anonymous'").all();
    let callSeeded = 0;
    const cInsert = db.prepare("INSERT OR IGNORE INTO patients (name, phone, source) VALUES (?, ?, 'call')");
    for (const c of calls) {
      try {
        cInsert.run(c.patient_name || 'Unknown', c.caller_number.replace(/[\s\-()]/g, ''));
        callSeeded++;
      } catch (e) { /* duplicate */ }
    }
    if (callSeeded > 0) console.log('[MIGRATION] Seeded ' + callSeeded + ' patients from calls');
  }
} catch (e) { /* table may not exist on very first run */ }

// --- WhatsApp settings (global toggle, persisted paused chats) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS wa_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Seed default: bot globally enabled
db.exec(`
  INSERT OR IGNORE INTO wa_settings (key, value) VALUES ('bot_enabled', '1')
`);

// --- Persisted paused chats ---
db.exec(`
  CREATE TABLE IF NOT EXISTS wa_paused_chats (
    chat_id TEXT PRIMARY KEY,
    paused_by TEXT,
    paused_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS wa_appointment_tracking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id TEXT UNIQUE NOT NULL,
    patient_id TEXT,
    patient_name TEXT,
    patient_phone TEXT,
    appointment_date TEXT,
    doctor_name TEXT,
    service TEXT,
    confirmation_sent INTEGER DEFAULT 0,
    reminder_sent INTEGER DEFAULT 0,
    confirmation_sent_at DATETIME,
    reminder_sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// --- Users table (DB-managed agents, supplements env vars) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    role TEXT DEFAULT 'agent',
    active INTEGER DEFAULT 1,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// User presence and status columns
try { db.exec('ALTER TABLE users ADD COLUMN last_login DATETIME'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN last_seen DATETIME'); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'offline'"); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN phone TEXT'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN activity_reset_at DATETIME'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN device_info TEXT'); } catch (e) { /* exists */ }

// Call dedup index + timing and source columns
try { db.exec('CREATE INDEX IF NOT EXISTS idx_calls_sid ON calls(call_sid) WHERE call_sid IS NOT NULL'); } catch(e) {}
// Call timing and source columns
try { db.exec('ALTER TABLE calls ADD COLUMN call_started_at DATETIME'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN call_ended_at DATETIME'); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE calls ADD COLUMN source TEXT DEFAULT 'phone'"); } catch (e) { /* exists */ }

// --- Callbacks table (missed calls that need follow-up) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS callbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id INTEGER,
    caller_number TEXT NOT NULL,
    patient_name TEXT,
    original_agent TEXT,
    assigned_agent TEXT,
    callback_status TEXT DEFAULT 'pending',
    callback_attempts INTEGER DEFAULT 0,
    callback_notes TEXT,
    call_time DATETIME,
    last_attempt_at DATETIME,
    resolved_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Seed callbacks from existing missed calls (one-time migration)
try {
  const missedWithoutCb = db.prepare(
    "SELECT c.id, c.caller_number, c.patient_name, c.agent, c.timestamp FROM calls c " +
    "LEFT JOIN callbacks cb ON cb.call_id = c.id " +
    "WHERE c.call_status IN ('missed','rejected','no_answer') AND cb.id IS NULL"
  ).all();
  if (missedWithoutCb.length > 0) {
    const cbInsert = db.prepare("INSERT INTO callbacks (call_id, caller_number, patient_name, original_agent, callback_status, call_time) VALUES (?, ?, ?, ?, 'pending', ?)");
    const cbExistNum = db.prepare("SELECT id FROM callbacks WHERE caller_number = ? AND callback_status IN ('pending','assigned') LIMIT 1");
    let seeded = 0;
    for (const c of missedWithoutCb) {
      if (cbExistNum.get(c.caller_number)) continue;
      cbInsert.run(c.id, c.caller_number, c.patient_name, c.agent, c.timestamp);
      seeded++;
    }
    if (seeded > 0) console.log('[MIGRATION] Seeded ' + seeded + ' callbacks from missed calls');
  }
} catch (e) { /* table may not exist yet on very first run */ }

// --- Internal messaging table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS internal_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    message TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_chat_to ON internal_messages(to_user, read, created_at DESC)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_chat_conv ON internal_messages(from_user, to_user, created_at DESC)'); } catch(e) {}

// --- Audit log table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    target TEXT,
    details TEXT,
    performed_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// --- Soft delete support for users ---
try { db.exec('ALTER TABLE users ADD COLUMN deleted_at DATETIME'); } catch (e) { /* exists */ }

// --- One-time migration: seed env-based agents into DB ---
// This makes the system fully database-driven. Env vars become fallback only.
(function migrateEnvAgentsToDb() {
  const bcrypt = require('bcryptjs');
  const envDefaults = {
    admin:  { pass: 'clinicea2025', role: 'admin' },
    agent1: { pass: 'password1',    role: 'agent' },
    agent2: { pass: 'password2',    role: 'agent' },
    agent3: { pass: 'password3',    role: 'agent' },
    agent4: { pass: 'password4',    role: 'agent' },
    agent5: { pass: 'password5',    role: 'agent' },
  };

  const stmtCheck = db.prepare('SELECT id FROM users WHERE username = ?');
  const stmtInsertMigrate = db.prepare(
    'INSERT INTO users (username, password_hash, display_name, role, active, status) VALUES (?, ?, ?, ?, 1, ?)'
  );

  for (const [username, cfg] of Object.entries(envDefaults)) {
    if (stmtCheck.get(username)) continue; // already in DB

    // Try env var hash first, then env var pass, then default
    const envKey = username.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const envHash = process.env['USER_' + envKey + '_HASH'];
    const envPass = process.env['USER_' + envKey + '_PASS'];

    let hash;
    if (envHash && envHash.trim()) {
      hash = envHash.trim();
    } else {
      const plainPass = (envPass && envPass.trim()) || cfg.pass;
      hash = bcrypt.hashSync(plainPass, 10);
    }

    stmtInsertMigrate.run(username, hash, username, cfg.role, 'offline');
    console.log(`[MIGRATION] Seeded agent "${username}" into users table`);
  }
})();

// --- One-time migration: normalize 03XXX phone numbers to +92XXX ---
const oldNumbers = db
  .prepare(
    "SELECT id, caller_number FROM calls WHERE caller_number LIKE '03%' AND length(caller_number) = 11"
  )
  .all();

if (oldNumbers.length > 0) {
  const updateNum = db.prepare('UPDATE calls SET caller_number = ? WHERE id = ?');
  const migrate = db.transaction(() => {
    for (const row of oldNumbers) {
      updateNum.run('+92' + row.caller_number.substring(1), row.id);
    }
  });
  migrate();
  console.log(
    `[MIGRATION] Normalized ${oldNumbers.length} phone numbers from 03XXX to +92XXX`
  );
}

module.exports = { db, sessionDb };
