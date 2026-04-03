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
// Cache eviction — prevent unbounded Map growth
// ---------------------------------------------------------------------------
const MAX_MEETING_CACHE = 200;
const MAX_PROFILE_CACHE = 200;
const MAX_APPOINTMENT_DATE_CACHE = 60;
const CACHE_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

function evictExpiredEntries(cache, maxSize) {
  const now = Date.now();
  // First pass: remove expired entries
  for (const [key, val] of cache) {
    if (now > val.expiry) cache.delete(key);
  }
  // Second pass: if still over max, remove oldest entries
  if (cache.size > maxSize) {
    const entries = [...cache.entries()].sort((a, b) => a[1].expiry - b[1].expiry);
    const toRemove = entries.slice(0, cache.size - maxSize);
    for (const [key] of toRemove) cache.delete(key);
  }
}

const cacheCleanupInterval = setInterval(() => {
  evictExpiredEntries(meetingCache, MAX_MEETING_CACHE);
  evictExpiredEntries(profileCache, MAX_PROFILE_CACHE);
  evictExpiredEntries(appointmentDateCache, MAX_APPOINTMENT_DATE_CACHE);
}, CACHE_CLEANUP_INTERVAL);
cacheCleanupInterval.unref(); // don't keep process alive for cleanup

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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('Clinicea API timeout (15s): ' + endpoint);
    throw e;
  }
  clearTimeout(timeout);

  if (res.status === 401) {
    // Token expired — re-login and retry once
    await cliniceaLogin();
    const retryUrl = `${config.CLINICEA_API_BASE}${endpoint}${separator}api_key=${cliniceaToken}`;
    const retryRes = await fetch(retryUrl, { signal: AbortSignal.timeout(15000) });
    if (retryRes.status === 204) return [];
    if (!retryRes.ok) throw new Error(`Clinicea API error ${retryRes.status} on retry: ${endpoint}`);
    return parseJsonSafe(await retryRes.text(), endpoint);
  }

  if (res.status === 204) return [];

  // Fail closed: non-OK responses are errors, not empty data
  if (!res.ok) {
    const preview = (await res.text().catch(() => '')).substring(0, 150);
    logEvent('error', `Clinicea API HTTP ${res.status}`, `${endpoint} | ${preview}`);
    throw new Error(`Clinicea API error ${res.status}: ${endpoint}`);
  }

  return parseJsonSafe(await res.text(), endpoint);
}

function parseJsonSafe(text, endpoint) {
  try {
    return JSON.parse(text);
  } catch {
    logEvent('warn', 'Clinicea API non-JSON response', `${endpoint} | ${text.substring(0, 100)}`);
    throw new Error('Clinicea API returned non-JSON: ' + endpoint);
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

  // Method 2: search in-memory patient cache (fast, no API calls)
  if (patientCache.patients && patientCache.patients.length > 0) {
    const variants = getPhoneVariants(cleanPhone);
    const cachedMatch = patientCache.patients.find(
      (p) => p.phone && variants.has(p.phone.replace(/[\s\-()]/g, ''))
    );
    if (cachedMatch) {
      logEvent('info', 'Patient found via cache: ' + cachedMatch.name, 'ID: ' + cachedMatch.patientID);
      return { patientID: cachedMatch.patientID, patientName: cachedMatch.name };
    }
  }

  // Method 3: appointment-based matching with phone variants (paginated API fallback)
  // Only if patient cache is empty/not loaded — otherwise the cache search above is sufficient
  if (!patientCache.patients || patientCache.patients.length === 0) {
    try {
      const today = new Date();
      const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      const syncDate = thirtyDaysAgo.toISOString().split('.')[0];
      const variants = getPhoneVariants(cleanPhone);

      // Time-budgeted paginated search: stop after match, empty page, or 5 seconds
      let match = null;
      const searchStart = Date.now();
      const SEARCH_BUDGET_MS = 5000;
      const MAX_PAGES = 5; // cap pages to avoid excessive API calls
      for (let pageNo = 1; !match && pageNo <= MAX_PAGES; pageNo++) {
        if (Date.now() - searchStart > SEARCH_BUDGET_MS) {
          logEvent('warn', 'Phone lookup time budget exceeded at page ' + pageNo);
          break;
        }
        let data;
        try {
          data = await cliniceaFetch(
            `/api/v2/appointments/getChanges?lastSyncDTime=${syncDate}&pageNo=${pageNo}&pageSize=100`
          );
        } catch (e) { break; } // API error — stop searching
        if (!Array.isArray(data) || data.length === 0) break;

        match = data.find((a) => {
          const p1 = (a.AppointmentWithPhone || '').replace(/[\s\-()]/g, '');
          const p2 = (a.PatientMobile || '').replace(/[\s\-()]/g, '');
          return variants.has(p1) || variants.has(p2);
        });

        if (data.length < 100) break; // last page
      }

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
    } catch (e) {
      logEvent('warn', 'getChanges error', e.message);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Patient lookup by name (for saved contacts where phone is unavailable)
// ---------------------------------------------------------------------------

/**
 * Look up a patient by name using the Clinicea API.
 *
 * Used when the call monitor sends a contact name instead of a phone number
 * (e.g. "contact:Asad" — Phone Link shows the saved name, not the number).
 *
 * @param {string} name - patient name to search
 * @returns {Promise<{ patientID: any, patientName: string|null, phone: string|null }|null>}
 */
async function findPatientByName(name) {
  if (!name || typeof name !== 'string') return null;
  const cleanName = name.trim();
  if (!cleanName) return null;

  logEvent('info', 'Looking up patient by name: ' + cleanName);

  // Method 1: v2/getPatient with searchBy=1 (name search)
  try {
    const data = await cliniceaFetch(
      `/api/v2/patients/getPatient?searchBy=1&searchText=${encodeURIComponent(cleanName)}`
    );
    const result = extractPatientFromSearch(data);
    if (result) {
      // Also extract phone from the raw data for Clinicea URL
      const raw = Array.isArray(data) ? data[0] : data;
      const phone = raw
        ? (raw.Mobile || raw.MobilePhone || raw.PatientMobile || raw.Phone || '')
        : '';
      logEvent('info', 'Patient found by name: ' + result.patientName, 'ID: ' + result.patientID + ' | Phone: ' + phone);
      return { ...result, phone: phone || null };
    }
  } catch (e) {
    logEvent('warn', 'findPatientByName v2/getPatient error', e.message);
  }

  // Method 2: search in-memory patient cache
  if (patientCache.patients && patientCache.patients.length > 0) {
    const lower = cleanName.toLowerCase();
    const match = patientCache.patients.find(
      (p) => p.name && p.name.toLowerCase().includes(lower)
    );
    if (match) {
      logEvent('info', 'Patient found by name (cache): ' + match.name, 'ID: ' + match.patientID);
      return { patientID: match.patientID, patientName: match.name, phone: match.phone || null };
    }
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
// Circuit breaker: track consecutive Clinicea failures
let cliniceaFailures = 0;
let cliniceaCircuitOpen = false;
let cliniceaCircuitResetAt = 0;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_RESET_MS = 60_000; // 1 minute cooldown

function checkCircuitBreaker() {
  if (cliniceaCircuitOpen && Date.now() > cliniceaCircuitResetAt) {
    cliniceaCircuitOpen = false;
    cliniceaFailures = 0;
    logEvent('info', 'Clinicea circuit breaker reset — retrying');
  }
  if (cliniceaCircuitOpen) {
    throw new Error('Clinicea circuit breaker open — too many failures, cooling down');
  }
}

function recordClinicaSuccess() { cliniceaFailures = 0; cliniceaCircuitOpen = false; }
function recordClinicaFailure() {
  cliniceaFailures++;
  if (cliniceaFailures >= CIRCUIT_THRESHOLD) {
    cliniceaCircuitOpen = true;
    cliniceaCircuitResetAt = Date.now() + CIRCUIT_RESET_MS;
    logEvent('error', `Clinicea circuit breaker OPEN after ${cliniceaFailures} failures — pausing for ${CIRCUIT_RESET_MS / 1000}s`);
  }
}

async function loadAllPatients() {
  if (patientCache.loading) return;
  checkCircuitBreaker();
  patientCache.loading = true;

  const allPatients = [];
  let pageNo = 1;
  const MAX_PAGES = 200;
  const CONCURRENT_BATCH = 5;
  const startTime = Date.now();

  // Incremental sync: if we have a previous cache, only fetch changes since last load
  const lastSync = patientCache.lastSync || '2000-01-01T00:00:00';
  const isIncremental = patientCache.patients.length > 0 && lastSync !== '2000-01-01T00:00:00';

  try {
    if (isIncremental) {
      // Incremental: fetch only changes since last sync
      const data = await cliniceaFetch(
        `/api/v1/patients?lastSyncDate=${encodeURIComponent(lastSync)}&intPageNo=1`
      );
      const changes = Array.isArray(data) ? data.map(mapPatientFields) : [];
      if (changes.length > 0) {
        // Merge changes into existing cache
        const phoneMap = new Map(patientCache.patients.map(p => [p.phone, p]));
        for (const p of changes) {
          if (p.phone) phoneMap.set(p.phone, p);
        }
        allPatients.push(...phoneMap.values());
        logEvent('info', `Patient cache incremental: ${changes.length} changes merged (${allPatients.length} total, ${Date.now() - startTime}ms)`);
      } else {
        // No changes — extend expiry
        patientCache.expiry = Date.now() + PATIENT_CACHE_TTL;
        patientCache.loading = false;
        logEvent('info', 'Patient cache still fresh — no changes');
        recordClinicaSuccess();
        return;
      }
    } else {
      // Full load
      while (pageNo <= MAX_PAGES) {
        const pageNos = [];
        for (let i = 0; i < CONCURRENT_BATCH && pageNo <= MAX_PAGES; i++, pageNo++) {
          pageNos.push(pageNo);
        }

        const results = await Promise.allSettled(
          pageNos.map(pn => cliniceaFetch(
            `/api/v1/patients?lastSyncDate=2000-01-01T00:00:00&intPageNo=${pn}`
          ))
        );

        let lastBatchSize = 0;
        let anyFailed = false;
        for (const result of results) {
          if (result.status === 'fulfilled') {
            const batch = Array.isArray(result.value) ? result.value : [];
            allPatients.push(...batch.map(mapPatientFields));
            lastBatchSize = batch.length;
          } else {
            anyFailed = true;
            logEvent('warn', 'Patient cache page failed', result.reason?.message || 'unknown');
          }
        }

        if (anyFailed) {
          logEvent('error', `Patient cache aborted at page ${pageNo} — keeping previous cache (${patientCache.patients.length} patients)`);
          patientCache.loading = false;
          recordClinicaFailure();
          return;
        }

        if (lastBatchSize < 100) break;
      }
    }

    const duration = Date.now() - startTime;
    patientCache = {
      patients: allPatients,
      expiry: Date.now() + PATIENT_CACHE_TTL,
      loading: false,
      pages: isIncremental ? patientCache.pages : pageNo - 1,
      lastSync: new Date().toISOString(),
    };
    recordClinicaSuccess();
    logEvent('info', `Patient cache ${isIncremental ? 'incremental' : 'full'}: ${allPatients.length} patients (${duration}ms)`);
  } catch (err) {
    patientCache.loading = false;
    recordClinicaFailure();
    logEvent('error', `Patient cache load failed (${Date.now() - startTime}ms): ${err.message}`);
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

/**
 * Get patient cache with stale-while-revalidate:
 * - If fresh: return cache
 * - If stale but has data: return stale data AND trigger background refresh
 * - If empty: trigger load (caller should await loadAllPatients)
 */
function getPatientCacheState() {
  // Trigger background revalidation if stale but has data
  if (patientCache.patients.length > 0 && Date.now() > patientCache.expiry && !patientCache.loading) {
    loadAllPatients().catch((e) => { logEvent('warn', 'Background patient refresh failed', e.message); });
  }
  return patientCache;
}

function clearPatientCache() {
  patientCache = { patients: [], expiry: 0, loading: false, pages: 0, lastSync: null };
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

  // Preload today's appointments (non-blocking — don't delay server startup)
  try {
    const today = new Date().toISOString().split('T')[0];
    getAppointmentsByDate(today).catch(() => {});
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
  findPatientByName,
  getNextAppointmentForPatient,
  fetchProfileByPatientId,
  loadAllPatients,
  getAppointmentsByDate,
  mapPatientFields,
  mapAppointmentFields,
  extractPatientId,
  getMeetingCache,
  getPatientCacheState,
  clearPatientCache,
  // For startup preloading
  cliniceaFetch,
  preloadCaches,
  // Health check accessors
  getProfileCacheSize: () => profileCache.size,
  getAppointmentDateCacheSize: () => appointmentDateCache.size,
  getCircuitBreakerState: () => ({
    open: cliniceaCircuitOpen,
    failures: cliniceaFailures,
    resetsAt: cliniceaCircuitOpen ? new Date(cliniceaCircuitResetAt).toISOString() : null,
  }),
};
