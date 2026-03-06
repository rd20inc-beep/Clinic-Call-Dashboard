require('dotenv').config();
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DOCTOR_PHONE = process.env.DOCTOR_PHONE;
const CLINICEA_BASE_URL = process.env.CLINICEA_BASE_URL || 'https://app.clinicea.com/clinic.aspx';
const SESSION_SECRET = process.env.SESSION_SECRET;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!SESSION_SECRET) {
  console.error('ERROR: SESSION_SECRET is not set in .env');
  process.exit(1);
}

// Trust Nginx proxy (needed for secure cookies behind reverse proxy)
app.set('trust proxy', 1);

// --- Hardcoded Login Credentials ---
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'clinicea2025';

// Clinicea API configuration
const CLINICEA_API_KEY = process.env.CLINICEA_API_KEY;
const CLINICEA_STAFF_USERNAME = process.env.CLINICEA_STAFF_USERNAME;
const CLINICEA_STAFF_PASSWORD = process.env.CLINICEA_STAFF_PASSWORD;
const CLINICEA_API_BASE = 'https://api.clinicea.com';

// --- SQLite Setup ---
const db = new Database('calls.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caller_number TEXT NOT NULL,
    call_sid TEXT,
    clinicea_url TEXT,
    patient_name TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Add patient_name and patient_id columns if missing (existing DBs)
try { db.exec('ALTER TABLE calls ADD COLUMN patient_name TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE calls ADD COLUMN patient_id TEXT'); } catch (e) { /* already exists */ }

// One-time migration: normalize all existing 03XXX numbers to +92XXX
const oldNumbers = db.prepare("SELECT id, caller_number FROM calls WHERE caller_number LIKE '03%' AND length(caller_number) = 11").all();
if (oldNumbers.length > 0) {
  const updateNum = db.prepare('UPDATE calls SET caller_number = ? WHERE id = ?');
  const migrate = db.transaction(() => {
    for (const row of oldNumbers) {
      updateNum.run('+92' + row.caller_number.substring(1), row.id);
    }
  });
  migrate();
  console.log(`[MIGRATION] Normalized ${oldNumbers.length} phone numbers from 03XXX to +92XXX`);
}

const insertCall = db.prepare(
  'INSERT INTO calls (caller_number, call_sid, clinicea_url) VALUES (?, ?, ?)'
);
const updateCallPatientName = db.prepare(
  'UPDATE calls SET patient_name = ? WHERE id = ?'
);
const updateCallPatientId = db.prepare(
  'UPDATE calls SET patient_id = ? WHERE id = ?'
);
const PAGE_SIZE = 10;
const countCalls = db.prepare('SELECT COUNT(*) as total FROM calls');
const paginatedCalls = db.prepare(
  'SELECT * FROM calls ORDER BY timestamp DESC LIMIT ? OFFSET ?'
);

// --- Server Event Log (pushed to dashboard) ---
const eventLog = []; // last 50 events kept in memory
const MAX_LOG = 50;

function logEvent(type, message, details) {
  const entry = { type, message, details: details || null, time: new Date().toISOString() };
  eventLog.push(entry);
  if (eventLog.length > MAX_LOG) eventLog.shift();
  io.emit('server_log', entry);
  // Also log to console
  const prefix = type === 'error' ? '[ERROR]' : type === 'warn' ? '[WARN]' : '[INFO]';
  console.log(`${prefix} ${message}${details ? ' | ' + details : ''}`);
}

// --- Middleware ---
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// --- Auth ---
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login');
}

// Login page
app.get('/login', (req, res) => {
  const error = req.query.error ? '<p style="color:#e74c3c;margin-bottom:16px;">Invalid username or password</p>' : '';
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

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Webhook auth middleware
function requireWebhookSecret(req, res, next) {
  if (!WEBHOOK_SECRET) return next();
  const provided = req.headers['x-webhook-secret'] || req.body.secret;
  if (provided !== WEBHOOK_SECRET) {
    logEvent('error', 'Webhook auth failed — invalid secret', 'IP: ' + (req.ip || req.connection.remoteAddress));
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }
  next();
}

// Normalize Pakistani phone numbers to +92 format
function normalizePKPhone(phone) {
  const clean = phone.replace(/[\s\-\(\)]/g, '');
  if (clean.startsWith('03') && clean.length === 11) return '+92' + clean.substring(1);
  if (clean.startsWith('92') && !clean.startsWith('+') && clean.length === 12) return '+' + clean;
  return clean;
}

// Call webhook - secured with WEBHOOK_SECRET
app.post('/incoming_call', requireWebhookSecret, (req, res) => {
  const rawCaller = req.body.From || 'Unknown';
  const caller = rawCaller !== 'Unknown' ? normalizePKPhone(rawCaller) : rawCaller;
  const callSid = req.body.CallSid || '';

  // Build Clinicea patient lookup URL
  const cliniceaUrl = `${CLINICEA_BASE_URL}?tp=pat&m=${encodeURIComponent(caller)}`;

  // Log to database
  const result = insertCall.run(caller, callSid, cliniceaUrl);
  const callId = result.lastInsertRowid;

  logEvent('info', 'Incoming call: ' + caller, 'SID: ' + callSid);

  // Push to doctor's dashboard via WebSocket
  io.emit('incoming_call', {
    caller,
    callSid,
    cliniceaUrl,
    callId,
    timestamp: new Date().toISOString()
  });

  // Async: look up patient name and push update to dashboard
  if (isClinicaConfigured()) {
    findPatientByPhone(caller).then(patient => {
      if (patient) {
        if (patient.patientName) {
          updateCallPatientName.run(patient.patientName, callId);
        }
        if (patient.patientID) {
          updateCallPatientId.run(patient.patientID, callId);
        }
        io.emit('patient_info', { caller, callId, patientName: patient.patientName, patientID: patient.patientID });
        logEvent('info', 'Patient identified: ' + (patient.patientName || 'Unknown'), caller);
      }
    }).catch(() => {});
  }

  // Respond with OK
  res.json({ status: 'ok', caller, cliniceaUrl });
});

// --- Monitor Heartbeat ---
let lastHeartbeat = 0;
let monitorAlive = false;

app.post('/heartbeat', requireWebhookSecret, (req, res) => {
  const wasDown = !monitorAlive;
  lastHeartbeat = Date.now();
  monitorAlive = true;
  io.emit('monitor_status', { alive: true });
  if (wasDown) logEvent('info', 'Call monitor connected (heartbeat received)');
  res.json({ status: 'ok' });
});

// Check every 15s if monitor went stale — proactively push "disconnected"
setInterval(() => {
  if (monitorAlive && (Date.now() - lastHeartbeat) > 45000) {
    monitorAlive = false;
    io.emit('monitor_status', { alive: false });
    logEvent('warn', 'Call monitor disconnected (no heartbeat for 45s)');
  }
}, 15000);

app.get('/api/monitor-status', requireAuth, (req, res) => {
  res.json({ alive: monitorAlive });
});

// --- Download call monitor installer (pre-configured .bat) ---
app.get('/download/call-monitor', requireAuth, (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol;
  const baseUrl = `${protocol}://${host}`;
  const bat = generateInstallerBat(baseUrl, WEBHOOK_SECRET);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="Install_Call_Monitor.bat"');
  res.send(bat);
});

function generateMonitorScript(baseUrl, secret) {
  return `# Clinicea Call Monitor — Phone Link + WhatsApp
$ErrorActionPreference = 'Continue'
$webhookUrl = "${baseUrl}/incoming_call"
$heartbeatUrl = "${baseUrl}/heartbeat"
$webhookSecret = "${secret}"
$logFile = "$env:APPDATA\\ClinicaCallMonitor\\monitor.log"

function Write-Log { param([string]$Msg)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    try { Add-Content -Path $logFile -Value "[$ts] $Msg" -ErrorAction SilentlyContinue } catch {}
}

# Trim log if > 1MB
if (Test-Path $logFile) {
    try { if ((Get-Item $logFile).Length -gt 1MB) { Get-Content $logFile -Tail 200 | Set-Content "$logFile.tmp"; Move-Item "$logFile.tmp" $logFile -Force } } catch {}
}

Write-Log "=== Monitor starting ==="

try {
    [void][Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
    Write-Log "WinRT APIs loaded"
} catch {
    Write-Log "FATAL: Cannot load WinRT APIs (need Windows 10 1803+): $_"
    exit 1
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]

function Await-AsyncOp { param($AsyncOp, [Type]$ResultType)
    $asTask = $script:asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($AsyncOp))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}

$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current

$accessOk = $false
for ($i = 1; $i -le 3; $i++) {
    try {
        $status = Await-AsyncOp ($listener.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
        if ($status -eq [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]::Allowed) {
            $accessOk = $true; Write-Log "Notification access granted"; break
        }
        Write-Log "Access denied (attempt $i): $status"
    } catch { Write-Log "Access error (attempt $i): $_" }
    Start-Sleep -Seconds 5
}
if (-not $accessOk) { Write-Log "FATAL: Notification access denied. Enable at Settings > Privacy > Notifications"; exit 1 }

$seenIds = @{}; $recentCalls = @{}
$lastHeartbeat = [DateTimeOffset]::Now.ToUnixTimeSeconds() - 999
Write-Log "Monitoring calls (Phone Link + WhatsApp)..."

while ($true) {
    try {
        $notifications = Await-AsyncOp ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) ([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])
        foreach ($notif in $notifications) {
            $nid = $notif.Id
            if ($seenIds.ContainsKey($nid)) { continue }
            $seenIds[$nid] = $true
            try { $appName = $notif.AppInfo.DisplayInfo.DisplayName } catch { continue }
            if ($appName -notmatch "Phone Link|Your Phone|Phone|WhatsApp") { continue }
            try {
                $binding = $notif.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
                if ($null -eq $binding) { continue }
                $textElements = $binding.GetTextElements()
                $allTexts = @(); foreach ($elem in $textElements) { $allTexts += $elem.Text }
                $fullText = $allTexts -join " "
                $isCall = $false
                if ($appName -match "Phone Link|Your Phone|Phone") {
                    $isCall = $fullText -match "incoming|call|calling|ringing|answer|decline"
                }
                if ($appName -match "WhatsApp") {
                    $isCall = $fullText -match "voice call|video call|incoming|calling|ringing|audio call"
                }
                if ($isCall) {
                    $numberPart = $fullText -replace '(?i)(incoming\\s*(voice\\s*|video\\s*|audio\\s*)?call|calling|ringing|answer|decline|voice\\s*call|video\\s*call|audio\\s*call)', ''
                    $numberPart = $numberPart.Trim()
                    $phone = $null
                    if ($numberPart -match '(\\+?[\\d][\\d\\s\\-\\(\\)]{7,18}[\\d])') {
                        $phone = $Matches[1] -replace '[\\s\\-\\(\\)]', ''
                    }
                    if ($phone) {
                        $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
                        if ($recentCalls.ContainsKey($phone) -and ($now - $recentCalls[$phone]) -lt 30) { continue }
                        $recentCalls[$phone] = $now
                        Write-Log "CALL [$appName]: $phone"
                        $body = "From=$([uri]::EscapeDataString($phone))&CallSid=local-$now"
                        try {
                            Invoke-RestMethod -Uri $webhookUrl -Method POST -Body $body -ContentType "application/x-www-form-urlencoded" -Headers @{ "X-Webhook-Secret" = $webhookSecret } -TimeoutSec 5 | Out-Null
                            Write-Log "Webhook sent OK"
                        } catch { Write-Log "Webhook error: $_" }
                    } else {
                        Write-Log "Call [$appName] no number: $fullText"
                    }
                }
            } catch {}
        }
        if ($seenIds.Count -gt 1000) { $seenIds = @{} }
        $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
        $expired = $recentCalls.Keys | Where-Object { ($now - $recentCalls[$_]) -gt 60 }
        foreach ($k in $expired) { $recentCalls.Remove($k) }
    } catch { Write-Log "Error: $_" }

    $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
    if (($now - $lastHeartbeat) -ge 30) {
        try {
            Invoke-RestMethod -Uri $heartbeatUrl -Method POST -Headers @{ "X-Webhook-Secret" = $webhookSecret } -TimeoutSec 5 | Out-Null
            $lastHeartbeat = $now
        } catch {}
    }
    Start-Sleep -Seconds 1
}
`;
}

function generateInstallerBat(baseUrl, secret) {
  const monitorScript = generateMonitorScript(baseUrl, secret);
  const monitorB64 = Buffer.from(monitorScript, 'utf8').toString('base64');
  const monitorLines = monitorB64.match(/.{1,76}/g) || [];

  // VBS launcher that finds PS1 via %APPDATA%
  const vbsScript = 'Set ws = CreateObject("WScript.Shell")\r\ndir = ws.ExpandEnvironmentStrings("%APPDATA%") & "\\ClinicaCallMonitor"\r\nws.Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\\call_monitor.ps1""", 0, False\r\n';
  const vbsB64 = Buffer.from(vbsScript, 'utf8').toString('base64');
  const vbsLines = vbsB64.match(/.{1,76}/g) || [];

  let bat = '@echo off\r\n';
  bat += 'title Clinicea Call Monitor - Installer\r\n';
  bat += 'echo.\r\n';
  bat += 'echo  === Clinicea Call Monitor - Installer ===\r\n';
  bat += 'echo.\r\n\r\n';

  bat += 'set "DIR=%APPDATA%\\ClinicaCallMonitor"\r\n';
  bat += 'if not exist "%DIR%" mkdir "%DIR%"\r\n';
  bat += 'echo  [1/4] Install folder: %DIR%\r\n\r\n';

  // Write monitor PS1 via certutil base64 decode
  bat += '> "%TEMP%\\cm_b64.tmp" (\r\n';
  bat += 'echo -----BEGIN CERTIFICATE-----\r\n';
  for (const line of monitorLines) {
    bat += 'echo ' + line + '\r\n';
  }
  bat += 'echo -----END CERTIFICATE-----\r\n';
  bat += ')\r\n';
  bat += 'certutil -decode "%TEMP%\\cm_b64.tmp" "%DIR%\\call_monitor.ps1" >nul 2>&1\r\n';
  bat += 'del "%TEMP%\\cm_b64.tmp" 2>nul\r\n';
  bat += 'echo  [2/4] Monitor script installed\r\n\r\n';

  // Write VBS launcher via certutil
  bat += '> "%TEMP%\\vbs_b64.tmp" (\r\n';
  bat += 'echo -----BEGIN CERTIFICATE-----\r\n';
  for (const line of vbsLines) {
    bat += 'echo ' + line + '\r\n';
  }
  bat += 'echo -----END CERTIFICATE-----\r\n';
  bat += ')\r\n';
  bat += 'certutil -decode "%TEMP%\\vbs_b64.tmp" "%DIR%\\start_monitor.vbs" >nul 2>&1\r\n';
  bat += 'del "%TEMP%\\vbs_b64.tmp" 2>nul\r\n\r\n';

  // Copy VBS to Windows Startup
  bat += 'copy /Y "%DIR%\\start_monitor.vbs" "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\ClinicaCallMonitor.vbs" >nul\r\n';
  bat += 'echo  [3/4] Added to Windows startup (auto-runs on login)\r\n\r\n';

  // Start now
  bat += 'start "" wscript.exe "%DIR%\\start_monitor.vbs"\r\n';
  bat += 'echo  [4/4] Monitor started!\r\n\r\n';

  bat += 'echo.\r\n';
  bat += 'echo  Installation complete!\r\n';
  bat += 'echo  The monitor runs silently in the background.\r\n';
  bat += 'echo  It auto-starts every time you log into Windows.\r\n';
  bat += 'echo  Detects: Phone Link calls + WhatsApp calls\r\n';
  bat += 'echo.\r\n';
  bat += 'echo  Dashboard: ' + baseUrl + '\r\n';
  bat += 'echo  Log file:  %DIR%\\monitor.log\r\n';
  bat += 'echo.\r\n';
  bat += 'pause\r\n';

  return bat;
}

// Protected dashboard - serve static files behind auth
app.get('/', requireAuth, (req, res, next) => next());
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

// API - paginated call history
app.get('/api/calls', requireAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || PAGE_SIZE));
  const offset = (page - 1) * limit;
  const { total } = countCalls.get();
  const calls = paginatedCalls.all(limit, offset);
  res.json({ calls, total, page, totalPages: Math.ceil(total / limit) });
});

// --- Clinicea API Integration (Next Meeting) ---
let cliniceaToken = null;
let tokenExpiry = 0;
const meetingCache = new Map(); // phone -> { data, expiry }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function isClinicaConfigured() {
  return CLINICEA_API_KEY && CLINICEA_API_KEY !== 'your_api_key_here' &&
         CLINICEA_STAFF_USERNAME && CLINICEA_STAFF_USERNAME !== 'your_staff_username_here' &&
         CLINICEA_STAFF_PASSWORD && CLINICEA_STAFF_PASSWORD !== 'your_staff_password_here';
}

async function cliniceaLogin() {
  const url = `${CLINICEA_API_BASE}/api/v2/login/getTokenByStaffUsernamePwd?apiKey=${encodeURIComponent(CLINICEA_API_KEY)}&loginUserName=${encodeURIComponent(CLINICEA_STAFF_USERNAME)}&pwd=${encodeURIComponent(CLINICEA_STAFF_PASSWORD)}`;
  const res = await fetch(url);
  if (!res.ok) {
    logEvent('error', 'Clinicea API login failed', 'HTTP ' + res.status);
    throw new Error('Clinicea login failed: ' + res.status);
  }
  const data = await res.json();
  // Token is returned as a plain string
  cliniceaToken = typeof data === 'string' ? data : (data.Token || data.token || data.sessionId);
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  logEvent('info', 'Clinicea API login successful');
  return cliniceaToken;
}

async function getClinicaToken() {
  if (!cliniceaToken || Date.now() > tokenExpiry) {
    await cliniceaLogin();
  }
  return cliniceaToken;
}

// Clinicea uses api_key as query parameter for auth (NOT Bearer header)
async function cliniceaFetch(endpoint) {
  const token = await getClinicaToken();
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `${CLINICEA_API_BASE}${endpoint}${separator}api_key=${token}`;
  const res = await fetch(url);
  if (res.status === 401) {
    await cliniceaLogin();
    const retryUrl = `${CLINICEA_API_BASE}${endpoint}${separator}api_key=${cliniceaToken}`;
    const retryRes = await fetch(retryUrl);
    if (retryRes.status === 204) return [];
    const retryText = await retryRes.text();
    try { return JSON.parse(retryText); } catch { return []; }
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

// Find patient by phone — tries v2/getPatient direct search first, then appointment matching
async function findPatientByPhone(phone) {
  const cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
  // Extract local number (without country code) for Clinicea search
  let localNum = cleanPhone.replace('+', '');
  if (localNum.startsWith('92')) localNum = localNum.substring(2);
  else if (localNum.startsWith('0')) localNum = localNum.substring(1);

  logEvent('info', 'Looking up phone: ' + cleanPhone, 'Local: ' + localNum);

  // Method 1 (most reliable): v2/getPatient — searches by mobile with country code
  try {
    const data = await cliniceaFetch(`/api/v2/patients/getPatient?searchBy=2&searchText=${encodeURIComponent(localNum)}&searchOption=%2B92`);
    console.log(`[SEARCH] v2/getPatient(${localNum}) =>`, JSON.stringify(data).substring(0, 400));
    const result = extractPatientFromSearch(data);
    if (result) {
      logEvent('info', 'Patient found via v2/getPatient: ' + result.patientName, 'ID: ' + result.patientID);
      return result;
    }
  } catch (e) {
    console.log(`[SEARCH] v2/getPatient error:`, e.message);
  }

  // Method 2: appointment-based matching (works when phone format matches exactly)
  try {
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const syncDate = thirtyDaysAgo.toISOString().split('.')[0];
    const data = await cliniceaFetch(`/api/v2/appointments/getChanges?lastSyncDTime=${syncDate}&pageNo=1&pageSize=100`);
    if (Array.isArray(data)) {
      const variants = new Set();
      variants.add(cleanPhone);
      variants.add(cleanPhone.replace('+', ''));
      if (cleanPhone.startsWith('0')) {
        variants.add('92' + cleanPhone.substring(1));
        variants.add('+92' + cleanPhone.substring(1));
      }
      if (cleanPhone.startsWith('+92')) {
        variants.add('0' + cleanPhone.substring(3));
        variants.add(cleanPhone.substring(1));
      }
      if (cleanPhone.startsWith('92') && !cleanPhone.startsWith('+')) {
        variants.add('+' + cleanPhone);
        variants.add('0' + cleanPhone.substring(2));
      }

      const match = data.find(a => {
        const p1 = (a.AppointmentWithPhone || '').replace(/[\s\-\(\)]/g, '');
        const p2 = (a.PatientMobile || '').replace(/[\s\-\(\)]/g, '');
        return variants.has(p1) || variants.has(p2);
      });

      if (match) {
        let patientName = match.AppointmentWithName || match.PatientName || null;
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
    console.log(`[SEARCH] getChanges error:`, e.message);
  }

  logEvent('warn', 'No patient found for ' + cleanPhone);
  return null;
}

function extractPatientId(obj) {
  // Clinicea uses different field names across API versions
  // v2/getPatient uses "ID", appointments use "PatientID"
  return obj.PatientID || obj.patientID || obj.PatientId || obj.ID || obj.QDID ||
         obj.EntityID || obj.entityID || obj.Id || obj.id || obj.UniqueID || obj.PatientGUID || null;
}

function extractPatientFromSearch(data) {
  // Log raw response keys for debugging
  if (data && !Array.isArray(data) && typeof data === 'object') {
    console.log('[SEARCH] Response keys:', Object.keys(data).join(', '));
    console.log('[SEARCH] Response sample:', JSON.stringify(data).substring(0, 500));
  }
  if (Array.isArray(data) && data.length > 0) {
    console.log('[SEARCH] Array[0] keys:', Object.keys(data[0]).join(', '));
    console.log('[SEARCH] Array[0] sample:', JSON.stringify(data[0]).substring(0, 500));
  }

  if (data && !Array.isArray(data) && typeof data === 'object') {
    const pid = extractPatientId(data);
    if (pid) {
      const name = data.FullName || data.Name || data.PatientName || [data.FirstName, data.LastName].filter(Boolean).join(' ') || null;
      logEvent('info', 'Patient found via search: ' + (name || 'Unknown'), 'ID: ' + pid);
      return { patientID: pid, patientName: name };
    }
  }
  if (Array.isArray(data) && data.length > 0) {
    const pat = data[0];
    const pid = extractPatientId(pat);
    if (pid) {
      const name = pat.FullName || pat.Name || pat.PatientName || [pat.FirstName, pat.LastName].filter(Boolean).join(' ') || null;
      logEvent('info', 'Patient found via search: ' + (name || 'Unknown'), 'ID: ' + pid);
      return { patientID: pid, patientName: name };
    }
  }
  return null;
}

async function getNextAppointmentForPatient(patientID) {
  // appointmentType=0 means upcoming, pageSize minimum is 10
  const data = await cliniceaFetch(`/api/v2/appointments/getAppointmentsByPatient?patientID=${patientID}&appointmentType=0&pageNo=1&pageSize=10`);
  if (!Array.isArray(data) || data.length === 0) return null;
  // Sort by StartDateTime ascending and return the earliest upcoming
  const now = new Date();
  const upcoming = data
    .filter(a => new Date(a.StartDateTime) >= now && a.AppointmentStatus !== 'Cancelled')
    .sort((a, b) => new Date(a.StartDateTime) - new Date(b.StartDateTime));
  return upcoming[0] || data[0];
}

// API - next meeting for a phone number
app.get('/api/next-meeting/:phone', requireAuth, async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);

  if (!isClinicaConfigured()) {
    return res.json({ nextMeeting: null, error: 'Clinicea API not configured' });
  }

  // Check cache
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

// API - full patient profile from Clinicea
app.get('/api/patient-profile/:phone', requireAuth, async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);

  if (!isClinicaConfigured()) {
    return res.json({ error: 'Clinicea API not configured' });
  }

  try {
    const patient = await findPatientByPhone(phone);
    if (!patient || !patient.patientID) {
      return res.json({ error: 'Patient not found in Clinicea' });
    }

    // Fetch all patient data in parallel
    const [details, appointments, bills] = await Promise.all([
      cliniceaFetch(`/api/v3/patients/getPatientByID?patientID=${patient.patientID}`),
      cliniceaFetch(`/api/v2/appointments/getAppointmentsByPatient?patientID=${patient.patientID}&appointmentType=2&pageNo=1&pageSize=50`),
      cliniceaFetch(`/api/v2/bills/getBillsByPatient?patientID=${patient.patientID}&billStatus=0&pageNo=1&pageSize=50`)
    ]);

    console.log(`\n=== PATIENT PROFILE: ${phone} ===`);
    console.log('Patient Details:', JSON.stringify(details, null, 2));
    console.log('Appointments (' + (Array.isArray(appointments) ? appointments.length : 0) + '):', JSON.stringify(appointments, null, 2));
    console.log('Bills (' + (Array.isArray(bills) ? bills.length : 0) + '):', JSON.stringify(bills, null, 2));
    console.log('=== END PROFILE ===\n');

    return res.json({
      patient: details,
      appointments: Array.isArray(appointments) ? appointments : [],
      bills: Array.isArray(bills) ? bills : [],
      patientName: patient.patientName,
      patientID: patient.patientID
    });
  } catch (err) {
    logEvent('error', 'Patient profile fetch failed', err.message);
    return res.json({ error: err.message });
  }
});

// --- Patient list cache (avoids re-fetching from Clinicea on every search) ---
let patientCache = { patients: [], expiry: 0, loading: false, pages: 0 };
const PATIENT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function mapPatientFields(p) {
  return {
    patientID: extractPatientId(p),
    name: p.Name || p.PatientName || p.FullName || [p.FirstName, p.LastName].filter(Boolean).join(' ') || 'Unknown',
    phone: p.Mobile || p.MobilePhone || p.PatientMobile || p.Phone || '',
    email: p.Email || p.EmailAddress || '',
    fileNo: p.FileNo || '',
    gender: p.Gender || '',
    createdDate: p.CreatedDatetime || p.CreatedDate || ''
  };
}

async function loadAllPatients() {
  if (patientCache.loading) return;
  patientCache.loading = true;
  const allPatients = [];
  let pageNo = 1;
  try {
    while (true) {
      const data = await cliniceaFetch(`/api/v1/patients?lastSyncDate=2000-01-01T00:00:00&intPageNo=${pageNo}`);
      const batch = Array.isArray(data) ? data : [];
      allPatients.push(...batch.map(mapPatientFields));
      if (batch.length < 100) break; // last page
      pageNo++;
      if (pageNo > 50) break; // safety limit (5000 patients max)
    }
    patientCache = { patients: allPatients, expiry: Date.now() + PATIENT_CACHE_TTL, loading: false, pages: pageNo };
    logEvent('info', `Patient cache loaded: ${allPatients.length} patients (${pageNo} pages)`);
  } catch (err) {
    patientCache.loading = false;
    logEvent('error', 'Patient cache load failed', err.message);
    throw err;
  }
}

// API - list all patients (cached, with search)
app.get('/api/patients', requireAuth, async (req, res) => {
  const search = (req.query.search || '').trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = 50;

  if (!isClinicaConfigured()) {
    return res.json({ error: 'Clinicea API not configured', patients: [], total: 0 });
  }

  try {
    // Load/refresh cache if stale
    if (Date.now() > patientCache.expiry && !patientCache.loading) {
      await loadAllPatients();
    } else if (patientCache.loading) {
      // Still loading from another request — return what we have or wait briefly
      return res.json({ patients: [], page: 1, hasMore: false, loading: true });
    }

    let patients = patientCache.patients;

    // Filter by search
    if (search) {
      patients = patients.filter(p =>
        p.name.toLowerCase().includes(search) ||
        p.phone.toLowerCase().includes(search) ||
        p.email.toLowerCase().includes(search) ||
        (p.fileNo && p.fileNo.toLowerCase().includes(search))
      );
    }

    // Paginate
    const total = patients.length;
    const start = (page - 1) * pageSize;
    const sliced = patients.slice(start, start + pageSize);

    return res.json({ patients: sliced, page, hasMore: start + pageSize < total, total });
  } catch (err) {
    logEvent('error', 'Patients list fetch failed', err.message);
    return res.json({ error: err.message, patients: [], total: 0 });
  }
});

// API - appointments by date
app.get('/api/appointments-by-date', requireAuth, async (req, res) => {
  const date = req.query.date;
  if (!date) {
    return res.json({ error: 'date parameter required', appointments: [] });
  }

  if (!isClinicaConfigured()) {
    return res.json({ error: 'Clinicea API not configured', appointments: [] });
  }

  try {
    const data = await cliniceaFetch(`/api/v3/appointments/getAppointmentsByDate?appointmentDate=${encodeURIComponent(date)}&pageNo=1&pageSize=100`);
    let appointments = Array.isArray(data) ? data : [];

    // Map to consistent fields
    appointments = appointments.map(a => ({
      appointmentID: a.AppointmentID || a.ID || a.Id,
      patientID: a.PatientID || a.patientID,
      patientName: a.AppointmentWithName || a.PatientName || [a.PatientFirstName || a.FirstName, a.PatientLastName || a.LastName].filter(Boolean).join(' ') || 'Unknown',
      startTime: a.StartDateTime || a.AppointmentDateTime || a.StartTime || '',
      endTime: a.EndDateTime || a.EndTime || '',
      duration: a.Duration || null,
      status: a.AppointmentStatus || a.Status || 'Unknown',
      service: a.ServiceName || a.Service || '',
      doctor: a.DoctorName || a.Doctor || '',
      phone: a.AppointmentWithPhone || a.PatientMobile || a.Mobile || '',
      notes: a.Notes || a.AppointmentNotes || ''
    }));

    return res.json({ appointments, date });
  } catch (err) {
    logEvent('error', 'Appointments by date fetch failed', err.message);
    return res.json({ error: err.message, appointments: [] });
  }
});

// API - patient profile by patient ID (not phone)
app.get('/api/patient-profile-by-id/:patientId', requireAuth, async (req, res) => {
  const patientId = req.params.patientId;

  if (!isClinicaConfigured()) {
    return res.json({ error: 'Clinicea API not configured' });
  }

  try {
    const [details, appointments, bills] = await Promise.all([
      cliniceaFetch(`/api/v3/patients/getPatientByID?patientID=${patientId}`),
      cliniceaFetch(`/api/v2/appointments/getAppointmentsByPatient?patientID=${patientId}&appointmentType=2&pageNo=1&pageSize=50`),
      cliniceaFetch(`/api/v2/bills/getBillsByPatient?patientID=${patientId}&billStatus=0&pageNo=1&pageSize=50`)
    ]);

    const pat = Array.isArray(details) ? (details[0] || {}) : (details || {});
    const patientName = pat.Name || pat.PatientName || pat.FullName ||
                        [pat.FirstName, pat.LastName].filter(Boolean).join(' ') || 'Unknown';

    return res.json({
      patient: details,
      appointments: Array.isArray(appointments) ? appointments : [],
      bills: Array.isArray(bills) ? bills : [],
      patientName,
      patientID: patientId
    });
  } catch (err) {
    logEvent('error', 'Patient profile by ID fetch failed', err.message);
    return res.json({ error: err.message });
  }
});

// API - event log history
app.get('/api/logs', requireAuth, (req, res) => {
  res.json({ logs: eventLog });
});

// --- Socket.IO ---
io.on('connection', (socket) => {
  logEvent('info', 'Dashboard client connected');
  socket.on('disconnect', () => {
    logEvent('info', 'Dashboard client disconnected');
  });
});

// --- Start ---
server.listen(PORT, () => {
  logEvent('info', 'Server started on port ' + PORT);
  logEvent('info', 'Clinicea API: ' + (isClinicaConfigured() ? 'Configured' : 'Not configured'));
});
