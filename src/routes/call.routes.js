'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireWebhookSecret } = require('../middleware/webhookAuth');
const { callLimiter, apiLimiter } = require('../middleware/rateLimit');
const { validateIncomingCallMw } = require('../middleware/validateRequest');
const { resolveAgent, rememberAgentIP } = require('../services/agentRegistry.service');
const { routeCallEvent } = require('../services/callRouter.service');
const { logEvent } = require('../services/logging.service');
const callsRepo = require('../db/calls.repo');
const { normalizePKPhone } = require('../utils/phone');
const { getClientIP } = require('../utils/security');
const { config, isClinicaConfigured } = require('../config/env');
const { setOnCall, clearOnCall, updateActivity } = require('../sockets/index');

// Clinicea service is loaded lazily to avoid circular deps or missing-module
// errors when the service has not been extracted yet.
let _clinicea = null;
function getClinicea() {
  if (!_clinicea) {
    try {
      _clinicea = require('../services/clinicea.service');
    } catch (e) {
      // Service not yet extracted — fall back to null
      _clinicea = null;
    }
  }
  return _clinicea;
}

// ---------------------------------------------------------------------------
// POST /incoming_call - webhook from call monitor
// ---------------------------------------------------------------------------
router.post(
  '/incoming_call',
  callLimiter,
  requireWebhookSecret,
  validateIncomingCallMw,
  (req, res) => {
    // 1. Extract sanitized fields
    const rawCaller = (req.validated && req.validated.From) || req.body.From || 'Unknown';
    const callSid = (req.validated && req.validated.CallSid) || req.body.CallSid || '';

    // 2. Detect contact name vs phone number
    const isContactName = rawCaller.startsWith('contact:');
    const contactName = isContactName ? rawCaller.slice(8).trim() : null;

    // 3. Normalize phone (skip for contact names)
    let caller = isContactName ? rawCaller : (rawCaller !== 'Unknown' ? normalizePKPhone(rawCaller) : rawCaller);

    // 4. Resolve agent
    const { agent, method: routingMethod } = resolveAgent(req);

    // 5. Remember IP for future resolution if agent was resolved explicitly
    if (agent && (routingMethod === 'explicit' || routingMethod === 'token')) {
      rememberAgentIP(req, agent);
    }

    // 6. Build Clinicea URL — use name search for contacts, phone search otherwise
    let cliniceaUrl = isContactName
      ? config.CLINICEA_BASE_URL + '?tp=pat&m=' + encodeURIComponent(contactName)
      : config.CLINICEA_BASE_URL + '?tp=pat&m=' + encodeURIComponent(caller);

    // 6. Insert call to DB
    const sourceIp = getClientIP(req);
    const { callId } = callsRepo.insertCall(
      caller,
      callSid,
      cliniceaUrl,
      agent,
      routingMethod,
      sourceIp
    );

    // 6b. Mark agent as busy (on call)
    // PC monitor can't signal call end, so clear any previous call first
    // (a new incoming call means the previous one must have ended)
    if (agent) {
      clearOnCall(agent);
      setOnCall(agent);
    }

    // 7. Route call event via callRouter (strict room targeting)
    const callEvent = {
      caller,
      callSid,
      cliniceaUrl,
      callId,
      agent: agent || null,
      timestamp: new Date().toISOString(),
    };

    const { agentSockets, adminSockets } = routeCallEvent('incoming_call', callEvent);

    // 9. Async Clinicea patient lookup + patient_info event
    const clinicea = getClinicea();
    if (isClinicaConfigured() && clinicea) {
      // Choose lookup method: by name for saved contacts, by phone otherwise
      const lookupPromise = isContactName && typeof clinicea.findPatientByName === 'function'
        ? clinicea.findPatientByName(contactName)
        : typeof clinicea.findPatientByPhone === 'function'
          ? clinicea.findPatientByPhone(caller)
          : Promise.resolve(null);

      // Timeout: abort if Clinicea API takes > 8 seconds
      const withTimeout = Promise.race([
        lookupPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Clinicea lookup timeout')), 8000))
      ]);

      withTimeout
        .then((patient) => {
          if (patient) {
            if (patient.patientName) {
              callsRepo.updatePatientName(callId, patient.patientName);
            }
            if (patient.patientID) {
              callsRepo.updatePatientId(callId, patient.patientID);
            }
            // If contact name lookup returned a phone, update the caller and Clinicea URL
            if (isContactName && patient.phone) {
              const resolvedPhone = normalizePKPhone(patient.phone);
              const updatedUrl = config.CLINICEA_BASE_URL +
                '?tp=pat&m=' + encodeURIComponent(resolvedPhone);
              routeCallEvent('patient_info', {
                caller: resolvedPhone,
                callId,
                agent: agent || null,
                patientName: patient.patientName,
                patientID: patient.patientID,
                cliniceaUrl: updatedUrl,
              });
            } else {
              routeCallEvent('patient_info', {
                caller,
                callId,
                agent: agent || null,
                patientName: patient.patientName,
                patientID: patient.patientID,
              });
            }
            logEvent(
              'info',
              'Patient identified: ' + (patient.patientName || 'Unknown'),
              isContactName ? 'Contact: ' + contactName : caller
            );
          }
        })
        .catch((e) => {
          console.error('[call] Patient lookup failed:', e.message);
        });
    }

    // 9. Log with safe metadata
    if (agent) {
      logEvent(
        'info',
        'Incoming call: ' + caller,
        'Agent: ' + agent + ' | Method: ' + routingMethod +
          ' | SID: ' + callSid +
          ' | Sockets: agent=' + agentSockets + ', admin=' + adminSockets
      );
    } else {
      logEvent(
        'warn',
        'Incoming call (no valid agent): ' + caller,
        'Method: ' + routingMethod +
          ' | SID: ' + callSid +
          ' | Admin sockets: ' + adminSockets
      );
    }

    // 10. Respond
    res.json({ status: 'ok', caller, cliniceaUrl });
  }
);

// ---------------------------------------------------------------------------
// POST /api/test-call - simulate incoming call from dashboard
// ---------------------------------------------------------------------------
router.post('/api/test-call', requireAuth, apiLimiter, (req, res) => {
  const caller = req.body.phone || '+920000000000';
  const agent = req.session.username;
  const cliniceaUrl = config.CLINICEA_BASE_URL +
    '?tp=pat&m=' + encodeURIComponent(caller);
  const callSid = 'test-' + Date.now();

  const { callId } = callsRepo.insertCall(
    caller,
    callSid,
    cliniceaUrl,
    agent,
    'test',
    null
  );

  const callEvent = {
    caller,
    callSid,
    cliniceaUrl,
    callId,
    agent,
    timestamp: new Date().toISOString(),
  };

  routeCallEvent('incoming_call', callEvent);
  logEvent('info', 'TEST CALL triggered by ' + agent + ': ' + caller, 'URL: ' + cliniceaUrl);
  res.json({ status: 'ok', callEvent });
});

// ---------------------------------------------------------------------------
// GET /api/calls - paginated call history with filters
//   ?page=1&limit=10
//   ?status=answered|missed|unknown  (filter by call_status)
//   ?agent=username                   (filter by agent, admin only)
//   ?direction=inbound|outbound       (filter by direction)
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD   (date range)
// ---------------------------------------------------------------------------
router.get('/api/calls', requireAuth, apiLimiter, (req, res) => {
  const { db } = require('../db/index');
  const isAdmin = req.session.role === 'admin';
  const sessionAgent = req.session.username;

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const offset = (page - 1) * limit;

  // Build WHERE clauses
  const conditions = [];
  const params = [];

  // Agent filter — agents can only see own calls
  if (!isAdmin || !req.query.agent) {
    if (!isAdmin) { conditions.push('agent = ?'); params.push(sessionAgent); }
  } else {
    conditions.push('agent = ?');
    params.push(req.query.agent);
  }

  // Status filter
  if (req.query.status) {
    conditions.push('call_status = ?');
    params.push(req.query.status);
  }

  // Direction filter
  if (req.query.direction) {
    conditions.push('direction = ?');
    params.push(req.query.direction);
  }

  // Date range filter
  if (req.query.from) {
    conditions.push('timestamp >= ?');
    params.push(req.query.from + ' 00:00:00');
  }
  if (req.query.to) {
    conditions.push('timestamp <= ?');
    params.push(req.query.to + ' 23:59:59');
  }

  // Disposition filter
  if (req.query.disposition) {
    if (req.query.disposition === 'no_disposition') {
      conditions.push('(disposition IS NULL OR disposition = "")');
    } else {
      conditions.push('disposition = ?');
      params.push(req.query.disposition);
    }
  }

  // Search by patient name or caller number
  if (req.query.search) {
    conditions.push('(patient_name LIKE ? OR caller_number LIKE ?)');
    params.push('%' + req.query.search + '%', '%' + req.query.search + '%');
  }

  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

  try {
    const total = db.prepare('SELECT COUNT(*) as c FROM calls' + where).get(...params).c;
    const calls = db.prepare('SELECT * FROM calls' + where + ' ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(...params, limit, offset);

    res.json({
      calls,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      filters: { status: req.query.status || null, agent: req.query.agent || null, direction: req.query.direction || null, from: req.query.from || null, to: req.query.to || null },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/calls/:id/direction — fix call direction (admin)
// ---------------------------------------------------------------------------
router.post('/api/calls/:id/direction', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const { direction } = req.body;
  if (!id || !direction) return res.json({ error: 'id and direction required' });
  if (direction !== 'inbound' && direction !== 'outbound') return res.json({ error: 'Invalid direction' });
  const { db } = require('../db/index');
  db.prepare('UPDATE calls SET direction = ? WHERE id = ?').run(direction, id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/calls/:id/disposition — set call outcome
// ---------------------------------------------------------------------------
router.post('/api/calls/:id/disposition', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const { disposition } = req.body;
  if (!id || !disposition) return res.json({ error: 'id and disposition required' });
  const valid = ['appointment_booked', 'follow_up_needed', 'wrong_number', 'no_answer', 'existing_patient', 'inquiry_only', 'other'];
  if (!valid.includes(disposition)) return res.json({ error: 'Invalid disposition' });
  callsRepo.updateDisposition(id, disposition);

  // If appointment booked, alert agent to send instant confirmation
  if (disposition === 'appointment_booked') {
    try {
      const { db } = require('../db/index');
      const call = db.prepare('SELECT caller_number, patient_name, agent FROM calls WHERE id = ?').get(id);
      console.log('[disposition] appointment_booked for call', id, 'agent:', call?.agent, 'number:', call?.caller_number);

      if (call && call.caller_number) {
        const phone = call.caller_number.replace(/[\s\-()]/g, '');
        const apt = db.prepare(
          "SELECT * FROM wa_appointment_tracking WHERE patient_phone LIKE ? AND appointment_date > datetime('now') ORDER BY appointment_date ASC LIMIT 1"
        ).get('%' + phone.slice(-10) + '%');

        console.log('[disposition] appointment match:', apt ? `${apt.patient_name} on ${apt.appointment_date}` : 'NONE');

        const { getIO } = require('../sockets/index');
        const io = getIO();
        console.log('[disposition] IO:', io ? 'OK' : 'NULL', '| agent room: agent:' + call.agent);

        if (io && call.agent) {
          const payload = {
            callId: id,
            patientName: apt ? (apt.patient_name || call.patient_name) : (call.patient_name || call.caller_number),
            patientPhone: apt ? apt.patient_phone : call.caller_number,
            appointmentDate: apt ? apt.appointment_date : null,
            doctorName: apt ? apt.doctor_name : null,
            service: apt ? apt.service : null,
            appointmentId: apt ? apt.id : null,
            hasAppointment: !!apt,
          };
          io.to('agent:' + call.agent).emit('confirm_appointment', payload);
          // Also emit to admin room so they see it
          io.to('role:admin').emit('confirm_appointment', payload);
          console.log('[disposition] confirm_appointment emitted to agent:' + call.agent, JSON.stringify(payload));
        }
      }
    } catch (e) { console.error('[disposition] Appointment alert failed:', e.message); }
  }

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/calls/check-appointment — look up upcoming appointment by phone
// ---------------------------------------------------------------------------
router.get('/api/calls/check-appointment', requireAuth, (req, res) => {
  const phone = (req.query.phone || '').replace(/[\s\-()]/g, '');
  if (!phone) return res.json({ appointment: null });
  try {
    const { db } = require('../db/index');
    const apt = db.prepare(
      "SELECT * FROM wa_appointment_tracking WHERE patient_phone LIKE ? AND appointment_date > datetime('now') ORDER BY appointment_date ASC LIMIT 1"
    ).get('%' + phone.slice(-10) + '%');
    res.json({ appointment: apt || null });
  } catch (e) {
    res.json({ appointment: null, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/calls/send-confirmation — agent sends instant confirmation (no approval queue)
// ---------------------------------------------------------------------------
router.post('/api/calls/send-confirmation', requireAuth, (req, res) => {
  const { appointmentId, patientPhone, patientName, appointmentDate, doctorName, service } = req.body;
  if (!appointmentId || !patientPhone) return res.json({ error: 'appointmentId and patientPhone required' });

  try {
    const waRepo = require('../db/whatsapp.repo');
    const templates = require('../services/messageTemplates');
    const { parseLocalDate, formatDatePK, formatTimePK } = require('../services/whatsapp.service');

    const aptDate = parseLocalDate ? parseLocalDate(appointmentDate) : new Date(appointmentDate);
    const aptLine = `${formatDatePK ? formatDatePK(aptDate) : aptDate.toDateString()} at ${formatTimePK ? formatTimePK(aptDate) : aptDate.toTimeString().slice(0,5)}`;
    const fullLine = aptLine + (service ? ` — ${service}` : '') + (doctorName ? ` (${doctorName})` : '');

    const msg = templates.applyTemplate('confirmation', {
      name: patientName || 'Patient',
      appointments: fullLine,
    });

    // Insert as 'approved' so it sends immediately (skip pending approval)
    waRepo.insertMessage(patientPhone, null, 'out', msg, 'confirmation', 'approved', req.session.username || null);

    // Mark the appointment tracking record as confirmation sent
    const { db } = require('../db/index');
    db.prepare("UPDATE wa_appointment_tracking SET confirmation_sent = 1, confirmation_sent_at = datetime('now') WHERE id = ?").run(appointmentId);

    logEvent('info', `Instant confirmation sent by ${req.session.username} for ${patientName} (${patientPhone})`);
    res.json({ ok: true, message: 'Confirmation sent' });
  } catch (e) {
    console.error('[send-confirmation]', e.message);
    res.json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/calls/:id/notes — add/update agent notes on a call
// ---------------------------------------------------------------------------
router.post('/api/calls/:id/notes', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const { notes } = req.body;
  if (!id) return res.json({ error: 'id required' });
  callsRepo.updateNotes(id, (notes || '').substring(0, 500));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/agent/set-status — agent sets own status (available/busy/break)
// ---------------------------------------------------------------------------
router.post('/api/agent/set-status', requireAuth, (req, res) => {
  const { status } = req.body;
  const valid = ['available', 'busy', 'on_break', 'offline'];
  if (!status || !valid.includes(status)) return res.json({ error: 'Valid status: ' + valid.join(', ') });
  try {
    const usersRepo = require('../db/users.repo');
    usersRepo.setStatus(req.session.username, status);
    const { updateActivity } = require('../sockets/index');
    updateActivity(req.session.username);
  } catch (e) { console.error('[call] setStatus failed for ' + req.session.username + ':', e.message); }
  res.json({ ok: true, status });
});

module.exports = router;
