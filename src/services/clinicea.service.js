'use strict';

const { config, isClinicaConfigured } = require('../config/env');
const { CACHE_TTL, PATIENT_CACHE_TTL } = require('../config/constants');
const { extractLocalNumber, getPhoneVariants } = require('../utils/phone');
const { logEvent } = require('./logging.service');

// ---------------------------------------------------------------------------
// Clinicea API state
// ---------------------------------------------------------------------------

let cliniceaToken = null;
let tokenExpiry = 0;

const meetingCache = new Map();          // phone -> { data, expiry }
const appointmentDateCache = new Map();  // date -> { data, expiry }
const profileCache = new Map();          // patientID -> { data, expiry }
let patientCache = { patients: [], expiry: 0, loading: false, pages: 0 };

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Authenticate against the Clinicea API and cache the session token.
 * The token is valid for ~60 min; we treat it as stale after 55 min.
 *
 * @returns {Promise<string>} session token
 */
async function cliniceaLogin() {
  const url =
    `${config.CLINICEA_API_BASE}/api/v2/login/getTokenByStaffUsernamePwd` +
    `?apiKey=${encodeURIComponent(config.CLINICEA_API_KEY)}` +
    `&loginUserName=${encodeURIComponent(config.CLINICEA_STAFF_USERNAME)}` +
    `&pwd=${encodeURIComponent(config.CLINICEA_STAFF_PASSWORD)}`;

  const res = await fetch(url);
  if (!res.ok) {
    logEvent('error', 'Clinicea API login failed', 'HTTP ' + res.status);
    throw new Error('Clinicea login failed: ' + res.status);
  }

  const data = await res.json();
  // Token is returned as a plain string or an object with Token/token/sessionId
  cliniceaToken =
    typeof data === 'string'
      ? data
      : data.Token || data.token || data.sessionId;
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  logEvent('info', 'Clinicea API login successful');
  return cliniceaToken;
}

/**
 * Return a valid Clinicea token, re-authenticating if necessary.
 *
 * @returns {Promise<string>}
 */
async function getClinicaToken() {
  if (!cliniceaToken || Date.now() > tokenExpiry) {
    await cliniceaLogin();
  }
  return cliniceaToken;
}

// ---------------------------------------------------------------------------
// Generic fetch wrapper
// ---------------------------------------------------------------------------

/**
 * Fetch a Clinicea API endpoint, appending the session token as `api_key`.
 * Automatically retries on 401 (token expiry). Returns `[]` on 204 or parse
 * failure so callers can always iterate the result.
 *
 * @param {string} endpoint - e.g. "/api/v2/patients/getPatient?searchBy=2&…"
 * @returns {Promise<any>}
 */
async function cliniceaFetch(endpoint) {
  const token = await getClinicaToken();
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `${config.CLINICEA_API_BASE}${endpoint}${separator}api_key=${token}`;

  const res = await fetch(url);

  if (res.status === 401) {
    // Token expired — re-login and retry once
    await cliniceaLogin();
    const retryUrl = `${config.CLINICEA_API_BASE}${endpoint}${separator}api_key=${cliniceaToken}`;
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
// Patient ID extraction
// ---------------------------------------------------------------------------

/**
 * Try every known field name that may contain a patient ID.
 *
 * @param {object} obj
 * @returns {string|number|null}
 */
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

/**
 * Normalise a search result (single object or array) into
 * `{ patientID, patientName }`.
 *
 * SECURITY: no raw API data is logged — only structured event entries.
 *
 * @param {any} data - raw API response
 * @returns {{ patientID: any, patientName: string|null }|null}
 */
function extractPatientFromSearch(data) {
  if (data && !Array.isArray(data) && typeof data === 'object') {
    logEvent('debug', 'extractPatientFromSearch: object response', `keys=${Object.keys(data).join(',')}`);
    const pid = extractPatientId(data);
    if (pid) {
      const name =
        data.FullName ||
        data.Name ||
        data.PatientName ||
        [data.FirstName, data.LastName].filter(Boolean).join(' ') ||
        null;
      logEvent('info', 'Patient found via search: ' + (name || 'Unknown'), 'ID: ' + pid);
      return { patientID: pid, patientName: name };
    }
  }

  if (Array.isArray(data) && data.length > 0) {
    logEvent('debug', 'extractPatientFromSearch: array response', `length=${data.length}, keys=${Object.keys(data[0]).join(',')}`);
    const pat = data[0];
    const pid = extractPatientId(pat);
    if (pid) {
      const name =
        pat.FullName ||
        pat.Name ||
        pat.PatientName ||
        [pat.FirstName, pat.LastName].filter(Boolean).join(' ') ||
        null;
      logEvent('info', 'Patient found via search: ' + (name || 'Unknown'), 'ID: ' + pid);
      return { patientID: pid, patientName: name };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Patient lookup by phone
// ---------------------------------------------------------------------------

/**
 * Look up a patient by phone number.
 *
 * Strategy:
 *   1. v2/getPatient with searchBy=2, searchText=localNum, searchOption=+92
 *   2. Appointment-based matching across the last 30 days
 *
 * @param {string} phone
 * @returns {Promise<{ patientID: any, patientName: string|null }|null>}
 */
async function findPatientByPhone(phone) {
  const cleanPhone = phone.replace(/[\s\-()]/g, '');
  const localNum = extractLocalNumber(cleanPhone);

  logEvent('info', 'Looking up phone: ' + cleanPhone, 'Local: ' + localNum);

  // Method 1: v2/getPatient — searches by mobile with country code
  try {
    const data = await cliniceaFetch(
      `/api/v2/patients/getPatient?searchBy=2&searchText=${encodeURIComponent(localNum)}&searchOption=%2B92`
    );
    logEvent('debug', 'v2/getPatient result', `type=${typeof data}, isArray=${Array.isArray(data)}`);
    const result = extractPatientFromSearch(data);
    if (result) {
      logEvent('info', 'Patient found via v2/getPatient: ' + result.patientName, 'ID: ' + result.patientID);
      return result;
    }
  } catch (e) {
    logEvent('warn', 'v2/getPatient error', e.message);
  }

  // Method 2: appointment-based matching with phone variants
  try {
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const syncDate = thirtyDaysAgo.toISOString().split('.')[0];

    const data = await cliniceaFetch(
      `/api/v2/appointments/getChanges?lastSyncDTime=${syncDate}&pageNo=1&pageSize=100`
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
        logEvent('info', 'Patient found via appointments: ' + patientName, 'ID: ' + match.PatientID);
        return { patientID: match.PatientID, patientName };
      }
    }
  } catch (e) {
    logEvent('warn', 'getChanges error', e.message);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Next appointment
// ---------------------------------------------------------------------------

/**
 * Retrieve the next upcoming (non-cancelled) appointment for a patient.
 *
 * @param {string|number} patientID
 * @returns {Promise<object|null>}
 */
async function getNextAppointmentForPatient(patientID) {
  const data = await cliniceaFetch(
    `/api/v2/appointments/getAppointmentsByPatient?patientID=${patientID}&appointmentType=0&pageNo=1&pageSize=10`
  );
  if (!Array.isArray(data) || data.length === 0) return null;

  const now = new Date();
  const upcoming = data
    .filter((a) => new Date(a.StartDateTime) >= now && a.AppointmentStatus !== 'Cancelled')
    .sort((a, b) => new Date(a.StartDateTime) - new Date(b.StartDateTime));

  return upcoming[0] || data[0];
}

// ---------------------------------------------------------------------------
// Full patient profile
// ---------------------------------------------------------------------------

/**
 * Fetch patient details, appointments, and bills in parallel. Results are
 * cached for `CACHE_TTL` ms.
 *
 * @param {string|number} patientId
 * @returns {Promise<object>}
 */
async function fetchProfileByPatientId(patientId) {
  const cached = profileCache.get(patientId);
  if (cached && Date.now() < cached.expiry) return cached.data;

  const [details, appointments, bills] = await Promise.all([
    cliniceaFetch(`/api/v3/patients/getPatientByID?patientID=${patientId}`),
    cliniceaFetch(`/api/v2/appointments/getAppointmentsByPatient?patientID=${patientId}&appointmentType=2&pageNo=1&pageSize=50`),
    cliniceaFetch(`/api/v2/bills/getBillsByPatient?patientID=${patientId}&billStatus=0&pageNo=1&pageSize=50`),
  ]);

  const pat = Array.isArray(details) ? (details[0] || {}) : (details || {});
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

  profileCache.set(patientId, { data: result, expiry: Date.now() + CACHE_TTL });
  return result;
}

// ---------------------------------------------------------------------------
// Patient field mapping
// ---------------------------------------------------------------------------

/**
 * Map a raw Clinicea patient object to a normalised shape.
 *
 * @param {object} p
 * @returns {object}
 */
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

// ---------------------------------------------------------------------------
// Full patient list (paginated cache load)
// ---------------------------------------------------------------------------

/**
 * Load the entire patient list from Clinicea (paginated), map each record, and
 * store in an in-memory cache. Skips if a load is already in progress.
 */
async function loadAllPatients() {
  if (patientCache.loading) return;
  patientCache.loading = true;

  const allPatients = [];
  let pageNo = 1;

  try {
    while (true) {
      const data = await cliniceaFetch(
        `/api/v1/patients?lastSyncDate=2000-01-01T00:00:00&intPageNo=${pageNo}`
      );
      const batch = Array.isArray(data) ? data : [];
      allPatients.push(...batch.map(mapPatientFields));
      if (batch.length < 100) break; // last page
      pageNo++;
      if (pageNo > 50) break; // safety limit (~5000 patients)
    }
    patientCache = {
      patients: allPatients,
      expiry: Date.now() + PATIENT_CACHE_TTL,
      loading: false,
      pages: pageNo,
    };
    logEvent('info', `Patient cache loaded: ${allPatients.length} patients (${pageNo} pages)`);
  } catch (err) {
    patientCache.loading = false;
    logEvent('error', 'Patient cache load failed', err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Appointment field mapping
// ---------------------------------------------------------------------------

/**
 * Map a raw Clinicea appointment object to a normalised shape.
 *
 * @param {object} a
 * @returns {object}
 */
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
// Appointments by date (cached)
// ---------------------------------------------------------------------------

/**
 * Fetch appointments for a given date string (YYYY-MM-DD).
 *
 * @param {string} date
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<object[]>}
 */
async function getAppointmentsByDate(date, forceRefresh = false) {
  const cached = appointmentDateCache.get(date);
  if (cached && Date.now() < cached.expiry && !forceRefresh) {
    return cached.data;
  }

  const data = await cliniceaFetch(
    `/api/v3/appointments/getAppointmentsByDate?appointmentDate=${encodeURIComponent(date)}&pageNo=1&pageSize=100`
  );
  logEvent(
    'info',
    `Clinicea appointments fetched for ${date}`,
    `type=${typeof data}, isArray=${Array.isArray(data)}, length=${Array.isArray(data) ? data.length : 'N/A'}`
  );
  const appointments = (Array.isArray(data) ? data : []).map(mapAppointmentFields);

  appointmentDateCache.set(date, { data: appointments, expiry: Date.now() + CACHE_TTL });
  return appointments;
}

// ---------------------------------------------------------------------------
// Cache accessors (for route handlers)
// ---------------------------------------------------------------------------

function getMeetingCache() {
  return meetingCache;
}

function getPatientCacheState() {
  return patientCache;
}

// ---------------------------------------------------------------------------
// Startup preloader
// ---------------------------------------------------------------------------

/**
 * Pre-warm today's appointment cache and the full patient list.
 * Call this once after the server has started listening.
 */
async function preloadCaches() {
  if (!isClinicaConfigured()) return;

  // Preload today's appointments
  try {
    const today = new Date().toISOString().split('T')[0];
    await getAppointmentsByDate(today);
    const cached = appointmentDateCache.get(today);
    const count = cached ? cached.data.length : 0;
    logEvent('info', `Preloaded ${count} appointments for today`);
  } catch (e) {
    logEvent('warn', 'Failed to preload today appointments', e.message);
  }

  // Preload patient list
  try {
    await loadAllPatients();
  } catch (e) {
    logEvent('warn', 'Failed to preload patient list', e.message);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  isClinicaConfigured,
  findPatientByPhone,
  getNextAppointmentForPatient,
  fetchProfileByPatientId,
  loadAllPatients,
  getAppointmentsByDate,
  mapPatientFields,
  mapAppointmentFields,
  extractPatientId,
  getMeetingCache,
  getPatientCacheState,
  // For startup preloading
  cliniceaFetch,
  preloadCaches,
};
