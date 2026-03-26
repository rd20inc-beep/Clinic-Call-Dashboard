'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');
const { isClinicaConfigured, config } = require('../config/env');
const { logEvent } = require('../services/logging.service');
const { extractLocalNumber, getPhoneVariants } = require('../utils/phone');

// ---------------------------------------------------------------------------
// Clinicea API internals (token management, caching, fetch helper)
// ---------------------------------------------------------------------------

let cliniceaToken = null;
let tokenExpiry = 0;

const meetingCache = new Map();       // phone -> { data, expiry }
const appointmentDateCache = new Map(); // date -> { data, expiry }
const profileCache = new Map();       // patientID -> { data, expiry }

const CACHE_TTL = 5 * 60 * 1000;     // 5 minutes
const PATIENT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Patient list cache
let patientCache = { patients: [], expiry: 0, loading: false, pages: 0 };

// ---------------------------------------------------------------------------
// Auth + fetch helpers
// ---------------------------------------------------------------------------

async function cliniceaLogin() {
  const url =
    config.CLINICEA_API_BASE +
    '/api/v2/login/getTokenByStaffUsernamePwd' +
    '?apiKey=' + encodeURIComponent(config.CLINICEA_API_KEY) +
    '&loginUserName=' + encodeURIComponent(config.CLINICEA_STAFF_USERNAME) +
    '&pwd=' + encodeURIComponent(config.CLINICEA_STAFF_PASSWORD);

  const res = await fetch(url);
  if (!res.ok) {
    logEvent('error', 'Clinicea API login failed', 'HTTP ' + res.status);
    throw new Error('Clinicea login failed: ' + res.status);
  }
  const data = await res.json();
  cliniceaToken =
    typeof data === 'string'
      ? data
      : data.Token || data.token || data.sessionId;
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  logEvent('info', 'Clinicea API login successful');
  return cliniceaToken;
}

async function getClinicaToken() {
  if (!cliniceaToken || Date.now() > tokenExpiry) {
    await cliniceaLogin();
  }
  return cliniceaToken;
}

async function cliniceaFetch(endpoint) {
  const token = await getClinicaToken();
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = config.CLINICEA_API_BASE + endpoint + separator + 'api_key=' + token;

  const res = await fetch(url);
  if (res.status === 401) {
    // Token expired — re-login and retry once
    await cliniceaLogin();
    const retryUrl =
      config.CLINICEA_API_BASE + endpoint + separator + 'api_key=' + cliniceaToken;
    const retryRes = await fetch(retryUrl);
    if (retryRes.status === 204) return [];
    const retryText = await retryRes.text();
    try {
      return JSON.parse(retryText);
    } catch {
      return [];
    }
  }
  if (res.status === 204) return [];
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    logEvent('warn', 'Clinicea API returned non-JSON', text.substring(0, 100));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Patient helpers
// ---------------------------------------------------------------------------

function extractPatientId(obj) {
  return (
    obj.PatientID ||
    obj.patientID ||
    obj.PatientId ||
    obj.ID ||
    obj.QDID ||
    obj.EntityID ||
    obj.entityID ||
    obj.Id ||
    obj.id ||
    obj.UniqueID ||
    obj.PatientGUID ||
    null
  );
}

function extractPatientFromSearch(data) {
  if (data && !Array.isArray(data) && typeof data === 'object') {
    const pid = extractPatientId(data);
    if (pid) {
      const name =
        data.FullName ||
        data.Name ||
        data.PatientName ||
        [data.FirstName, data.LastName].filter(Boolean).join(' ') ||
        null;
      return { patientID: pid, patientName: name };
    }
  }
  if (Array.isArray(data) && data.length > 0) {
    const pat = data[0];
    const pid = extractPatientId(pat);
    if (pid) {
      const name =
        pat.FullName ||
        pat.Name ||
        pat.PatientName ||
        [pat.FirstName, pat.LastName].filter(Boolean).join(' ') ||
        null;
      return { patientID: pid, patientName: name };
    }
  }
  return null;
}

async function findPatientByPhone(phone) {
  const cleanPhone = phone.replace(/[\s\-()]/g, '');
  const localNum = extractLocalNumber(cleanPhone);

  logEvent('info', 'Looking up phone: ' + cleanPhone, 'Local: ' + localNum);

  // Method 1: v2/getPatient — searches by mobile with country code
  try {
    const data = await cliniceaFetch(
      '/api/v2/patients/getPatient?searchBy=2&searchText=' +
        encodeURIComponent(localNum) +
        '&searchOption=%2B92'
    );
    const result = extractPatientFromSearch(data);
    if (result) {
      logEvent(
        'info',
        'Patient found via v2/getPatient: ' + result.patientName,
        'ID: ' + result.patientID
      );
      return result;
    }
  } catch (e) {
    // Fall through to next method
  }

  // Method 2: appointment-based matching
  try {
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const syncDate = thirtyDaysAgo.toISOString().split('.')[0];
    const data = await cliniceaFetch(
      '/api/v2/appointments/getChanges?lastSyncDTime=' + syncDate +
        '&pageNo=1&pageSize=100'
    );
    if (Array.isArray(data)) {
      const variants = getPhoneVariants(cleanPhone);

      const match = data.find((a) => {
        const p1 = (a.AppointmentWithPhone || '').replace(/[\s\-()]/g, '');
        const p2 = (a.PatientMobile || '').replace(/[\s\-()]/g, '');
        return variants.has(p1) || variants.has(p2);
      });

      if (match) {
        let patientName =
          match.AppointmentWithName || match.PatientName || null;
        if (!patientName) {
          const first = match.PatientFirstName || match.FirstName || '';
          const last = match.PatientLastName || match.LastName || '';
          patientName = [first, last].filter(Boolean).join(' ') || null;
        }
        logEvent(
          'info',
          'Patient found via appointments: ' + patientName,
          'ID: ' + match.PatientID
        );
        return { patientID: match.PatientID, patientName };
      }
    }
  } catch (e) {
    // Fall through
  }

  return null;
}

async function getNextAppointmentForPatient(patientID) {
  const data = await cliniceaFetch(
    '/api/v2/appointments/getAppointmentsByPatient?patientID=' +
      patientID +
      '&appointmentType=0&pageNo=1&pageSize=10'
  );
  if (!Array.isArray(data) || data.length === 0) return null;
  const now = new Date();
  const upcoming = data
    .filter(
      (a) =>
        new Date(a.StartDateTime) >= now &&
        a.AppointmentStatus !== 'Cancelled'
    )
    .sort((a, b) => new Date(a.StartDateTime) - new Date(b.StartDateTime));
  return upcoming[0] || data[0];
}

async function fetchProfileByPatientId(patientId) {
  const cached = profileCache.get(patientId);
  if (cached && Date.now() < cached.expiry) return cached.data;

  const [details, appointments, bills] = await Promise.all([
    cliniceaFetch(
      '/api/v3/patients/getPatientByID?patientID=' + patientId
    ),
    cliniceaFetch(
      '/api/v2/appointments/getAppointmentsByPatient?patientID=' +
        patientId +
        '&appointmentType=2&pageNo=1&pageSize=50'
    ),
    cliniceaFetch(
      '/api/v2/bills/getBillsByPatient?patientID=' +
        patientId +
        '&billStatus=0&pageNo=1&pageSize=50'
    ),
  ]);

  const pat = Array.isArray(details) ? details[0] || {} : details || {};
  const patientName =
    pat.Name ||
    pat.PatientName ||
    pat.FullName ||
    [pat.FirstName, pat.LastName].filter(Boolean).join(' ') ||
    'Unknown';

  const result = {
    patient: details,
    appointments: Array.isArray(appointments) ? appointments : [],
    bills: Array.isArray(bills) ? bills : [],
    patientName,
    patientID: patientId,
  };

  profileCache.set(patientId, {
    data: result,
    expiry: Date.now() + CACHE_TTL,
  });
  return result;
}

function mapPatientFields(p) {
  return {
    patientID: extractPatientId(p),
    name:
      p.Name ||
      p.PatientName ||
      p.FullName ||
      [p.FirstName, p.LastName].filter(Boolean).join(' ') ||
      'Unknown',
    phone: p.Mobile || p.MobilePhone || p.PatientMobile || p.Phone || '',
    email: p.Email || p.EmailAddress || '',
    fileNo: p.FileNo || '',
    gender: p.Gender || '',
    createdDate: p.CreatedDatetime || p.CreatedDate || '',
  };
}

async function loadAllPatients() {
  if (patientCache.loading) return;
  patientCache.loading = true;
  const allPatients = [];
  let pageNo = 1;
  try {
    while (true) {
      const data = await cliniceaFetch(
        '/api/v1/patients?lastSyncDate=2000-01-01T00:00:00&intPageNo=' + pageNo
      );
      const batch = Array.isArray(data) ? data : [];
      allPatients.push(...batch.map(mapPatientFields));
      if (batch.length < 100) break; // last page
      pageNo++;
      if (pageNo > 200) break; // safety limit (20000 patients max)
    }
    patientCache = {
      patients: allPatients,
      expiry: Date.now() + PATIENT_CACHE_TTL,
      loading: false,
      pages: pageNo,
    };
    logEvent(
      'info',
      'Patient cache loaded: ' + allPatients.length + ' patients (' + pageNo + ' pages)'
    );
  } catch (err) {
    patientCache.loading = false;
    logEvent('error', 'Patient cache load failed', err.message);
    throw err;
  }
}

function mapAppointmentFields(a) {
  return {
    appointmentID: a.AppointmentID || a.ID || a.Id,
    patientID: a.PatientID || a.patientID,
    patientName:
      a.AppointmentWithName ||
      a.PatientName ||
      [a.PatientFirstName || a.FirstName, a.PatientLastName || a.LastName]
        .filter(Boolean)
        .join(' ') ||
      'Unknown',
    startTime: a.StartDateTime || a.AppointmentDateTime || a.StartTime || '',
    endTime: a.EndDateTime || a.EndTime || '',
    duration: a.Duration || null,
    status: a.AppointmentStatus || a.Status || 'Unknown',
    service: a.ServiceName || a.Service || '',
    doctor: a.DoctorName || a.Doctor || '',
    phone: a.AppointmentWithPhone || a.PatientMobile || a.Mobile || '',
    notes: a.Notes || a.AppointmentNotes || '',
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/next-meeting/:phone
router.get('/api/next-meeting/:phone', requireAuth, apiLimiter, async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);

  if (!isClinicaConfigured()) {
    return res.json({ nextMeeting: null, error: 'Clinicea API not configured' });
  }

  const cached = meetingCache.get(phone);
  if (cached && Date.now() < cached.expiry) {
    return res.json(cached.data);
  }

  try {
    const patient = await findPatientByPhone(phone);
    if (!patient) {
      const result = { nextMeeting: null, patientName: null };
      meetingCache.set(phone, { data: result, expiry: Date.now() + CACHE_TTL });
      return res.json(result);
    }

    const appointment = await getNextAppointmentForPatient(patient.patientID);
    const result = { nextMeeting: appointment, patientName: patient.patientName };
    meetingCache.set(phone, { data: result, expiry: Date.now() + CACHE_TTL });
    return res.json(result);
  } catch (err) {
    logEvent('error', 'Clinicea API error', err.message);
    return res.json({ nextMeeting: null, patientName: null, error: err.message });
  }
});

// GET /api/patient-profile/:phone
router.get('/api/patient-profile/:phone', requireAuth, apiLimiter, async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);

  if (!isClinicaConfigured()) {
    return res.json({ error: 'Clinicea API not configured' });
  }

  try {
    const patient = await findPatientByPhone(phone);
    if (!patient || !patient.patientID) {
      return res.json({ error: 'Patient not found in Clinicea' });
    }

    const result = await fetchProfileByPatientId(patient.patientID);
    return res.json(result);
  } catch (err) {
    logEvent('error', 'Patient profile fetch failed', err.message);
    return res.json({ error: err.message });
  }
});

// GET /api/patient-profile-by-id/:patientId
router.get(
  '/api/patient-profile-by-id/:patientId',
  requireAuth,
  apiLimiter,
  async (req, res) => {
    const patientId = req.params.patientId;

    if (!isClinicaConfigured()) {
      return res.json({ error: 'Clinicea API not configured' });
    }

    try {
      const result = await fetchProfileByPatientId(patientId);
      return res.json(result);
    } catch (err) {
      logEvent('error', 'Patient profile by ID fetch failed', err.message);
      return res.json({ error: err.message });
    }
  }
);

// GET /api/patients
router.get('/api/patients', requireAuth, apiLimiter, async (req, res) => {
  const search = (req.query.search || '').trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = parseInt(req.query.pageSize, 10) || 50;

  if (!isClinicaConfigured()) {
    return res.json({ error: 'Clinicea API not configured', patients: [], total: 0 });
  }

  try {
    // Load / refresh cache if stale
    if (Date.now() > patientCache.expiry && !patientCache.loading) {
      await loadAllPatients();
    } else if (patientCache.loading) {
      return res.json({ patients: [], page: 1, hasMore: false, loading: true });
    }

    let patients = patientCache.patients;

    // Merge local DB patients (from appointments/calls) that aren't in Clinicea
    try {
      const patientsRepo = require('../db/patients.repo');
      const localPatients = patientsRepo.getPatients({ page: 1, pageSize: 10000 }).patients;
      const existingPhones = new Set(patients.map(p => p.phone.replace(/[\s\-()]/g, '')));

      for (const lp of localPatients) {
        const cleanPhone = (lp.phone || '').replace(/[\s\-()]/g, '');
        if (cleanPhone && !existingPhones.has(cleanPhone)) {
          patients.push({
            patientID: lp.clinicea_id || 'local-' + lp.id,
            name: lp.name,
            phone: lp.phone,
            email: lp.email || '',
            fileNo: '',
            gender: lp.gender || '',
            createdDate: lp.created_at || '',
            _local: true,
            _doctor: lp.doctor,
            _service: lp.last_service,
            _lastAppointment: lp.last_appointment,
          });
          existingPhones.add(cleanPhone);
        }
      }
    } catch (e) { console.error('[clinicea] Patient upsert from appointments failed:', e.message); }

    // Collect unique doctors and services for filter dropdowns
    const doctorsSet = new Set();
    const servicesSet = new Set();
    patients.forEach(p => {
      if (p._doctor) doctorsSet.add(p._doctor);
      if (p._service) servicesSet.add(p._service);
    });

    // Filter by search
    if (search) {
      patients = patients.filter(
        (p) =>
          p.name.toLowerCase().includes(search) ||
          p.phone.toLowerCase().includes(search) ||
          (p.email && p.email.toLowerCase().includes(search)) ||
          (p.fileNo && p.fileNo.toLowerCase().includes(search))
      );
    }

    // Filter by doctor
    const doctorFilter = (req.query.doctor || '').trim();
    if (doctorFilter) {
      patients = patients.filter(p => p._doctor === doctorFilter);
    }

    // Filter by service
    const serviceFilter = (req.query.service || '').trim();
    if (serviceFilter) {
      patients = patients.filter(p => p._service === serviceFilter);
    }

    // Sort
    const sort = req.query.sort || 'recent';
    if (sort === 'name') {
      patients.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (sort === 'phone') {
      patients.sort((a, b) => (a.phone || '').localeCompare(b.phone || ''));
    }

    // Paginate
    const total = patients.length;
    const start = (page - 1) * pageSize;
    const sliced = patients.slice(start, start + pageSize);

    return res.json({
      patients: sliced,
      page,
      hasMore: start + pageSize < total,
      total,
      doctors: Array.from(doctorsSet).sort(),
      services: Array.from(servicesSet).sort(),
    });
  } catch (err) {
    logEvent('error', 'Patients list fetch failed', err.message);
    return res.json({ error: err.message, patients: [], total: 0 });
  }
});

// GET /api/appointments-by-date
router.get(
  '/api/appointments-by-date',
  requireAuth,
  apiLimiter,
  async (req, res) => {
    const date = req.query.date;
    if (!date) {
      return res.json({ error: 'date parameter required', appointments: [] });
    }

    if (!isClinicaConfigured()) {
      return res.json({ error: 'Clinicea API not configured', appointments: [] });
    }

    // Check cache (skip if refresh=1)
    const forceRefresh = req.query.refresh === '1';
    const cached = appointmentDateCache.get(date);
    if (cached && Date.now() < cached.expiry && !forceRefresh) {
      return res.json({ appointments: cached.data, date });
    }

    try {
      const data = await cliniceaFetch(
        '/api/v3/appointments/getAppointmentsByDate?appointmentDate=' +
          encodeURIComponent(date) +
          '&pageNo=1&pageSize=100'
      );
      const appointments = (Array.isArray(data) ? data : []).map(
        mapAppointmentFields
      );

      appointmentDateCache.set(date, {
        data: appointments,
        expiry: Date.now() + CACHE_TTL,
      });
      return res.json({ appointments, date });
    } catch (err) {
      logEvent('error', 'Appointments by date fetch failed', err.message);
      return res.json({ error: err.message, appointments: [] });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/patients/edit — edit a local patient record
// ---------------------------------------------------------------------------
router.post('/api/patients/edit', requireAuth, (req, res) => {
  const { id, name, phone, email, gender, doctor, notes } = req.body;
  if (!id) return res.json({ error: 'id required' });
  try {
    const patientsRepo = require('../db/patients.repo');
    patientsRepo.update(id, name, phone, email, gender, doctor, null, notes);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Exported helpers (used by call.routes.js for patient lookup)
// ---------------------------------------------------------------------------
module.exports = router;

// Also export service functions for use by other modules
module.exports.findPatientByPhone = findPatientByPhone;
module.exports.fetchProfileByPatientId = fetchProfileByPatientId;
module.exports.cliniceaFetch = cliniceaFetch;
module.exports.extractPatientId = extractPatientId;
module.exports.mapAppointmentFields = mapAppointmentFields;
module.exports.patientCache = patientCache;
module.exports.appointmentDateCache = appointmentDateCache;
module.exports.clearPatientCache = function() { patientCache = { patients: [], expiry: 0, loading: false, pages: 0 }; };
module.exports.clearAppointmentCache = function() { appointmentDateCache.clear(); };
