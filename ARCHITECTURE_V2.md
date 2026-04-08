# Clinic Call Dashboard v2 — System Architecture

**Date:** 2026-04-08
**Purpose:** Complete redesign with mobile-first agent workflow

---

## 1. PRODUCT VISION

**Before:** PC monitor detects calls → webhook → dashboard shows popup → agent uses desktop.
**After:** Agent's phone IS the call system → mobile app detects all calls → backend processes → admin dashboard monitors in real-time.

The mobile app becomes the **single source of truth** for all call activity. The PC monitor becomes optional/deprecated. The admin dashboard becomes a pure monitoring and analytics tool — admins don't handle calls, they watch agents handle calls.

### Core Principles
1. **Mobile-first:** Agent's phone is the primary device. Dashboard is for admin oversight.
2. **Event-driven:** Every call state change is an event. Events flow: App → Server → Dashboard.
3. **Offline-resilient:** App queues events when offline, syncs when back.
4. **Real-time:** Admin sees call activity within 1-2 seconds of it happening.
5. **Simple:** Fewer moving parts. One app, one server, one database, one socket layer.

---

## 2. ROLE WORKFLOWS

### Agent Workflow (Mobile App)

```
Agent opens app → Login → Status: Online
                                ↓
Phone rings ← Patient calls → App detects incoming call
                                ↓
App sends "ringing" event → Server → Dashboard shows live call
                                ↓
Agent answers/misses/rejects → App detects state change
                                ↓
App sends "answered/missed/rejected" → Server updates → Dashboard updates
                                ↓
Call ends → App sends "ended" with duration
                                ↓
Post-Call Screen appears:
  → Set disposition (appointment booked, follow-up, inquiry, wrong number)
  → Add notes
  → Book appointment (if applicable)
  → Create callback (if needed)
  → Send WhatsApp confirmation
                                ↓
Agent taps "Done" → Ready for next call
```

**Outgoing call workflow:**
```
Agent dials from phone OR taps "Call" in app on a callback/patient
                                ↓
App detects outgoing call (ContentObserver on CallLog)
                                ↓
App sends "outgoing_ringing" → Server → Dashboard shows outgoing call
                                ↓
Call connects/fails → App sends status update
                                ↓
Call ends → Same post-call screen as incoming
```

### Admin Workflow (Dashboard)

```
Admin opens dashboard → Live wall shows all active calls
                                ↓
Sees: which agent is on what call, duration, direction, patient name
                                ↓
Tabs: Live Calls | Call History | Missed Calls | Callbacks | Appointments | Agents | Analytics
                                ↓
Can: assign callbacks, view performance, export data, manage agents
                                ↓
Gets: real-time updates via Socket.IO for every call state change
```

---

## 3. CORE SYSTEM ARCHITECTURE

```
┌──────────────────────────────────────────────────────────┐
│                     MOBILE APP (Android)                  │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌───────────┐ │
│  │ Call     │  │ Patient  │  │Callback │  │ Post-Call │ │
│  │ Detector │  │ Lookup   │  │ Queue   │  │ Actions   │ │
│  └────┬─────┘  └─────┬────┘  └────┬────┘  └─────┬─────┘ │
│       │              │            │              │        │
│  ┌────▼──────────────▼────────────▼──────────────▼──┐    │
│  │              EVENT QUEUE (offline-safe)            │    │
│  └──────────────────────┬────────────────────────────┘    │
└──────────────────────────┼────────────────────────────────┘
                           │ HTTPS + Bearer Token
                           ▼
┌──────────────────────────────────────────────────────────┐
│                    BACKEND SERVER                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ Call     │  │ Auth     │  │ Patient  │  │WhatsApp │ │
│  │ Engine   │  │ Service  │  │ Service  │  │ Service │ │
│  └────┬─────┘  └──────────┘  └──────────┘  └─────────┘ │
│       │                                                   │
│  ┌────▼──────────────────────────────────────────────┐   │
│  │              SQLite Database                        │   │
│  └───────────────────────┬───────────────────────────┘   │
│                          │                                │
│  ┌───────────────────────▼───────────────────────────┐   │
│  │              Socket.IO Emitter                      │   │
│  └───────────────────────┬───────────────────────────┘   │
└──────────────────────────┼────────────────────────────────┘
                           │ WebSocket
                           ▼
┌──────────────────────────────────────────────────────────┐
│                  ADMIN DASHBOARD (Browser)                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ Live     │  │ Call     │  │ Agent    │  │Analytics│ │
│  │ Wall     │  │ History  │  │ Monitor  │  │ Charts  │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
└──────────────────────────────────────────────────────────┘
```

---

## 4. MOBILE APP MODULES

### 4.1 Call Detector Module
The most critical module. Must capture ALL calls reliably.

**Three detection layers (priority order):**

| Layer | Mechanism | What it catches | Latency |
|-------|-----------|----------------|---------|
| 1. BroadcastReceiver | `PHONE_STATE_CHANGED` | Incoming ringing (immediate) | <1s |
| 2. BroadcastReceiver | `NEW_OUTGOING_CALL` | Outgoing dial (Android 9-) | <1s |
| 3. ContentObserver | `CallLog.Calls.CONTENT_URI` | ALL calls (incoming+outgoing, answered+missed) | 1-3s |

**ContentObserver is the KEY innovation.** Register it on `CallLog.Calls.CONTENT_URI`. Android fires `onChange()` every time a call log entry is written — this works on ALL Android versions including 10+, Samsung, Xiaomi. It's the **only reliable way** to detect outgoing calls on modern Android.

```kotlin
class CallLogObserver(handler: Handler, context: Context) : ContentObserver(handler) {
    override fun onChange(selfChange: Boolean, uri: Uri?) {
        // Query latest CallLog entry
        // Compare with last known entry (by ID or date)
        // If new: extract number, type, duration, send to server
    }
}

// Register in CallerIdService.onCreate():
contentResolver.registerContentObserver(
    CallLog.Calls.CONTENT_URI, true, callLogObserver
)
```

**Event dedup:** Track last processed CallLog entry ID. Only process entries with ID > lastProcessedId.

### 4.2 Call State Machine (App-side)

```
         ┌──────────┐
         │   IDLE   │
         └────┬─────┘
              │ phone_state = RINGING (incoming)
              │ OR new_outgoing_call (outgoing)
              │ OR calllog_new_entry
              ▼
         ┌──────────┐
         │ RINGING  │──── send event: {state: ringing, direction, phone}
         └────┬─────┘
              │
     ┌────────┼────────┐
     │        │        │
     ▼        ▼        ▼
┌────────┐ ┌──────┐ ┌──────────┐
│ANSWERED│ │MISSED│ │REJECTED  │
│        │ │      │ │          │
│ send   │ │ send │ │ send     │
│ event  │ │event │ │ event    │
└───┬────┘ └──┬───┘ └────┬─────┘
    │         │           │
    ▼         ▼           ▼
┌──────────────────────────────┐
│           ENDED              │
│ send: {duration, final_status}│
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│       POST-CALL SCREEN      │
│ disposition, notes, actions  │
└──────────────────────────────┘
```

### 4.3 Post-Call Action Sheet
After every call ends, show a bottom sheet:

```
┌─────────────────────────────┐
│  Call Ended: +923001234567  │
│  Patient: Sarah Ahmed       │
│  Duration: 3m 42s           │
│                             │
│  Disposition:               │
│  [Appt Booked] [Follow Up] │
│  [Inquiry] [Wrong Number]   │
│  [No Answer] [Other]        │
│                             │
│  Notes: ________________    │
│                             │
│  Actions:                   │
│  [📅 Book Appointment]      │
│  [📞 Create Callback]       │
│  [💬 Send WhatsApp]         │
│                             │
│  [Done ✓]                   │
└─────────────────────────────┘
```

### 4.4 App Screens

| Screen | Content |
|--------|---------|
| **Login** | Username + Password, server URL pre-filled |
| **Home/Calls** | Service status, today's KPIs (calls/answered/missed), recent call log |
| **Active Call** | Shows during call: patient name, timer, quick actions |
| **Post-Call** | Disposition + notes + action buttons |
| **Callbacks** | Pending callbacks sorted by priority, tap to call |
| **Patients** | Search by name/phone, view history, tap to call |
| **Appointments** | Today's calendar, appointment details |
| **Settings** | Server URL, logout, permissions |

### 4.5 Bottom Navigation
```
[ Calls ] [ Callbacks ] [ Patients ] [ Appointments ]
```

---

## 5. ADMIN DASHBOARD MODULES

### 5.1 Live Call Wall
Real-time view of all active calls across all agents.

```
┌─────────────────────────────────────────────────┐
│  LIVE CALLS (3 active)                          │
├─────────────────────────────────────────────────┤
│  🟢 Agent1 ← +923001234567 (Sarah Ahmed)       │
│     Duration: 2:15  Status: CONNECTED  IN       │
│                                                  │
│  🟡 Agent2 → +923009876543 (callback)           │
│     Duration: 0:45  Status: RINGING    OUT      │
│                                                  │
│  🔴 Agent3  Status: MISSED                      │
│     +923005551234  Duration: 0:00  1 min ago    │
└─────────────────────────────────────────────────┘
```

Updated via Socket.IO `call_state_changed` events.

### 5.2 Dashboard Tabs

| Tab | Purpose | Update Method |
|-----|---------|--------------|
| **Live** | Active calls + recent activity | Real-time (Socket.IO) |
| **History** | Full call log with filters | On-demand (API) |
| **Missed** | Missed calls needing follow-up | Real-time + API |
| **Callbacks** | Scheduled callbacks with assignment | Real-time + API |
| **Appointments** | Today's appointments with status | API + sync |
| **Agents** | Agent status, performance, management | Real-time status |
| **Analytics** | Charts, trends, conversion rates | API (period-based) |

### 5.3 KPI Cards (Real-time)
```
[ Calls Today: 47 ] [ Answered: 38 ] [ Missed: 9 ] [ Answer Rate: 81% ]
[ Outgoing: 12 ] [ Avg Duration: 4:23 ] [ Active Now: 3 ] [ Callbacks: 5 ]
```

---

## 6. CALL EVENT MODEL

### Normalized Event Structure
Every call interaction produces events in this format:

```json
{
  "event_id": "uuid-v4",
  "call_id": "call-uuid or call_sid",
  "agent": "agent1",
  "phone": "+923001234567",
  "direction": "inbound|outbound",
  "state": "ringing|connected|ended|missed|rejected",
  "source": "mobile_app|pc_monitor|manual",
  "patient_name": "Sarah Ahmed",
  "patient_id": "clinicea-id",
  "duration": 0,
  "timestamp": "2026-04-08T10:30:00.000Z",
  "device_id": "android-device-uuid",
  "metadata": {
    "contact_name": "From phone contacts",
    "call_log_id": 12345,
    "raw_call_type": "OUTGOING_TYPE"
  }
}
```

### Event Types
| State | When | Payload |
|-------|------|---------|
| `ringing` | Call starts ringing (in) or dialing (out) | phone, direction, contact_name |
| `connected` | Call answered | (implicit from ringing → connected transition) |
| `ended` | Call completed normally | duration, final_status (answered) |
| `missed` | Call not answered | duration=0 |
| `rejected` | Call declined by user | duration=0 |

### Server Processing
```
App sends event
    ↓
POST /api/v2/call-events
    ↓
CallEngine.processEvent(event):
  1. Dedup check (same call_id + state = skip)
  2. Validate state transition (ringing→connected OK, ended→ringing INVALID)
  3. Upsert call record
  4. Update agent presence (busy/available)
  5. Trigger patient lookup (if ringing + phone known)
  6. Emit socket event to dashboard
  7. If missed: create callback record
  8. Return {ok, call_id, patient_name}
```

---

## 7. CALL STATE MACHINE (Server-side)

```
                    ┌──────────┐
         ┌─────────│   IDLE   │─────────┐
         │         └──────────┘         │
         │ inbound_ringing      outbound_ringing
         ▼                              ▼
┌─────────────────┐          ┌─────────────────┐
│ INBOUND_RINGING │          │OUTBOUND_RINGING │
└───────┬─────────┘          └───────┬─────────┘
        │                            │
   ┌────┼────┐                  ┌────┼────┐
   │    │    │                  │    │    │
   ▼    ▼    ▼                  ▼    ▼    ▼
 ANS  MISS  REJ              ANS  NOANS  FAIL
   │    │    │                  │    │    │
   └────┼────┘                  └────┼────┘
        ▼                            ▼
   ┌─────────┐                  ┌─────────┐
   │  ENDED  │                  │  ENDED  │
   └────┬────┘                  └────┬────┘
        │                            │
        ▼                            ▼
  ┌───────────┐                ┌───────────┐
  │POST_CALL  │                │POST_CALL  │
  │disposition│                │disposition│
  │notes      │                │notes      │
  │actions    │                │actions    │
  └───────────┘                └───────────┘
```

### Valid Transitions
| From | To | Trigger |
|------|----|---------|
| IDLE | INBOUND_RINGING | App: ringing + direction=inbound |
| IDLE | OUTBOUND_RINGING | App: ringing + direction=outbound |
| INBOUND_RINGING | ANSWERED | App: connected or CallLog duration>0 |
| INBOUND_RINGING | MISSED | App: ended + duration=0 + no answer |
| INBOUND_RINGING | REJECTED | App: ended + rejected flag |
| OUTBOUND_RINGING | ANSWERED | App: connected or CallLog duration>0 |
| OUTBOUND_RINGING | NO_ANSWER | App: ended + duration=0 |
| ANSWERED | ENDED | App: ended + duration>0 |
| MISSED | ENDED | Immediate (no duration) |
| ENDED | POST_CALL | Client-side (post-call screen shows) |

### Auto-finalize Rules
- If stuck in RINGING > 5 minutes → auto-transition to MISSED
- If stuck in ANSWERED > 4 hours → auto-transition to ENDED
- Run cleanup every 60 seconds

---

## 8. DATABASE DESIGN

### New/Modified Tables

#### call_events (NEW — raw event log)
```sql
CREATE TABLE call_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL,
  call_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  phone TEXT NOT NULL,
  direction TEXT NOT NULL,        -- 'inbound', 'outbound'
  state TEXT NOT NULL,            -- 'ringing', 'connected', 'ended', 'missed', 'rejected'
  source TEXT DEFAULT 'mobile_app', -- 'mobile_app', 'pc_monitor'
  duration INTEGER DEFAULT 0,
  contact_name TEXT,
  device_id TEXT,
  metadata TEXT,                  -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ce_call_id ON call_events(call_id);
CREATE INDEX idx_ce_agent ON call_events(agent);
CREATE INDEX idx_ce_created ON call_events(created_at DESC);
```

#### calls (MODIFIED — add fields)
```sql
-- Add these columns to existing calls table:
ALTER TABLE calls ADD COLUMN call_state TEXT DEFAULT 'idle';
  -- 'idle','inbound_ringing','outbound_ringing','answered','missed','rejected','ended'
ALTER TABLE calls ADD COLUMN device_id TEXT;
ALTER TABLE calls ADD COLUMN linked_callback_id INTEGER;
ALTER TABLE calls ADD COLUMN linked_appointment_id TEXT;
ALTER TABLE calls ADD COLUMN post_call_completed INTEGER DEFAULT 0;
```

#### device_registrations (NEW — for push notifications)
```sql
CREATE TABLE device_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  device_id TEXT NOT NULL,
  fcm_token TEXT,
  platform TEXT DEFAULT 'android',
  app_version TEXT,
  last_seen DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(agent, device_id)
);
```

#### callbacks (MODIFIED — add fields)
```sql
ALTER TABLE callbacks ADD COLUMN linked_outgoing_call_id INTEGER;
ALTER TABLE callbacks ADD COLUMN priority TEXT DEFAULT 'normal'; -- 'urgent','normal','low'
ALTER TABLE callbacks ADD COLUMN scheduled_at DATETIME;
```

---

## 9. API DESIGN

### v2 API Routes

#### Call Events (Mobile App → Server)
```
POST   /api/v2/call-events          — Submit call state change
GET    /api/v2/calls                 — Agent's call history (paginated)
GET    /api/v2/calls/:id             — Single call detail
POST   /api/v2/calls/:id/disposition — Set disposition + notes
POST   /api/v2/calls/:id/callback   — Create callback from call
```

#### Agent (Mobile App)
```
POST   /api/v2/auth/login            — Login, get token
POST   /api/v2/auth/refresh          — Refresh token (before expiry)
POST   /api/v2/agent/status          — Set agent status
POST   /api/v2/agent/heartbeat       — Keep-alive ping
GET    /api/v2/agent/me              — Current agent profile
```

#### Patients (Mobile App)
```
GET    /api/v2/patients/search?q=    — Search by name/phone
GET    /api/v2/patients/:id          — Patient detail + history
```

#### Callbacks (Mobile App + Dashboard)
```
GET    /api/v2/callbacks              — Pending callbacks
POST   /api/v2/callbacks/:id/assign   — Assign to agent
POST   /api/v2/callbacks/:id/resolve  — Mark as resolved
POST   /api/v2/callbacks/:id/call     — Initiate callback call
```

#### Appointments (Mobile App + Dashboard)
```
GET    /api/v2/appointments?date=     — Day's appointments
POST   /api/v2/appointments/:id/confirm — Send confirmation
```

#### Admin Dashboard
```
GET    /api/v2/admin/live             — Active calls + agent status
GET    /api/v2/admin/overview?period= — KPIs with period filter
GET    /api/v2/admin/history          — Full call history (paginated)
GET    /api/v2/admin/agents           — Agent list + performance
GET    /api/v2/admin/analytics        — Charts data
GET    /api/v2/admin/export           — CSV export
```

### Event Payload: POST /api/v2/call-events
```json
{
  "event_id": "uuid",
  "call_id": "mobile-1712550000",
  "phone": "+923001234567",
  "direction": "inbound",
  "state": "ringing",
  "contact_name": "Sarah Ahmed",
  "duration": 0,
  "device_id": "android-xxx",
  "timestamp": "2026-04-08T10:30:00Z"
}
```

### Response
```json
{
  "ok": true,
  "call_id": "mobile-1712550000",
  "patient": {
    "name": "Sarah Ahmed",
    "id": "clinicea-123",
    "phone": "+923001234567",
    "last_visit": "2026-03-15"
  }
}
```

---

## 10. REAL-TIME / SOCKET DESIGN

### Events: Server → Dashboard

| Event | Rooms | Payload | When |
|-------|-------|---------|------|
| `call_state_changed` | agent + admin | Full call object with state | Any call state change |
| `agent_status` | admin | {agent, status, active_call} | Agent goes online/offline/busy |
| `callback_created` | admin | {callback object} | Missed call → callback |
| `callback_resolved` | admin | {callback_id, resolved_by} | Callback completed |

### Simplified Event Model
**One event for everything:** `call_state_changed` replaces the current `incoming_call`, `patient_info`, `call_updated` trio.

```json
{
  "event": "call_state_changed",
  "data": {
    "call_id": "mobile-123",
    "agent": "agent1",
    "phone": "+923001234567",
    "direction": "inbound",
    "state": "ringing",
    "patient_name": "Sarah Ahmed",
    "duration": 0,
    "timestamp": "2026-04-08T10:30:00Z"
  }
}
```

Dashboard listens for ONE event and updates all views (live wall, history, KPIs, agent status).

### Rooms (Same as v1)
- `agent:{username}` — agent's own events
- `role:admin` — all events

---

## 11. RECOMMENDED UX FLOW

### Agent: Incoming Call
```
1. Phone rings → Android shows native call screen
2. App detects ringing → sends event → server updates dashboard
3. Agent answers/misses → app detects → sends event
4. Call ends → post-call screen slides up automatically
5. Agent selects disposition, types note, taps "Done"
6. If "Appointment Booked" → confirmation message queued
7. If missed → callback auto-created, appears in agent's callback queue
```

### Agent: Outgoing Call (Callback)
```
1. Agent opens Callbacks tab → sees pending list
2. Taps "Call" on a callback → phone dialer opens with number
3. App detects outgoing call → sends event (linked to callback_id)
4. Call connects/ends → normal flow
5. Post-call screen → "Callback resolved" auto-selected
6. Callback marked as resolved in DB
```

### Admin: Monitoring
```
1. Opens dashboard → Live tab shows current activity
2. Sees 3 agents online, 1 on call, 1 idle
3. Call comes in → card appears in live wall with direction badge
4. Agent answers → card updates to "CONNECTED" with timer
5. Call ends → card moves to recent activity
6. Missed call → card turns red, callback auto-appears in queue
7. Admin can click any call for full details
```

---

## 12. PHASE-WISE BUILD PLAN

### Phase 1: Core Call Engine (1-2 weeks)
**Goal:** Mobile app reliably detects and reports ALL calls.

- [ ] Implement ContentObserver for CallLog (replaces unreliable NEW_OUTGOING_CALL)
- [ ] Add event dedup (track last processed CallLog ID)
- [ ] Add POST /api/v2/call-events endpoint on server
- [ ] Add CallEngine.processEvent() with state machine
- [ ] Add call_events table
- [ ] Add call_state field to calls table
- [ ] Emit `call_state_changed` socket event
- [ ] Dashboard: replace `incoming_call` listener with `call_state_changed`
- [ ] Test: incoming call detected + dashboard updated in <2s
- [ ] Test: outgoing call detected + dashboard updated in <3s

### Phase 2: Post-Call Workflow (1 week)
**Goal:** Agent can complete post-call actions from mobile.

- [ ] Post-call bottom sheet UI in app
- [ ] POST /api/v2/calls/:id/disposition endpoint
- [ ] POST /api/v2/calls/:id/callback endpoint
- [ ] Auto-create callback on missed calls
- [ ] Callback queue screen in app
- [ ] Callback-to-outgoing-call linkage
- [ ] Dashboard: callback queue real-time updates

### Phase 3: Native App Screens (1-2 weeks)
**Goal:** Agent has a proper native app (not WebView).

- [ ] Native Calls screen (today's KPIs + recent calls)
- [ ] Native Callbacks screen (pending list + tap to call)
- [ ] Native Patients screen (search + history)
- [ ] Native Appointments screen (today's calendar)
- [ ] Patient lookup on incoming call (show in post-call screen)
- [ ] Bottom navigation: Calls | Callbacks | Patients | Appointments

### Phase 4: Admin Dashboard Upgrade (1 week)
**Goal:** Admin dashboard uses unified call events.

- [ ] Live Call Wall (real-time active calls)
- [ ] Unified call history (incoming + outgoing, properly labeled)
- [ ] Outgoing call KPIs and widgets
- [ ] Agent performance with outgoing metrics
- [ ] Callback conversion tracking (callback → outgoing call → resolved)
- [ ] Period selector on all views (today/yesterday/week/month)

### Phase 5: Polish & Notifications (1 week)
**Goal:** Production-ready.

- [ ] Push notifications via FCM (for backgrounded app)
- [ ] Device registration endpoint
- [ ] Token refresh mechanism
- [ ] Battery optimization guide for Samsung/Xiaomi
- [ ] Error reporting (Crashlytics or equivalent)
- [ ] Remove legacy PC monitor dependency
- [ ] Performance testing under load

---

## 13. RISKS AND EDGE CASES

### Android-Specific Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Samsung kills foreground service | Calls not detected | Battery optimization bypass + START_STICKY + BootReceiver |
| Xiaomi restricts ContentObserver | Outgoing calls missed | Fall back to CallLog poller (10s) |
| READ_CALL_LOG permission denied | No call data | Show persistent prompt, explain why needed |
| Dual SIM phones | Wrong number reported | Use CallLog which reports correct number |
| VoIP calls (WhatsApp/Viber) | Not in CallLog | Separate detection via NotificationListener |
| App force-stopped by user | No detection | Show warning, offer "pin" in recent apps |

### Server-Side Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Duplicate events from app | Double call entries | Dedup by call_id + state combination |
| Events arrive out of order | Wrong state | State machine validates transitions, queue out-of-order |
| Mobile offline during call | Dashboard stale | Queue events, process on reconnect, mark as "delayed" |
| Token expires during call | Event rejected | 401 response triggers silent token refresh |
| Server restart mid-call | Active calls lost | Persist call state in DB, recover on restart |

### UX Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Agent forgets post-call | No disposition | Auto-prompt, can't dismiss without action (or 2-min timeout) |
| Too many callbacks pending | Agent overwhelmed | Priority sorting, age-based auto-escalation |
| Patient not found in Clinicea | No patient info | Show phone number, allow manual entry |
| Slow Clinicea API | Dashboard lag | Cache aggressively, show call without patient info first |

---

*End of Architecture Document*
