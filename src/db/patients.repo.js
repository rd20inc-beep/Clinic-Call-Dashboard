'use strict';

const { db } = require('./index');

const stmtUpsert = db.prepare(`
  INSERT INTO patients (clinicea_id, name, phone, doctor, last_service, last_appointment, source, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(phone) DO UPDATE SET
    name = CASE WHEN excluded.name != '' AND excluded.name != 'Patient' THEN excluded.name ELSE patients.name END,
    clinicea_id = COALESCE(excluded.clinicea_id, patients.clinicea_id),
    doctor = COALESCE(excluded.doctor, patients.doctor),
    last_service = COALESCE(excluded.last_service, patients.last_service),
    last_appointment = CASE WHEN excluded.last_appointment > COALESCE(patients.last_appointment, '') THEN excluded.last_appointment ELSE patients.last_appointment END,
    updated_at = datetime('now')
  WHERE excluded.phone IS NOT NULL AND excluded.phone != ''
`);

const stmtGetAll = db.prepare(
  'SELECT * FROM patients ORDER BY updated_at DESC'
);

const stmtGetPaginated = db.prepare(
  'SELECT * FROM patients ORDER BY updated_at DESC LIMIT ? OFFSET ?'
);

const stmtCount = db.prepare('SELECT COUNT(*) as c FROM patients');

const stmtSearch = db.prepare(
  "SELECT * FROM patients WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? ORDER BY updated_at DESC LIMIT ? OFFSET ?"
);

const stmtSearchCount = db.prepare(
  "SELECT COUNT(*) as c FROM patients WHERE name LIKE ? OR phone LIKE ? OR email LIKE ?"
);

const stmtGetByPhone = db.prepare('SELECT * FROM patients WHERE phone = ?');

const stmtUpdate = db.prepare(
  "UPDATE patients SET name = ?, phone = ?, email = ?, gender = ?, doctor = ?, last_service = ?, notes = ?, updated_at = datetime('now') WHERE id = ?"
);

module.exports = {
  /** Upsert a patient from appointment data. */
  upsertFromAppointment(cliniceaId, name, phone, doctor, service, appointmentDate) {
    if (!phone || phone.trim() === '') return;
    stmtUpsert.run(
      cliniceaId || null,
      name || 'Patient',
      phone.replace(/[\s\-()]/g, ''),
      doctor || null,
      service || null,
      appointmentDate || null,
      'appointment'
    );
  },

  /** Upsert from a call record. */
  upsertFromCall(name, phone, cliniceaId) {
    if (!phone || phone.trim() === '') return;
    stmtUpsert.run(
      cliniceaId || null,
      name || 'Unknown',
      phone.replace(/[\s\-()]/g, ''),
      null, null, null,
      'call'
    );
  },

  /** Get paginated patients with optional search. */
  getPatients({ page = 1, pageSize = 50, search = '' } = {}) {
    const offset = (page - 1) * pageSize;
    if (search) {
      const q = '%' + search + '%';
      const total = stmtSearchCount.get(q, q, q).c;
      const patients = stmtSearch.all(q, q, q, pageSize, offset);
      return { patients, total, page, totalPages: Math.ceil(total / pageSize) || 1 };
    }
    const total = stmtCount.get().c;
    const patients = stmtGetPaginated.all(pageSize, offset);
    return { patients, total, page, totalPages: Math.ceil(total / pageSize) || 1 };
  },

  /** Get patient by phone number. */
  getByPhone(phone) {
    return stmtGetByPhone.get(phone) || null;
  },

  /** Update patient details. */
  update(id, name, phone, email, gender, doctor, lastService, notes) {
    stmtUpdate.run(name, phone, email, gender, doctor, lastService, notes, id);
  },

  /** Get total patient count. */
  count() {
    return stmtCount.get().c;
  },
};
