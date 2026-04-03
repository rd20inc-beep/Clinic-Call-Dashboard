'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimit');
const { isClinicaConfigured, config } = require('../config/env');
const { logEvent } = require('../services/logging.service');
const { extractLocalNumber, getPhoneVariants } = require('../utils/phone');

// ---------------------------------------------------------------------------
// Clinicea API — use shared service (single token, single cache, hardened fetch)
// ---------------------------------------------------------------------------
const cliniceaService = require('../services/clinicea.service');
const { cliniceaFetch, findPatientByPhone, getNextAppointmentForPatient,
        fetchProfileByPatientId, loadAllPatients, getPatientCacheState,
        mapPatientFields, mapAppointmentFields, extractPatientId,
        getAppointmentsByDate, getMeetingCache } = cliniceaService;

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes for local route caches (meetings, profiles)

// ---------------------------------------------------------------------------
// Patient helpers
// All helper functions (findPatientByPhone, mapPatientFields, etc.)
// are imported from cliniceaService above — routes are thin wrappers.

// Local route-level caches for meeting lookups and profiles
const meetingCache = new Map();
const profileCache = new Map();
const appointmentDateCache = new Map();

function getPatientCache() { return getPatientCacheState(); }

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
    // Load / refresh cache if stale — uses shared service cache
    const pc = getPatientCache();
    if (Date.now() > pc.expiry && !pc.loading) {
      await loadAllPatients();
    }
    // Serve previous cache while loading (never return empty during refresh)
    let patients = getPatientCache().patients || [];

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
      // Log raw field names once for debugging
      if (Array.isArray(data) && data.length > 0) {
        const sample = data[0];
        logEvent('debug', 'Clinicea raw appointment keys: ' + Object.keys(sample).join(', '));
        // Log doctor/service related fields specifically
        const doctorFields = Object.entries(sample).filter(([k]) => /doctor|resource|provider|staff|practitioner/i.test(k));
        const serviceFields = Object.entries(sample).filter(([k]) => /service|treatment|procedure/i.test(k));
        logEvent('debug', 'Doctor fields: ' + doctorFields.map(([k,v]) => k + '=' + v).join(', '));
        logEvent('debug', 'Service fields: ' + serviceFields.map(([k,v]) => k + '=' + v).join(', '));
      }
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
module.exports.getPatientCache = getPatientCache;
module.exports.appointmentDateCache = appointmentDateCache;
module.exports.clearPatientCache = function() { try { cliniceaService.clearPatientCache && cliniceaService.clearPatientCache(); } catch(e) {} };
module.exports.clearAppointmentCache = function() { appointmentDateCache.clear(); };
