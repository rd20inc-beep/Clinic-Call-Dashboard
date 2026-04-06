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

// =========================================================================
// TABLE DEFINITIONS
// Each CREATE TABLE has the full canonical column set. ALTER TABLE statements
// below each definition handle backward-compat for existing databases.
// =========================================================================

// --- Calls ---
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
    direction TEXT DEFAULT 'inbound',
    call_status TEXT DEFAULT 'unknown',
    duration INTEGER DEFAULT NULL,
    disposition TEXT,
    notes TEXT,
    source TEXT DEFAULT 'phone',
    call_started_at DATETIME,
    call_ended_at DATETIME,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try { db.exec('ALTER TABLE calls ADD COLUMN patient_name TEXT'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN patient_id TEXT'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN agent TEXT'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN routing_method TEXT'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN source_ip TEXT'); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE calls ADD COLUMN direction TEXT DEFAULT 'inbound'"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE calls ADD COLUMN call_status TEXT DEFAULT 'unknown'"); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN duration INTEGER DEFAULT NULL'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN disposition TEXT'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN notes TEXT'); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE calls ADD COLUMN source TEXT DEFAULT 'phone'"); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN call_started_at DATETIME'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN call_ended_at DATETIME'); } catch (e) { /* exists */ }

// Calls indexes
try { db.exec('CREATE INDEX IF NOT EXISTS idx_calls_sid ON calls(call_sid) WHERE call_sid IS NOT NULL'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_calls_agent ON calls(agent)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_calls_timestamp ON calls(timestamp DESC)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(call_status)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_calls_direction ON calls(direction)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_number)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_calls_agent_ts ON calls(agent, timestamp DESC)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_calls_status_ts ON calls(call_status, timestamp DESC)'); } catch(e) {}

// --- WhatsApp messages ---
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
    sent_at DATETIME,
    wa_message_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try { db.exec('ALTER TABLE wa_messages ADD COLUMN agent TEXT'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE wa_messages ADD COLUMN sent_at DATETIME'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE wa_messages ADD COLUMN wa_message_id TEXT'); } catch (e) { /* exists */ }

// WA messages indexes
try { db.exec('CREATE INDEX IF NOT EXISTS idx_wa_msg_phone ON wa_messages(phone)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_wa_msg_status ON wa_messages(status)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_wa_msg_dir ON wa_messages(direction, created_at DESC)'); } catch(e) {}

// --- Local patients table (supplements Clinicea API cache) ---
try {
  const testStmt = db.prepare("INSERT INTO patients (name, phone) VALUES ('_test_', '_test_unique_check_') ON CONFLICT(phone) DO UPDATE SET name = name");
  testStmt.run();
  db.prepare("DELETE FROM patients WHERE phone = '_test_unique_check_'").run();
} catch (e) {
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
  try {
    db.exec("INSERT OR IGNORE INTO patients SELECT * FROM patients_old");
    db.exec("DROP TABLE patients_old");
    console.log('[MIGRATION] Recreated patients table with UNIQUE constraint');
  } catch(e3) { /* no old table */ }
}

// Patients indexes
try { db.exec('CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name)'); } catch(e) {}

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

// --- WhatsApp settings ---
db.exec(`
  CREATE TABLE IF NOT EXISTS wa_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

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

// --- Appointment tracking ---
db.exec(`
  CREATE TABLE IF NOT EXISTS wa_appointment_tracking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id TEXT UNIQUE NOT NULL,
    patient_id TEXT,
    patient_name TEXT,
    patient_phone TEXT,
    appointment_date TEXT,
    end_time TEXT,
    duration INTEGER,
    doctor_name TEXT,
    service TEXT,
    clinicea_status TEXT,
    notes TEXT,
    confirmation_sent INTEGER DEFAULT 0,
    reminder_sent INTEGER DEFAULT 0,
    confirmation_sent_at DATETIME,
    reminder_sent_at DATETIME,
    created_by TEXT,
    assigned_agent TEXT,
    status_updated_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try { db.exec("ALTER TABLE wa_appointment_tracking ADD COLUMN created_by TEXT"); } catch(e) { /* exists */ }
try { db.exec("ALTER TABLE wa_appointment_tracking ADD COLUMN assigned_agent TEXT"); } catch(e) { /* exists */ }
try { db.exec("ALTER TABLE wa_appointment_tracking ADD COLUMN clinicea_status TEXT"); } catch(e) { /* exists */ }
try { db.exec("ALTER TABLE wa_appointment_tracking ADD COLUMN end_time TEXT"); } catch(e) { /* exists */ }
try { db.exec("ALTER TABLE wa_appointment_tracking ADD COLUMN duration INTEGER"); } catch(e) { /* exists */ }
try { db.exec("ALTER TABLE wa_appointment_tracking ADD COLUMN notes TEXT"); } catch(e) { /* exists */ }
try { db.exec("ALTER TABLE wa_appointment_tracking ADD COLUMN status_updated_at DATETIME"); } catch(e) { /* exists */ }

// Appointment tracking indexes
try { db.exec('CREATE INDEX IF NOT EXISTS idx_wa_track_phone ON wa_appointment_tracking(patient_phone)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_wa_track_date ON wa_appointment_tracking(appointment_date DESC)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_wa_track_agent ON wa_appointment_tracking(assigned_agent)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_wa_track_status ON wa_appointment_tracking(clinicea_status)'); } catch(e) {}

// --- Users ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    role TEXT DEFAULT 'agent',
    active INTEGER DEFAULT 1,
    notes TEXT,
    last_login DATETIME,
    last_seen DATETIME,
    status TEXT DEFAULT 'offline',
    phone TEXT,
    email TEXT,
    activity_reset_at DATETIME,
    device_info TEXT,
    deleted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

try { db.exec('ALTER TABLE users ADD COLUMN last_login DATETIME'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN last_seen DATETIME'); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'offline'"); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN phone TEXT'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN activity_reset_at DATETIME'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN device_info TEXT'); } catch (e) { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN deleted_at DATETIME'); } catch (e) { /* exists */ }

// --- Login history ---
db.exec(`
  CREATE TABLE IF NOT EXISTS login_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    source TEXT DEFAULT 'dashboard',
    ip TEXT,
    user_agent TEXT,
    logged_in_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    logged_out_at DATETIME,
    duration_mins INTEGER
  )
`);

try { db.exec("ALTER TABLE login_history ADD COLUMN logged_out_at DATETIME"); } catch(e) { /* exists */ }
try { db.exec("ALTER TABLE login_history ADD COLUMN duration_mins INTEGER"); } catch(e) { /* exists */ }

// Login history index
try { db.exec('CREATE INDEX IF NOT EXISTS idx_login_history_user ON login_history(username, logged_in_at DESC)'); } catch(e) {}

// --- Mobile app tokens ---
db.exec(`
  CREATE TABLE IF NOT EXISTS app_tokens (
    token TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    role TEXT DEFAULT 'agent',
    login_at INTEGER NOT NULL,
    ip TEXT
  )
`);

// --- Callbacks ---
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

// Callbacks indexes
try { db.exec('CREATE INDEX IF NOT EXISTS idx_callbacks_status ON callbacks(callback_status)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_callbacks_caller ON callbacks(caller_number)'); } catch(e) {}

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

// --- Internal messaging ---
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

// --- Audit log ---
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

// =========================================================================
// ONE-TIME DATA MIGRATIONS
// =========================================================================

// Seed env-based agents into DB (makes the system fully database-driven)
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
    if (stmtCheck.get(username)) continue;

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

// Normalize 03XXX phone numbers to +92XXX
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

// Backfill confirmation_sent/reminder_sent from wa_messages
// Matches messages to appointments by last 10 digits of phone
try {
  const unflagged = db.prepare(
    "SELECT id, patient_phone FROM wa_appointment_tracking WHERE (confirmation_sent = 0 OR reminder_sent = 0) AND patient_phone IS NOT NULL AND patient_phone != ''"
  ).all();
  if (unflagged.length > 0) {
    // Build phone→message types map from wa_messages
    const msgMap = {};
    db.prepare(
      "SELECT phone, GROUP_CONCAT(DISTINCT message_type) as types FROM wa_messages " +
      "WHERE direction = 'out' AND message_type IN ('confirmation','reminder') GROUP BY phone"
    ).all().forEach(r => {
      const key = (r.phone || '').replace(/[\s\-+()]/g, '').slice(-10);
      if (key) msgMap[key] = (r.types || '').split(',');
    });

    let confFixed = 0, remFixed = 0;
    const stmtConf = db.prepare("UPDATE wa_appointment_tracking SET confirmation_sent = 1, confirmation_sent_at = COALESCE(confirmation_sent_at, datetime('now')) WHERE id = ?");
    const stmtRem = db.prepare("UPDATE wa_appointment_tracking SET reminder_sent = 1, reminder_sent_at = COALESCE(reminder_sent_at, datetime('now')) WHERE id = ?");

    for (const row of unflagged) {
      const key = (row.patient_phone || '').replace(/[\s\-+()]/g, '').slice(-10);
      const types = msgMap[key] || [];
      if (types.includes('confirmation')) { stmtConf.run(row.id); confFixed++; }
      if (types.includes('reminder')) { stmtRem.run(row.id); remFixed++; }
    }
    if (confFixed > 0 || remFixed > 0) {
      console.log(`[MIGRATION] Backfilled message flags: ${confFixed} confirmations, ${remFixed} reminders`);
    }
  }
} catch (e) { /* tables may not exist yet */ }

module.exports = { db, sessionDb };
