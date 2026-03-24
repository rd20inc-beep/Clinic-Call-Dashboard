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
const { setOnCall, updateActivity } = require('../sockets/index');

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
    if (agent) {
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

      lookupPromise
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
        .catch(() => {
          // Silently ignore patient lookup failures
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
// GET /api/calls - paginated call history
// ---------------------------------------------------------------------------
router.get('/api/calls', requireAuth, apiLimiter, (req, res) => {
  const isAdmin = req.session.role === 'admin';
  const agent = req.session.username;
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || undefined;

  const result = callsRepo.getCalls({ page, limit, agent, isAdmin });
  res.json(result);
});

module.exports = router;
