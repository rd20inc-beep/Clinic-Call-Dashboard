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
  <title>Login - Clinic Call Dashboard</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .login-box{background:#fff;padding:40px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.1);width:100%;max-width:380px}
    .login-box h1{font-size:22px;color:#1a1a2e;margin-bottom:24px;text-align:center}
    label{display:block;font-size:14px;font-weight:600;color:#333;margin-bottom:6px}
    input{width:100%;padding:10px 14px;border:1px solid #dee2e6;border-radius:6px;font-size:15px;margin-bottom:16px}
    input:focus{outline:none;border-color:#1a1a2e;box-shadow:0 0 0 2px rgba(26,26,46,0.15)}
    button{width:100%;padding:12px;background:#1a1a2e;color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer}
    button:hover{background:#2d2d5e}
  </style>
</head><body>
  <div class="login-box">
    <h1>Clinic Call Dashboard</h1>
    ${error}
    <form method="POST" action="/login">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required autofocus>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required>
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
