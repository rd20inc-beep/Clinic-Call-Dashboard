# Dr. Nakhoda's Skin Institute — Clinic CRM Dashboard

A comprehensive call management, patient tracking, and WhatsApp communication platform built for clinic operations.

---

## System Overview

| Component | Technology |
|-----------|-----------|
| Backend | Node.js + Express |
| Database | SQLite (WAL mode) |
| Real-time | Socket.IO |
| Frontend | Vanilla JS + CSS |
| WhatsApp | whatsapp-web.js |
| Mobile App | Android (Kotlin) |
| Deployment | PM2 + GitHub Actions |

---

## Features

### 1. Call Management

#### Live Call Tracking
- Real-time incoming/outgoing call detection via mobile app
- Phone and WhatsApp call support
- Caller ID with contact name resolution
- Direction tracking (inbound/outbound)
- Source tracking (Phone/WhatsApp badges)
- Call duration recording
- Automatic patient lookup via Clinicea API

#### Call History
- Full paginated call log with filters
- Filter by: Status, Direction, Agent, Disposition, Source, Date Range
- Search by patient name or phone number
- Clickable direction badge to correct In/Out
- Call disposition tracking (Appt Booked, Follow Up, Inquiry, Wrong #, Existing)
- Agent notes on calls (max 500 chars)
- Quick message agent about a specific call

#### Call Status Management
- Auto-finalization of stale calls (15 min timeout)
- Admin can manually fix call status
- Status types: Answered, Missed, Rejected, No Answer, Unknown

---

### 2. Agent Management

#### Agent Profiles
- Database-driven agents (auto-migrated from env vars)
- Create/Edit/Delete agents with: Username, Password, Full Name, Role, Phone, Email, Notes
- Roles: Admin, Agent, Supervisor
- Activate/Deactivate agents
- Soft delete with restore from archive
- Password reset (bcrypt hashed, auto-migrated from plaintext)

#### Real-Time Agent Status Engine
- Computed presence: Online, Busy, Idle, Offline, Disabled, Never Connected
- Three connection sources tracked independently:
  - Portal (green dot) — web dashboard socket
  - Mobile (blue dot) — mobile app heartbeat
  - Monitor (yellow dot) — PC call monitor
- Busy status when agent is handling a call (auto-clears after 5 min if call_ended never received)
- Idle detection after 2 minutes of inactivity
- Status persists in database across server restarts
- Agent self-service status: Available / Busy / On Break

#### Agent Performance Analytics
- Per-agent metrics: Today/Week/Total calls, Answered, Missed, Answer Rate
- Talk time: Today, Week, Total, Average, Longest call
- Performance score: (answered x 2) - (missed x 3) + (talk_time / 300)
- Sortable by: Status, Calls, Talk Time, Rate, Score, Last Seen
- Filterable by: Online, Idle, Offline

#### Single Device Login
- One mobile session per agent
- New login invalidates all previous tokens
- 24-hour token TTL with automatic cleanup

---

### 3. Admin Dashboard

#### KPI Cards
- Today's total calls, Inbound, Outbound, Answered, Missed
- Today's talk time, Average duration
- Clickable cards filter call history

#### Agent Snapshot
- Active/Idle/Offline agent counts
- Recent activity feed (last 5 calls)

#### Alerts
- Missed call warnings (>5 today, >3 in last hour)
- No active agents warning (checked against DB, not just in-memory)
- Dismissable with session persistence
- Clickable to filter relevant calls

#### Charts (Chart.js)
- Calls Today by Hour (stacked bar)
- 7-Day Trend (daily columns)
- Agent Performance This Week (horizontal bars)

#### Callback Badge
- Persistent banner showing pending callback count
- Click to navigate to Admin Console callbacks tab
- Auto-refreshes every 60 seconds

---

### 4. Admin Console (Full Analytics)

#### Overview Tab
- 8 KPI cards (Calls, Answered, Missed, Answer Rate, Appointments, Talk Time, Avg Duration, Pending Callbacks)
- Status strip (Active agents, Portal online, Mobile online, Rejected, Outgoing)
- Charts: Calls Per Agent, Answered vs Missed
- Agent Quick View table with presence badges, connection dots, call stats, appointments

#### Trends Tab
- Call Volume Trend (7/14/30/60 days, stacked: Answered/Missed/Outgoing)
- Talk Time Trend (line chart)
- Today vs This Week by Agent
- Talk Time by Agent
- Agent filter dropdown

#### Leaderboard Tab
- Ranked agent list by: Calls, Talk Time, Answer Rate, Score
- Period filters: Today, Yesterday, This Week, This Month, All Time
- Appointment attribution per agent

#### Call History Tab
- Full filter bar: Agent, Status, Type, Source, Date Range, Search
- Paginated with direction/status badges
- Admin can fix call status

#### Callbacks Tab
- KPI cards: Pending, Overdue (>2hr), Resolved, Recovery Rate
- Filter tabs: Pending, Assigned, Overdue, All, Resolved
- Age indicator (color-coded: green <2h, yellow <24h, red >24h)
- Assign to agent dropdown
- Notes per callback
- Actions: Called Back, Unreachable, Resolved, Dismiss
- Bulk actions: Dismiss Old (7d+), Dismiss All Pending
- Agent display names (not usernames)
- Auto-created from missed calls

#### Agent Management Tab
- Table: Username, Name, Role, Status, Phone, Last Login, Device, Actions
- Actions dropdown: Edit, Change Password, Enable/Disable, Reset Stats, Force Logout, Delete History, Delete Agent
- Add/Edit Agent modal with: Username, Password, Full Name, Role, Phone, Email
- Archived agents with restore
- Audit log with color-coded actions

#### Audit Log Tab
- All admin actions logged: agent CRUD, password changes, status changes, force logout, callback actions
- Timestamp, Admin, Action, Target, Details

#### Performance Detail Modal
- 13 KPI cards across 3 rows
- Chart.js charts: Daily Calls (14-day), Hourly Distribution
- Recent Calls table with filter (All/Answered/Missed/Outgoing/Appointments)
- Appointments section with service/doctor filters
- Connection status dots (Portal/Mobile/Monitor)

---

### 5. WhatsApp Integration

#### Connection
- whatsapp-web.js with QR code authentication
- QR displayed on dashboard for phone scanning
- Connection status bar (Connected/Scan QR/Authenticating/Disconnected)
- Disconnect/Reconnect buttons for all users
- Session persists across server restarts (LocalAuth)
- Auto-reconnect on disconnect (30-second delay)

#### Messaging System
- Outgoing only (no AI auto-replies)
- Business hours enforcement: 9 AM - 7 PM Pakistan time
- Message types: Confirmation, Reminder, Review, Aftercare, Chat
- Approval queue: messages require admin approval before sending
- Message status lifecycle: Pending → Approved → Sending → Sent (or Expired/Failed/Rejected)
- Double-send prevention (sending lock)
- Stale message expiry (approved >10 min, sending >5 min)
- Deduplication via wa_message_id

#### Appointment Messages
- Auto-generated confirmations when appointments are synced from Clinicea
- Auto-generated reminders (0-2 days before appointment)
- Grouped by patient (one message for multiple appointments)
- Time displayed in Pakistan timezone (no UTC conversion)

#### Calendar Integration
- Pre-visit buttons: Confirm, Remind, Message
- Post-visit buttons (Check Out): Review, Aftercare, Message
- Message preview modal before sending
- Tracking badges on calendar: Confirmed, Reminded, Review Sent, Aftercare Sent
- Visible to all agents/admins

#### Aftercare Messages (Service-Specific)
- Laser/Hair Removal
- HydraFacial
- Botox/Fillers
- Chemical Peel
- Microneedling/PRP
- General (default)
- Custom templates (admin-created per service)

#### Message Templates
- 9+ default templates (confirmation, reminder, review, 6 aftercare)
- Admin template editor on WhatsApp Bot page
- Variable placeholders: {name}, {date}, {time}, {service}, {doctor}, {day_word}, {appointments}
- Create custom service-specific templates
- Preview with sample data
- Reset to default
- Delete custom templates

#### Global Controls
- Bot enable/disable toggle (persists in DB)
- Per-chat pause/resume (DB-persisted)
- Message approval queue with expand/collapse

---

### 6. Patient Management

#### All Patients Page
- Table: Patient, Doctor, Service, Last Appt, Actions
- Filter by: Doctor, Service
- Sort by: Most Recent, Name A-Z, Phone
- Search by: Name, Phone, Email
- Edit patient details (local DB patients)
- WhatsApp link per patient
- Click to open Clinicea patient profile

#### Patient Data Sources
- Clinicea API (synced on demand)
- Local DB (from appointments + calls)
- Merged and deduplicated by phone number
- Auto-created from: appointment sync, incoming/outgoing calls

#### Patient Profile Modal
- Clinicea patient details
- Appointment history
- Billing information

---

### 7. Calendar / Appointments

#### Daily Appointment View
- Date picker with Prev/Next/Today buttons
- Appointment cards with: Patient, Service, Doctor, Time, Status
- Status colors: Scheduled (yellow), Confirmed (teal), Engaged (purple), Check Out (green), Cancelled (grey)
- Status guide tooltip

#### Filters
- Search by patient name
- Filter by: Status, Doctor, Service
- Clear all filters
- Count: "X of Y" when filtered

#### Message Tracking
- Badges on each card: Confirmed, Reminded, Review Sent, Aftercare Sent
- Visible to all users

---

### 8. Mobile App (CallerID)

#### Authentication
- POST /api/agent/login with agent_id + password
- Bearer token authentication
- Single device enforcement
- 24-hour token TTL

#### Call Detection
- Phone calls via BroadcastReceiver + CallLog polling
- WhatsApp calls via NotificationListenerService
- Incoming + Outgoing detection
- Call duration + status reporting

#### Heartbeat
- POST /api/app/heartbeat every 60 seconds
- Keeps agent status Online
- Updates last_seen in DB

#### Features
- Offline call queue (200 max, 24hr retention)
- Encrypted credential storage (AES256-GCM)
- HTTPS enforced
- APK downloadable from dashboard sidebar

---

### 9. Internal Messaging

#### Chat Widget
- Floating blue chat button (bottom-right corner)
- Contact list with all active users
- Real-time messaging via Socket.IO
- Message history (persistent in DB)
- Unread message count badge
- Notification sound on new messages

#### Admin Messaging
- Direct message to specific agent
- Broadcast to all active agents
- Blue toast notification on agent dashboard
- Message button on each agent in management table
- Quick message from call history (pre-built templates for missed/answered calls)

---

### 10. Reporting & Export

#### Weekly Report API
- This week vs last week comparison
- Change percentages (calls, talk time)
- Best agent by calls and talk time
- Agent rankings with all metrics
- Daily breakdown with calls + talk time
- Peak hours by calls and talk time
- Low-activity agent detection

#### CSV Export
- /admin/analytics/export endpoint
- Filter by: range (today/week/month/all), agent
- Downloads as CSV file

---

### 11. Security

- Bcrypt password hashing (auto-migration from plaintext on login)
- Session-based auth for web dashboard
- Bearer token auth for mobile app
- Rate limiting on login (15 attempts / 15 min)
- Rate limiting on API calls
- CORS with allowed origins
- Helmet security headers
- HTTPS enforced on mobile app
- Admin-only route protection (requireAdmin middleware)
- Audit logging for all admin actions
- Force Logout All (dashboard + mobile)

---

### 12. Infrastructure

#### Database
- SQLite with WAL mode
- Tables: calls, users, patients, callbacks, wa_messages, wa_appointment_tracking, wa_settings, wa_paused_chats, internal_messages, audit_log
- Idempotent migrations (ALTER TABLE with try/catch)
- One-time data seeding on startup

#### Deployment
- GitHub Actions auto-deploy on push to main
- PM2 process management with TZ=Asia/Karachi
- Delete + recreate PM2 process on deploy (ensures correct entry point)

#### Caching
- Patient cache (Clinicea API, 10 min TTL)
- Appointment date cache (5 min TTL)
- Admin cache clear endpoint
- Clinicea API lookup timeout (8 seconds)

#### Monitoring
- Agent heartbeat tracking (90s stale threshold)
- Monitor log storage (50 agents x 50KB max)
- Server event log (last 50 entries)
- Idle sweep every 30 seconds

---

## API Endpoints

### Authentication
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /login | None | Web dashboard login |
| GET | /logout | Session | Logout |
| GET | /api/me | Session | Current user info |
| POST | /api/agent/login | None | Mobile app login |

### Calls
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /incoming_call | Webhook | PC monitor call webhook |
| POST | /api/incoming-call | Bearer | Mobile app call event |
| GET | /api/calls | Session | Paginated call history with filters |
| POST | /api/calls/:id/status | Session | Fix call status |
| POST | /api/calls/:id/direction | Session | Fix call direction |
| POST | /api/calls/:id/disposition | Session | Set call outcome |
| POST | /api/calls/:id/notes | Session | Add call notes |
| GET | /api/call-stats | Session | Dashboard KPIs |
| GET | /api/call-analytics | Admin | Charts data |

### Agents
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/agents | Admin | List all agents with metrics |
| POST | /api/agents/create | Admin | Create agent |
| POST | /api/agents/update | Admin | Update agent |
| POST | /api/agents/change-password | Admin | Reset password |
| POST | /api/agents/toggle-active | Admin | Activate/deactivate |
| POST | /api/agents/delete | Admin | Soft delete |
| POST | /api/agents/restore | Admin | Restore deleted |
| GET | /api/agents/archived | Admin | List deleted agents |
| GET | /api/agents/performance | Admin | Per-agent analytics |
| GET | /api/leaderboard | Admin | Ranked agent list |
| POST | /api/agent/set-status | Session | Agent sets own status |
| POST | /api/force-logout-all | Admin | Disconnect all agents |

### WhatsApp
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/whatsapp/send | Session | Queue message |
| GET | /api/whatsapp/stats | Session | Message stats |
| GET | /api/whatsapp/conversations | Session | Conversation list |
| GET | /api/whatsapp/history/:phone | Session | Chat history |
| GET | /api/whatsapp/pending-approval | Session | Approval queue |
| POST | /api/whatsapp/approve | Session | Approve message |
| POST | /api/whatsapp/reject | Session | Reject message |
| POST | /api/whatsapp/bot-toggle | Admin | Enable/disable bot |
| GET | /api/whatsapp/connection-status | Session | WA client status |
| POST | /api/whatsapp/wa-logout | Admin | Disconnect WA |
| POST | /api/whatsapp/wa-reconnect | Admin | Reconnect WA |
| GET | /api/whatsapp/templates | Session | Get all templates |
| POST | /api/whatsapp/templates | Admin | Save template |
| POST | /api/whatsapp/templates/create | Admin | Create custom template |
| POST | /api/whatsapp/templates/delete | Admin | Delete custom template |
| POST | /api/whatsapp/templates/reset | Admin | Reset to default |
| POST | /api/whatsapp/templates/preview | Session | Preview with sample data |

### Patients
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/patients | Session | Paginated patient list |
| POST | /api/patients/edit | Session | Edit local patient |

### Callbacks
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /admin/callbacks/summary | Admin | Callback KPIs |
| GET | /admin/callbacks | Admin | Paginated callback list |
| POST | /admin/callbacks/:id/status | Admin | Update status |
| POST | /admin/callbacks/:id/assign | Admin | Assign to agent |
| POST | /admin/callbacks/:id/notes | Admin | Add notes |
| POST | /admin/callbacks/dismiss-all | Admin | Bulk dismiss |
| POST | /admin/callbacks/dismiss-old | Admin | Dismiss older than X days |

### Admin
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/audit-log | Admin | Audit trail |
| GET | /api/weekly-report | Admin | Weekly analytics |
| GET | /admin/analytics/overview | Admin | Full overview data |
| GET | /admin/analytics/trends | Admin | Daily trends |
| GET | /admin/analytics/export | Admin | CSV export |
| POST | /api/admin/clear-cache | Admin | Clear API caches |
| POST | /admin/message-agent | Admin | Direct message to agent |
| POST | /admin/broadcast | Admin | Broadcast to all agents |

### Chat
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/chat/send | Session | Send chat message |
| GET | /api/chat/history/:user | Session | Chat history |
| GET | /api/chat/unread | Session | Unread counts |
| GET | /api/chat/contacts | Session | Contact list |

---

## Socket.IO Events

| Event | Direction | Description |
|-------|-----------|-------------|
| incoming_call | Server → Client | New call notification |
| call_updated | Server → Client | Call status/duration update |
| patient_info | Server → Client | Patient lookup result |
| monitor_status | Server → Client | Agent monitor heartbeat |
| agent_status_update | Server → Client | Agent presence change |
| agent_presence | Server → Client | Agent connect/disconnect |
| wa_message | Server → Client | WhatsApp message received |
| wa_connection | Server → Client | WhatsApp client status |
| admin_message | Server → Client | Admin direct message |
| chat_message | Bidirectional | Internal chat message |
| activity | Client → Server | Frontend activity ping |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| SESSION_SECRET | Yes | Express session secret |
| WEBHOOK_SECRET | Yes | Call monitor webhook auth |
| PORT | No | Server port (default: 3000) |
| CLINICEA_API_KEY | No | Clinicea API authentication |
| CLINICEA_STAFF_USERNAME | No | Clinicea staff login |
| CLINICEA_STAFF_PASSWORD | No | Clinicea staff password |
| GROQ_API_KEY | No | Groq API for AI (currently unused) |
| TRUST_PROXY | No | Proxy trust level (default: 1) |
| ALLOWED_CORS_ORIGINS | No | Comma-separated CORS origins |

---

## Branding

- Clinic: Dr. Nakhoda's Skin Institute
- Location: GPC 11, Rojhan Street, Block 5, Clifton, Karachi
- Phone: +92-300-2105374, +92-321-3822113
- Google Maps: https://maps.app.goo.gl/YadKKdh4911HmxKL9
- Business Hours: 9 AM - 7 PM (WhatsApp messaging restricted to these hours)

---

Built with Node.js, Express, SQLite, Socket.IO, and whatsapp-web.js.
