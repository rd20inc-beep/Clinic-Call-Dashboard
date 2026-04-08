# Dr. Nakhoda's Clinic Call Dashboard — Complete System Export

**Generated:** 2026-04-08
**Purpose:** Technical reference for mobile app redesign and system improvement

---

## 1. EXECUTIVE SUMMARY

The system is a real-time clinic call management dashboard built with Node.js/Express, SQLite, and Socket.IO. It handles incoming calls from a PC-based call monitor and an Android mobile app, routes them to agents, provides Clinicea EMR patient lookup, manages WhatsApp appointment confirmations/reminders, and tracks agent performance.

**Stack:** Node.js 24 + Express 4 + Socket.IO 4 + SQLite (better-sqlite3) + whatsapp-web.js
**Frontend:** Vanilla JS, no framework. Single-page app with hash routing.
**Mobile:** Android (Kotlin), CallerID service with CallLog polling.
**Deployment:** Single VPS, PM2, Nginx reverse proxy, HTTPS.

---

## 2. CURRENT SYSTEM OVERVIEW

### Components
| Component | Technology | Purpose |
|-----------|-----------|---------|
| Web Dashboard | HTML/JS/CSS (vanilla) | Agent + Admin interface |
| Admin Console | Separate HTML page, embedded as iframe | Analytics + management |
| Backend API | Express.js REST | Call handling, auth, data |
| Real-time Layer | Socket.IO | Live call popups, agent status |
| Database | SQLite (calls.db) | Calls, users, messages, appointments |
| Session Store | SQLite (sessions.db) | Express sessions |
| Mobile App | Android Kotlin | Call detection + event reporting |
| WhatsApp | whatsapp-web.js + Chrome | Appointment confirmations/reminders |
| Clinicea API | External REST | Patient lookup, appointment sync |
| Call Monitor | PC software (separate) | Detects incoming calls via webhook |

### Data Flow Overview
```
Phone Call → PC Monitor/Mobile App → Backend API → Database + Socket.IO → Dashboard
                                                                        ↓
                                                    Clinicea API → Patient Info → Dashboard
```

---

## 3. USER ROLES AND ACCESS

### Admin
- **Can see:** All calls, all agents, all stats, admin console, audit log
- **Can do:** Create/delete agents, force logout, clear history, manage WhatsApp, approve messages, set business hours, manage templates, assign callbacks
- **Events:** Receives ALL socket events (incoming_call, patient_info, call_updated, agent_status_update, server_log)
- **Dashboard:** Full overview KPIs, trends, leaderboard, call history, callbacks, appointments, agent management, insights, audit log

### Agent
- **Can see:** Own calls only, shared patients/appointments, WhatsApp conversations
- **Can do:** Set own status, add call notes, set disposition, send confirmations, view calendar
- **Events:** Receives only events where `data.agent === myUsername`
- **Dashboard:** Call popup + beep for assigned calls, own call history, calendar, patients

### Agent1 (Special)
- **Same as Agent plus:** WhatsApp management rights (approve/reject messages, toggle bot, reconnect, manage templates)
- **UI:** Sees `.wa-manager` elements (disconnect, reconnect, bot toggle, business hours, templates)

### Doctor
- **Can see:** Calendar, patients
- **Can do:** View appointments
- **Events:** Limited
- **Note:** Doctor role exists in code but is minimally implemented

### Mobile App User
- **Any role** can log into the mobile app
- App sends call events (ringing, call_ended) to backend
- App sends heartbeat every 60 seconds (marks agent as "mobile online")
- App currently has: Calls tab (call log), Dashboard/Calendar/WhatsApp tabs (WebView)

---

## 4. COMPLETE CALL LIFECYCLE

### 4A. INCOMING CALL FLOW

#### Source 1: PC Call Monitor (Webhook)
```
1. Phone rings at clinic
2. PC call monitor software detects PHONE_STATE change
3. Sends POST /incoming_call with:
   - From: phone number or "contact:Name"
   - CallSid: unique identifier
   - Agent: optional (from PC identity)
   - secret: webhook secret
4. Server:
   a. Validates webhook secret (timing-safe comparison)
   b. Normalizes phone to +92XXXXXXXXX format
   c. Resolves agent: explicit → IP map → IP socket → null
   d. Inserts call to DB (status: 'unknown', direction: 'inbound')
   e. Marks agent as busy (setOnCall)
   f. Routes 'incoming_call' event to agent:{agent} + role:admin rooms
   g. Async: Clinicea patient lookup (8s timeout)
      - On success: updates patient_name/patient_id, routes 'patient_info' event
5. Dashboard:
   - Agent sees popup banner with caller info + beep sound
   - Admin sees call in real-time feed (no popup/beep)
   - Call appears in call history with status 'unknown'
6. Call ends:
   - PC monitor does NOT send call_ended event (limitation)
   - Status stays 'unknown' until auto-finalized
   - Auto-finalize: after 15 minutes, unknown inbound → 'missed', unknown outbound → 'answered'
```

#### Source 2: Mobile App
```
1. Phone rings on agent's mobile
2. Android CallReceiver detects PHONE_STATE_CHANGED
3. App sends POST /api/incoming-call with:
   - phone_number: caller's number
   - event: 'ringing'
   - call_type: 'incoming'
   - caller_name: from contacts (if available)
   - Authorization: Bearer {token}
4. Server:
   a. Validates Bearer token
   b. Same processing as webhook (insert, route, lookup)
5. When call ends:
   a. App queries CallLog for accurate details (2.5s delay)
   b. Sends POST /api/incoming-call with event: 'call_ended'
   c. Payload includes: call_status (answered/missed/rejected), duration, call_type
   d. Server updates call record with final status + duration
   e. If status is missed: auto-creates callback record
```

#### Status Progression
```
unknown → answered (call picked up, duration > 0)
unknown → missed (call not picked up, or auto-finalized after 15min)
unknown → rejected (call declined)
```

### 4B. OUTGOING CALL FLOW

#### Current State: PARTIALLY IMPLEMENTED

##### What Works (v2.0 App Code)
```
1. Agent dials a number on mobile
2. Android receives NEW_OUTGOING_CALL intent (Android 9 and below)
   OR CallLog poller catches it every 10s (Android 10+)
3. App sends POST /api/incoming-call with:
   - phone_number: dialed number
   - event: 'ringing'
   - call_type: 'outgoing'
   - Authorization: Bearer {token}
4. Server:
   a. Inserts call with direction: 'outbound'
   b. Routes event to dashboard
5. When call ends:
   a. App sends event: 'call_ended' with duration + status
   b. Server updates record
```

##### What's Broken/Missing
1. **NEW_OUTGOING_CALL is deprecated on Android 10+** — many Samsung/Xiaomi phones don't deliver this broadcast
2. **CallLog poller is the backup** but only sends 'call_ended' (no real-time 'ringing' event for outgoing)
3. **Dashboard shows outgoing calls AFTER they end** (not when dialing starts)
4. **PC Call Monitor does NOT detect outgoing calls at all**
5. **No click-to-call from dashboard** — all outgoing calls are manual dials
6. **No callback-to-call workflow** — callbacks exist but aren't linked to outgoing calls
7. **Outgoing calls show as "Unknown" if:**
   - READ_CALL_LOG permission not granted
   - CallLog not written yet (Samsung delay)
   - App process killed by battery optimization

---

## 5. MOBILE APP WORKING

### Current Architecture (v2.0)
- **Language:** Kotlin
- **Min SDK:** 26 (Android 8)
- **Auth:** Bearer token stored in SharedPreferences
- **Background:** Foreground service (CallerIdService) with notification

### Login Flow
```
POST /api/agent/login {agent_id, password}
→ Returns {success, token, agent, role, name, serverUrl}
→ Token stored in SharedPreferences
→ Subsequent requests use Authorization: Bearer {token}
```

### What the App Does Today
| Feature | Status | Details |
|---------|--------|---------|
| Detect incoming calls | ✅ Works | BroadcastReceiver on PHONE_STATE_CHANGED |
| Send incoming ringing event | ✅ Works | Immediate POST to server |
| Detect outgoing calls | ⚠️ Partial | NEW_OUTGOING_CALL (deprecated) + CallLog poller |
| Send outgoing ringing event | ⚠️ Unreliable | Only on Android 9 and below |
| Send call_ended with status | ✅ Works | Queries CallLog for accurate data |
| Send call duration | ✅ Works | From CallLog |
| Detect contact name | ✅ Works | CACHED_NAME from CallLog |
| Heartbeat (presence) | ✅ Works | Every 60s, marks agent as mobile online |
| WhatsApp call detection | ✅ Works | NotificationListenerService |
| Offline queue | ✅ Works | Stores events when no network, retries |
| Auto-restart on boot | ✅ Works | BootReceiver |
| Battery optimization bypass | ✅ Prompts | REQUEST_IGNORE_BATTERY_OPTIMIZATIONS |
| Dashboard WebView tabs | ⚠️ New | Auth bridge via /api/app/auth-session |

### What's Missing from the App
1. **Real-time outgoing call notification** — outgoing calls don't show on dashboard until they end
2. **No native dashboard** — uses WebView (was native in v1.4, source was lost)
3. **No patient lookup in app** — all lookup happens server-side
4. **No appointment view in app** — relies on WebView
5. **No post-call actions** — can't add notes/disposition from app
6. **No callback trigger** — can't initiate callbacks from app
7. **No doctor-specific workflow** — doctor role has no special features
8. **Session expires silently** — 7-day token TTL, no refresh mechanism

---

## 6. API EXPORT

### Authentication
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| POST /login | POST | None | Dashboard login (session) |
| GET /logout | GET | Session | Dashboard logout |
| GET /api/me | GET | Session | Get current user identity |
| POST /api/agent/login | POST | None | Mobile app login (returns token) |
| GET /api/app/auth-session | GET | Token (query) | Bridge token→session for WebView |
| GET /api/app/config | GET | None | Server URL + app version |

### Call Management
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| POST /incoming_call | POST | Webhook secret | PC monitor reports incoming call |
| POST /api/incoming-call | POST | Bearer token | Mobile app reports call event |
| POST /api/test-call | POST | Session | Simulate call from dashboard |
| GET /api/calls | GET | Session | Paginated call history with filters |
| GET /api/calls/:id | GET | Session+ownership | Single call details |
| POST /api/calls/:id/direction | POST | Session+ownership | Fix call direction |
| POST /api/calls/:id/disposition | POST | Session+ownership | Set call outcome |
| POST /api/calls/:id/notes | POST | Session+ownership | Add/update notes |
| POST /api/agent/set-status | POST | Session | Agent sets own status |
| POST /api/calls/clear-my-history | POST | Session | Agent clears own history |

### Appointments & Patients
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| GET /api/appointments-by-date | GET | Session | Calendar appointments (from DB or API) |
| GET /api/next-meeting/:phone | GET | Session | Next appointment for phone |
| GET /api/patient-profile/:phone | GET | Session | Patient profile by phone |
| GET /api/patient-profile-by-id/:id | GET | Session | Patient profile by ID |
| GET /api/patients | GET | Session | Patient list with search/filter |
| POST /api/patients/edit | POST | Session | Edit patient record |

### WhatsApp
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| POST /api/whatsapp/send | POST | Session | Send/queue message |
| POST /api/whatsapp/preview-template | POST | Session | Preview template text |
| POST /api/whatsapp/mark-sent | POST | Session | Mark confirmation/reminder sent |
| GET /api/whatsapp/stats | GET | Session | Message counts |
| GET /api/whatsapp/pending-approval | GET | Session | Messages awaiting approval |
| POST /api/whatsapp/approve | POST | Session+canApprove | Approve message |
| POST /api/whatsapp/reject | POST | Session+canApprove | Reject message |
| POST /api/whatsapp/bot-toggle | POST | Session+canApprove | Enable/disable bot |
| GET /api/whatsapp/bot-status | GET | Session | Bot status + business hours |
| POST /api/whatsapp/business-hours | POST | Session+canApprove | Set business hours |
| GET /api/whatsapp/connection-status | GET | Session | WhatsApp connection state |
| POST /api/whatsapp/wa-reconnect | POST | Session+canApprove | Reconnect WhatsApp |
| POST /api/whatsapp/wa-logout | POST | Session+canApprove | Disconnect WhatsApp |

### Admin Console
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| GET /admin/analytics/overview | GET | Session | Overview KPIs (period selectable) |
| GET /admin/agents | GET | Session+admin | Agent list with performance |
| POST /admin/agents/create | POST | Session+admin | Create agent |
| POST /admin/agents/:id/update | POST | Session+admin | Update agent |
| GET /admin/appointments | GET | Session | Appointment list with stats |
| POST /admin/appointments/:id/assign | POST | Session | Assign agent to appointment |
| POST /admin/appointments/:id/status | POST | Session | Manual status update |
| GET /admin/analytics/trends | GET | Session+admin | Call volume trends |
| GET /admin/analytics/leaderboard | GET | Session+admin | Agent rankings |
| GET /admin/analytics/call-history | GET | Session+admin | Full call history |
| GET /admin/analytics/patterns | GET | Session+admin | Call patterns + insights |
| GET /admin/callbacks | GET | Session | Callback queue |
| GET /admin/audit | GET | Session+admin | Audit log |

### Mobile App
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| POST /api/agent/login | POST | None (rate limited) | Login, get Bearer token |
| POST /api/app/heartbeat | POST | Bearer token | Keep-alive (every 60s) |
| POST /api/incoming-call | POST | Bearer token | Report call event |
| GET /api/app/auth-session | GET | Token (query param) | WebView session bridge |
| GET /api/app/config | GET | None | Server URL + version |

---

## 7. SOCKET / REAL-TIME ARCHITECTURE

### Rooms
| Room | Who joins | Events received |
|------|-----------|----------------|
| `agent:{username}` | Agent's browser socket(s) | incoming_call (assigned), patient_info, call_updated |
| `role:admin` | All admin sockets | ALL events (calls, status, logs, WA) |

### Events Emitted by Server
| Event | Rooms | Payload | When |
|-------|-------|---------|------|
| `incoming_call` | agent + admin | {caller, callId, agent, cliniceaUrl, direction, timestamp} | New call detected |
| `patient_info` | agent + admin | {caller, callId, patientName, patientID} | Clinicea lookup completes |
| `call_updated` | agent + admin | {callId, status, duration} | Call status changes |
| `agent_status_update` | admin only | {username, status, lastActivity, onCall} | Agent goes online/offline/busy |
| `server_log` | admin only | {type, message, details, time} | Server events (errors, warnings) |
| `wa_connection` | admin + agent1 | {status, qrDataUrl?, reason?} | WhatsApp connection changes |
| `wa_message` | admin + agent1 | {phone, chatName, direction, text, timestamp} | WhatsApp message received |
| `admin_message` | all admin sockets | {message, from} | Admin broadcast |

### Events Emitted by Client
| Event | Purpose |
|-------|---------|
| `activity` | Keep-alive ping (every 60s) |
| `join` | Request to join rooms (after connect) |

### Connection Lifecycle
```
Browser opens → Socket.IO connect → Session auth check
→ Join rooms (agent:{username} + role:admin if admin)
→ Emit join_confirm with room info
→ Start activity ping (60s interval)
→ On disconnect: decrement socketCount, update presence
→ If last socket: close login session, set offline
```

---

## 8. DATABASE EXPORT

### 12 Tables, 22 Indexes

#### calls (18 columns)
Primary call records. Stores every incoming and outgoing call.

| Column | Type | Purpose |
|--------|------|---------|
| id | INTEGER PK | Auto-increment |
| caller_number | TEXT | Phone number (+92 format) |
| call_sid | TEXT | Unique call identifier |
| clinicea_url | TEXT | Link to patient in Clinicea |
| patient_name | TEXT | Resolved from Clinicea or contacts |
| patient_id | TEXT | Clinicea patient ID |
| agent | TEXT | Assigned agent username |
| routing_method | TEXT | How agent was resolved |
| source_ip | TEXT | Request origin IP |
| direction | TEXT | 'inbound' or 'outbound' |
| call_status | TEXT | 'unknown', 'answered', 'missed', 'rejected' |
| duration | INTEGER | Seconds |
| disposition | TEXT | Call outcome (appointment_booked, etc.) |
| notes | TEXT | Agent notes |
| source | TEXT | 'phone' (default) |
| call_started_at | DATETIME | When call started |
| call_ended_at | DATETIME | When call ended |
| timestamp | DATETIME | Record creation time (UTC) |

#### wa_appointment_tracking (20 columns)
Appointment records synced from Clinicea API.

| Column | Type | Purpose |
|--------|------|---------|
| id | INTEGER PK | Auto-increment |
| appointment_id | TEXT UNIQUE | Clinicea appointment ID |
| patient_id | TEXT | Clinicea patient ID |
| patient_name | TEXT | Patient name |
| patient_phone | TEXT | Patient phone |
| appointment_date | TEXT | Start datetime |
| end_time | TEXT | End datetime |
| duration | INTEGER | Minutes |
| doctor_name | TEXT | Doctor |
| service | TEXT | Treatment/procedure |
| clinicea_status | TEXT | Check Out, Confirmed, Engaged, etc. |
| notes | TEXT | Appointment notes |
| confirmation_sent | INTEGER | 0 or 1 |
| reminder_sent | INTEGER | 0 or 1 |
| confirmation_sent_at | DATETIME | When confirmation queued |
| reminder_sent_at | DATETIME | When reminder queued |
| created_by | TEXT | Who booked (from Clinicea) |
| assigned_agent | TEXT | Admin-assigned agent |
| status_updated_at | DATETIME | Last Clinicea status sync |
| created_at | DATETIME | Record creation |

#### users (17 columns)
Agent/admin accounts.

#### wa_messages (11 columns)
WhatsApp messages sent/received.

#### callbacks (13 columns)
Missed call follow-up tracking.

#### patients (14 columns)
Local patient cache (supplements Clinicea).

#### login_history (8 columns)
Login/logout audit trail.

#### app_tokens (5 columns)
Mobile app Bearer tokens.

#### internal_messages (6 columns)
Agent-to-agent chat.

#### audit_log (6 columns)
Admin action audit trail.

#### wa_settings (3 columns)
WhatsApp bot configuration.

#### wa_paused_chats (3 columns)
Paused WhatsApp conversations.

---

## 9. DASHBOARD DATA FLOW

### Agent Dashboard
| Widget | Data Source | Update Method |
|--------|-----------|---------------|
| Call popup + beep | Socket: `incoming_call` | Real-time |
| Patient info overlay | Socket: `patient_info` | Real-time |
| Call history table | GET /api/calls | Refresh on call event |
| Calendar | GET /api/appointments-by-date | On tab switch |
| Patients list | GET /api/patients | On tab switch |
| WhatsApp conversations | GET /api/whatsapp/conversations | On tab switch |

### Admin Console
| Widget | Data Source | Update Method |
|--------|-----------|---------------|
| KPI cards (calls, answered, missed, rate) | GET /admin/analytics/overview | On tab switch + period change |
| Agent status cards | GET /admin/analytics/overview (agentStats) | On tab switch |
| Agent online/offline | Socket: `agent_status_update` | Real-time |
| Call trends charts | GET /admin/analytics/trends | On period change |
| Leaderboard | GET /admin/analytics/leaderboard | On tab switch |
| Appointments tab | GET /admin/appointments | On tab switch |
| Callbacks queue | GET /admin/callbacks | On tab switch |
| Audit log | GET /admin/audit | On tab switch |

---

## 10. CURRENT PROBLEMS / GAPS

### Critical
1. **Outgoing calls unreliable on Android 10+** — NEW_OUTGOING_CALL deprecated, CallLog poller is backup but delayed
2. **PC Call Monitor cannot detect outgoing calls** — only monitors incoming
3. **No real-time outgoing call event** — dashboard only sees outgoing calls after they end
4. **Mobile app source was lost** — v1.4 had native fragments, current source only has basic call monitoring + WebView
5. **EncryptedSharedPreferences crashes on reinstall** — fixed by switching to plain prefs
6. **Original signing keystore lost** — users must uninstall old app to install new

### High
7. **No unified call state machine** — status transitions are ad-hoc (unknown → answered/missed/rejected)
8. **No call dedup for mobile** — if both CallLog poller and BroadcastReceiver fire, duplicate events possible
9. **Auto-finalize is a guess** — after 15 min, unknown inbound → missed, unknown outbound → answered (may be wrong)
10. **Agent resolution is fragile** — IP-based fallback unreliable with shared WiFi
11. **WhatsApp disconnects frequently** — keepalive helps but underlying whatsapp-web.js is unstable
12. **Timezone inconsistency** — SQLite stores UTC (CURRENT_TIMESTAMP), appointment dates from Clinicea are PKT, some queries use +5 hours offset

### Medium
13. **No click-to-call** — agents must manually dial
14. **No callback-to-call linkage** — callbacks exist but outgoing follow-up calls aren't linked
15. **No post-call notes from mobile** — agent must use dashboard to add notes
16. **No doctor dashboard** — doctor role exists but has no special features
17. **Sessions lost on server restart** — SQLite sessions survive but Socket.IO rooms don't
18. **No device registration** — can't target push notifications to specific devices
19. **Legacy server.js duplicates code** — both server.js and src/server.js exist with overlapping logic

### Low
20. **No call recording integration** — system doesn't handle recordings
21. **No SMS channel** — only WhatsApp
22. **No multi-branch support** — single clinic assumption
23. **No patient consent tracking** — messages sent without opt-in verification
24. **Audit log is basic** — doesn't capture all state changes

---

## 11. REQUIRED ADDITIONS FOR BETTER MOBILE APP

### Call Tracking
- Unified call state machine: `idle → ringing → connected → ended(answered|missed|rejected|no_answer)`
- Server-side dedup by call_sid or phone+timestamp window
- Real-time outgoing call start event (use CallLog poller + ContentObserver for instant detection)
- Duration tracked from connect time, not ring time
- Call notes editable from mobile
- Disposition settable from mobile

### Dashboard Integration
- Mobile-originated calls show instantly with direction badge (IN/OUT)
- Outgoing call widget on admin console
- Callback queue accessible from mobile
- Agent performance visible in mobile dashboard tab

### Mobile App Features Needed
- **Native agent dashboard** (not WebView) — KPI cards, recent calls, quick actions
- **Native admin overview** — call stats, agent status, appointment count
- **Patient quick-lookup** — search by phone/name, see history
- **Post-call action sheet** — after call ends, prompt for disposition + notes
- **Callback initiation** — tap to call back from callback queue
- **Appointment creation** — book from mobile after call
- **Push notifications** — for incoming calls when app is in background
- **Token refresh** — auto-refresh before 7-day expiry
- **Device registration** — register device for push targeting

### Architecture
- Normalize all call events through a single `processCallEvent()` function
- Central event bus (instead of calling routeCallEvent + setOnCall + updateActivity separately)
- Stronger phone normalization (handle all PK formats consistently)
- Better session management (Redis or database-backed Socket.IO adapter for multi-instance)

---

## 12. RECOMMENDED IMPROVED ARCHITECTURE

### Backend
- Extract `CallStateMachine` service — single entry point for all call state transitions
- Add `CallEvent` model — normalized event format for all sources (webhook, mobile, CallLog)
- Implement event dedup at the service layer (not in each route)
- Move from in-memory presence to Redis (survives restarts, enables multi-instance)
- Add push notification service (Firebase FCM) for mobile alerts

### Mobile App
- **Rebuild with native UI** matching v1.4's design (agent dashboard, admin KPIs, appointment list)
- Use `ContentObserver` on CallLog for instant outgoing call detection (works on all Android versions)
- Implement post-call action sheet (disposition + notes + callback scheduling)
- Add patient search with local cache + server lookup
- Push notification receiver for incoming calls when app is backgrounded
- Token refresh mechanism (renew at 6 days, before 7-day expiry)

### Database
- Add `call_events` table — raw event log (every ringing/connected/ended event)
- Add `device_registrations` table — FCM tokens per agent per device
- Add `call_direction_source` field — who reported the direction (app/webhook/manual)
- Add `linked_callback_id` to calls — connect outgoing calls to callback records

### Real-time Layer
- Use Socket.IO Redis adapter for multi-instance support
- Add `call_state_changed` event (unified, replaces incoming_call + call_updated)
- Add mobile push channel alongside Socket.IO
- Room naming convention: `user:{id}` instead of `agent:{username}`

### Analytics
- Pre-compute daily/weekly/monthly aggregates in a stats table
- Add call-to-appointment conversion tracking
- Track time-to-answer per agent
- Track outgoing call success rate

---

## 13. PRIORITY FIXES

### HIGH (Do First)
1. Fix mobile app crash (EncryptedSharedPreferences) ✅ Done
2. Add outgoing call detection via ContentObserver (works on all Android)
3. Add call dedup on server (prevent duplicate entries)
4. Fix timezone consistency (pick one: UTC everywhere or PKT everywhere)
5. Rebuild mobile app with native dashboard fragments

### MEDIUM (Do Next)
6. Add post-call action sheet in mobile app
7. Add callback-to-outgoing-call linkage
8. Add push notifications (FCM) for backgrounded app
9. Add patient quick-lookup in mobile app
10. Clean up legacy server.js (remove duplicate code)

### LOW (Do Later)
11. Add click-to-call from dashboard
12. Add doctor-specific mobile workflow
13. Add multi-device sync
14. Add call recording integration
15. Migrate presence to Redis for multi-instance support

---

*End of System Export*
