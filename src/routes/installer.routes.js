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
const fs = require('fs');
const archiver = require('archiver');

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

// ---------------------------------------------------------------------------
// GET /download/whatsapp-extension - download pre-configured extension zip
// ---------------------------------------------------------------------------
router.get('/download/whatsapp-extension', requireAuth, (req, res) => {
  // Resolve extension directory relative to project root
  const extDir = path.resolve(__dirname, '..', '..', 'whatsapp-extension');
  if (!fs.existsSync(extDir)) {
    return res.status(404).send('WhatsApp extension not found');
  }

  const host = req.get('host');
  const protocol = req.protocol;
  const serverUrl = protocol + '://' + host;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="WhatsApp_Extension.zip"'
  );

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) =>
    res.status(500).send('Zip error: ' + err.message)
  );
  archive.pipe(res);

  // Add all extension files, patching background.js and manifest.json
  const files = fs.readdirSync(extDir);
  for (const file of files) {
    const filePath = path.join(extDir, file);
    if (!fs.statSync(filePath).isFile()) continue;

    if (file === 'background.js') {
      let content = fs.readFileSync(filePath, 'utf8');
      content = content.replace(
        /const DEFAULT_SERVER_URL = '[^']*'/,
        "const DEFAULT_SERVER_URL = '" + serverUrl + "'"
      );
      if (config.EXTENSION_SECRET) {
        content = content.replace(
          /const DEFAULT_EXTENSION_KEY = '[^']*'/,
          "const DEFAULT_EXTENSION_KEY = '" + config.EXTENSION_SECRET + "'"
        );
      }
      archive.append(content, { name: file });
    } else if (file === 'manifest.json') {
      let content = fs.readFileSync(filePath, 'utf8');
      const manifest = JSON.parse(content);
      const hostPerm = serverUrl.replace(/\/$/, '') + '/*';
      if (
        Array.isArray(manifest.host_permissions) &&
        !manifest.host_permissions.includes(hostPerm)
      ) {
        manifest.host_permissions.push(hostPerm);
      }
      archive.append(JSON.stringify(manifest, null, 2), { name: file });
    } else {
      archive.file(filePath, { name: file });
    }
  }

  archive.finalize();
});

module.exports = router;
