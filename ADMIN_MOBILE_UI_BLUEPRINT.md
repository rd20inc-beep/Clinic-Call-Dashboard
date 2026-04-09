# Admin Mobile Dashboard — UI/UX Redesign Blueprint

## 1. CURRENT MOBILE UI PROBLEMS

### Layout Issues
- KPI cards are cramped — 3 per row with tiny text on small phones
- Agent list uses generic makeCard() — looks identical to patient/callback cards, no visual distinction
- Admin sub-tabs (Overview/Full Console) use plain text buttons that look like regular tabs
- No greeting or context — admin opens tab and sees raw numbers without context
- No visual separation between KPI sections — everything runs together
- WebView "Full Console" loads desktop HTML shrunken into mobile — unusable
- Tab bar at bottom competes with Android navigation bar on gesture phones

### Interaction Issues
- No pull-to-refresh — must switch tabs to reload
- Agent status dots use emoji (🟢🟡🟠⚫) — inconsistent rendering across devices
- No quick actions — admin can't do anything from overview without switching tabs
- Call/appointment counts shown but not tappable — no drill-down

### Typography Issues
- KPI numbers at 22-26sp are too large on small phones, cause wrapping
- Labels at 10-11sp are too small to read
- No clear hierarchy between primary and secondary metrics
- monospace font for call log feels dated

## 2. MOBILE UX STRATEGY

### Principles
1. **Scan in 5 seconds** — admin opens app, instantly sees: how many calls, who's online, what needs attention
2. **Act in 2 taps** — from overview to any action within 2 taps maximum
3. **Cards over tables** — every data point is a card, not a table cell
4. **Summary first, detail second** — show totals, tap to expand
5. **Thumb zone** — critical actions in bottom 60% of screen

### Information Priority (top to bottom)
1. Greeting + date + quick status
2. Attention items (pending callbacks, missed calls needing action)
3. Today's KPIs (calls, answered, missed, rate)
4. Agent status cards
5. Secondary KPIs (talk time, appointments, outgoing)
6. Quick action shortcuts
7. Full console link

## 3. NEW ADMIN DASHBOARD MOBILE STRUCTURE

```
┌─────────────────────────────────────┐
│  Header: "Good morning, Admin"      │
│  Wed, 9 Apr · 3 agents online       │
├─────────────────────────────────────┤
│  🔴 ATTENTION: 5 pending callbacks  │ ← tappable alert card
├─────────────────────────────────────┤
│  ┌──────┐ ┌──────┐ ┌──────┐        │
│  │  313 │ │  142 │ │  123 │        │ ← primary KPIs
│  │Calls │ │ Ans  │ │ Miss │        │
│  └──────┘ └──────┘ └──────┘        │
│                                      │
│  ┌──────┐ ┌──────┐ ┌──────┐        │
│  │  81% │ │ 102m │ │   9  │        │ ← secondary KPIs
│  │ Rate │ │ Talk │ │  Out │        │
│  └──────┘ └──────┘ └──────┘        │
├─────────────────────────────────────┤
│  Agent Status                        │
│  ┌─────────────────────────────┐    │
│  │ 🟢 Sarah  Online  24 calls │    │ ← agent cards
│  │    18 ans · 6 miss          │    │
│  ├─────────────────────────────┤    │
│  │ 🟡 Ahmed  Busy    12 calls │    │
│  │    10 ans · 2 miss          │    │
│  ├─────────────────────────────┤    │
│  │ ⚫ Fatima Offline  0 calls  │    │
│  └─────────────────────────────┘    │
├─────────────────────────────────────┤
│  Quick Actions                       │
│  [📊 Full Console] [📞 Callbacks]   │
│  [📅 Appointments] [👥 Agents]      │
├─────────────────────────────────────┤
│  Appointments Today: 15              │
│  By agents: 8                        │
│  Week: 1,847 · Month: 6,230         │
└─────────────────────────────────────┘
```

## 4. SCREEN-BY-SCREEN LAYOUT

### Screen: Admin Overview (Default)
- **Header section**: Greeting with time-aware text + date + online agent count
- **Alert bar**: Red/amber if pending callbacks > 0, tappable → switches to Callbacks tab
- **Primary KPIs row**: 3 cards — Calls, Answered, Missed (largest text, most prominent)
- **Secondary KPIs row**: 3 cards — Answer Rate, Talk Time, Outgoing (smaller, muted)
- **Agent section header**: "Agent Status" with count badge
- **Agent cards**: Each agent as a row card with colored status dot, name, calls/answered/missed
- **Quick actions grid**: 2×2 buttons for Full Console, Callbacks, Appointments, Agents
- **Footer stats**: Week/month totals, appointments today

### Screen: Full Console (WebView)
- Same WebView as current but with a "← Back to Overview" button at top
- WebView loads with viewport meta tag respected

## 5. COMPONENT BEHAVIOR

| Component | Current | Redesigned |
|-----------|---------|-----------|
| KPI number | 22-26sp crammed | 20sp primary, 16sp secondary |
| KPI label | 10sp hard to read | 11sp with better contrast |
| Agent card | Generic makeCard() | Custom card with status dot, name large, stats row below |
| Status dot | Emoji 🟢🟡🟠⚫ | Native View circle (8dp) with programmatic color |
| Alert | Not shown | Red/amber card at top if action needed |
| Quick actions | None | 2×2 grid of action buttons |
| Pull to refresh | None | SwipeRefreshLayout wrapper |

## 6. VISUAL STYLE RULES

- **Background**: #F5F5F5 (light gray)
- **Cards**: #FFFFFF, 12dp radius, 2dp elevation
- **Primary text**: #1a1a2e, 15sp bold
- **Secondary text**: #555555, 13sp
- **Muted text**: #999999, 11sp
- **Accent blue**: #1565c0
- **Success green**: #2e7d32
- **Danger red**: #c62828
- **Warning amber**: #e65100
- **Purple**: #7b1fa2
- **Card padding**: 16dp horizontal, 14dp vertical
- **Section spacing**: 16dp between sections
- **Card gap**: 8dp between cards in same section

## 7. NO BACKEND/SYSTEM CHANGES CHECKLIST
- ✅ Same API: GET /admin/analytics/overview
- ✅ Same data fields: callsToday, answeredToday, missedToday, answerRate, etc.
- ✅ Same auth: Bearer token
- ✅ Same agent data: agentStats array
- ✅ Same WebView auth bridge: /api/app/auth-session
- ✅ No new endpoints needed
- ✅ No database changes
- ✅ No permission changes
- ✅ No workflow changes
