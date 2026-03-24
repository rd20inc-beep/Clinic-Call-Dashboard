'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { config, getMonitorTokens, getUsers } = require('../config/env');
const {
  generateMonitorScript,
  generateInstallerBat,
  getMonitorBaseUrl,
} = require('../services/installer.service');
const { timingSafeEqual } = require('../utils/security');
const path = require('path');

// ---------------------------------------------------------------------------
// GET /api/monitor-script - serve raw PS1 monitor script
//   Authenticated via webhook secret in query param or header.
// ---------------------------------------------------------------------------
router.get('/api/monitor-script', (req, res) => {
  // Auth: accept secret from query string or header
  const secret = req.query.secret || req.headers['x-webhook-secret'];
  if (
    !config.WEBHOOK_SECRET ||
    !secret ||
    !timingSafeEqual(secret, config.WEBHOOK_SECRET)
  ) {
    return res.status(403).send('Forbidden');
  }

  const agent = req.query.agent || '';
  const users = getUsers();
  if (!agent || !users[agent]) {
    return res.status(400).send('Invalid agent');
  }

  // Look up per-agent monitor token
  const monitorTokens = getMonitorTokens();
  const monitorToken = req.query.token || monitorTokens[agent] || '';

  const baseUrl = getMonitorBaseUrl(req, config.MONITOR_URL);
  const script = generateMonitorScript(
    baseUrl,
    config.WEBHOOK_SECRET,
    agent,
    monitorToken
  );

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(script);
});

// ---------------------------------------------------------------------------
// GET /download/call-monitor - download pre-configured BAT installer
// ---------------------------------------------------------------------------
router.get('/download/call-monitor', requireAuth, (req, res) => {
  const baseUrl = getMonitorBaseUrl(req, config.MONITOR_URL);
  const agent = req.session.username;

  // Look up per-agent monitor token
  const monitorTokens = getMonitorTokens();
  const monitorToken = monitorTokens[agent] || '';

  const bat = generateInstallerBat(
    baseUrl,
    config.WEBHOOK_SECRET,
    agent,
    monitorToken
  );

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="Install_Call_Monitor_' + agent + '.bat"'
  );
  res.send(bat);
});

module.exports = router;
