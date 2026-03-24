'use strict';

const express = require('express');
const router = express.Router();
const { requireWebhookSecret } = require('../middleware/webhookAuth');
const { heartbeatLimiter } = require('../middleware/rateLimit');
const { validateHeartbeatMw } = require('../middleware/validateRequest');
const {
  resolveAgent,
  rememberAgentIP,
  recordHeartbeat,
  getAllHeartbeats,
  isInStartupGrace,
} = require('../services/agentRegistry.service');
const { emitMonitorStatus } = require('../services/callRouter.service');
const { logEvent } = require('../services/logging.service');
const { requireAuth } = require('../middleware/auth');
const { getClientIP } = require('../utils/security');

// ---------------------------------------------------------------------------
// POST /heartbeat - monitor heartbeat from agent PCs
// ---------------------------------------------------------------------------
router.post(
  '/heartbeat',
  heartbeatLimiter,
  requireWebhookSecret,
  validateHeartbeatMw,
  (req, res) => {
    const start = Date.now();

    // 1. Resolve agent identity
    const { agent, method } = resolveAgent(req);

    // 2. Remember IP mapping for explicit/token resolutions
    if (agent && (method === 'explicit' || method === 'token')) {
      rememberAgentIP(req, agent);
    }

    // 3. Record heartbeat
    const { key, wasDown } = recordHeartbeat(agent);

    // 3b. Update presence engine (keeps agent online even without socket)
    try {
      const { recordHeartbeatPresence } = require('../sockets/index');
      recordHeartbeatPresence(agent);
    } catch (e) { /* ignore during early init */ }

    // 4. Emit monitor status to appropriate rooms
    emitMonitorStatus(agent, true);

    // 5. Log connection events (skip routine alive logs to avoid spam)
    const ip = getClientIP(req);
    if (agent) {
      if (wasDown) {
        logEvent('info', 'Call monitor connected: ' + agent, 'IP: ' + ip);
      }
    } else {
      // Unidentified heartbeat — suppress from dashboard (debug only)
      if (wasDown) {
        console.log('[heartbeat] Unidentified source IP: ' + ip + ' | Agent: ' + ((req.body && req.body.Agent) || 'empty'));
      }
    }

    // Warn if heartbeat processing was slow
    const elapsed = Date.now() - start;
    if (elapsed > 500) {
      logEvent('warn', 'Heartbeat slow: ' + elapsed + 'ms', 'agent: ' + key);
    }

    // 6. Respond
    res.json({ status: 'ok' });
  }
);

// ---------------------------------------------------------------------------
// GET /api/monitor-status - per-agent or admin-aggregated status
// ---------------------------------------------------------------------------
router.get('/api/monitor-status', requireAuth, (req, res) => {
  const agent = req.session.username;
  const isAdmin = req.session.role === 'admin';
  const inGrace = isInStartupGrace();
  const agentHeartbeats = getAllHeartbeats();

  if (isAdmin) {
    const anyAlive = Object.values(agentHeartbeats).some((s) => s.alive);
    const hasAnyData = Object.keys(agentHeartbeats).length > 0;
    return res.json({
      alive: anyAlive || (inGrace && !hasAnyData),
      agents: agentHeartbeats,
    });
  }

  // Agent sees own monitor or _default (untagged)
  const agentState = agentHeartbeats[agent] || agentHeartbeats['_default'];
  const alive = !!(agentState && agentState.alive) || (inGrace && !agentState);
  res.json({ alive });
});

module.exports = router;
