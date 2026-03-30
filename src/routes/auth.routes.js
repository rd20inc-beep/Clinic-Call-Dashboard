'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, verifyPassword } = require('../middleware/auth');
const { validateLoginMw } = require('../middleware/validateRequest');
const { loginLimiter } = require('../middleware/rateLimit');
const { getUsers } = require('../config/env');

// ---------------------------------------------------------------------------
// GET /login - serve login page HTML
// ---------------------------------------------------------------------------
router.get('/login', (req, res) => {
  const error = req.query.error
    ? '<p style="color:#e74c3c;margin-bottom:16px;">Invalid username or password</p>'
    : '';

  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Dr. Nakhoda's Skin Institute — Dashboard Login</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .login-box{background:#fff;padding:40px;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.3);width:100%;max-width:400px}
    .login-logo{text-align:center;margin-bottom:24px;}
    .login-logo .icon{font-size:36px;margin-bottom:8px;}
    .login-logo h1{font-size:20px;font-weight:800;color:#0f172a;letter-spacing:-0.02em;line-height:1.3;}
    .login-logo p{font-size:12px;color:#94a3b8;margin-top:4px;font-weight:500;}
    label{display:block;font-size:13px;font-weight:600;color:#475569;margin-bottom:6px}
    input{width:100%;padding:11px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;margin-bottom:16px;font-family:inherit;transition:border-color 0.15s;}
    input:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,0.1)}
    button{width:100%;padding:12px;background:#0f172a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;transition:background 0.15s;}
    button:hover{background:#1e293b}
    .error{color:#ef4444;font-size:13px;margin-bottom:16px;text-align:center;}
  </style>
</head><body>
  <div class="login-box">
    <div class="login-logo">
      <img src="/logo.png" alt="Dr. Nakhoda's Skin Institute" style="max-width:240px;margin-bottom:12px;">
      <p>Call Management Dashboard</p>
    </div>
    ${error ? '<div class="error">' + error + '</div>' : ''}
    <form method="POST" action="/login">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required autofocus placeholder="Enter your username">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required placeholder="Enter your password">
      <button type="submit">Sign In</button>
    </form>
  </div>
</body></html>`);
});

// ---------------------------------------------------------------------------
// POST /login - authenticate user
// ---------------------------------------------------------------------------
router.post('/login', loginLimiter, validateLoginMw, async (req, res) => {
  const { username, password } = req.validated;

  const users = getUsers();
  const user = users[username];

  if (!user) {
    return res.redirect('/login?error=1');
  }

  const valid = await verifyPassword(username, password);
  if (!valid) {
    return res.redirect('/login?error=1');
  }

  req.session.loggedIn = true;
  req.session.username = username;
  req.session.role = user.role;

  // Record login timestamp
  try {
    const usersRepo = require('../db/users.repo');
    usersRepo.recordLogin(username);
  } catch (e) { console.error('[auth] recordLogin failed for ' + username + ':', e.message); }

  return res.redirect('/');
});

// ---------------------------------------------------------------------------
// GET /logout - destroy session and redirect
// ---------------------------------------------------------------------------
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------------------------------------------------------------------------
// GET /api/me - return current user info
// ---------------------------------------------------------------------------
router.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.session.username, role: req.session.role });
});

module.exports = router;
