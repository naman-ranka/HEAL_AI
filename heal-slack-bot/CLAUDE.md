# HEAL Slack Bot — Claude Context

## What this is

A Slack bot (Node.js, `@slack/bolt` v4, socket mode) that acts as a healthcare financial
advocate. Users upload insurance policies and medical bills; the bot cross-references them
for errors, answers coverage questions via RAG, finds nearby hospitals, books campus health
center appointments, and sends formal billing dispute letters by email.

Talks to the HEAL FastAPI backend at `http://localhost:8000` via axios.

---

## File map

| File | Purpose |
|------|---------|
| `app.js` | Everything — message handler, all flows, all helpers (~1400 lines) |
| `email.js` | Nodemailer: `sendDisputeLetter`, `sendCalendarInvite`, `generateICS`, `previewLetter` |
| `state.js` | `loadState()` / `saveState()` — atomic JSON write to `bot-state.json` |
| `bot-state.json` | Persisted state (policyId + profile per user, survives restarts) |
| `.env` | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `HEAL_BACKEND_URL`, `BELIEFS_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD` |

---

## State object (`state`)

Lives in memory, persisted to `bot-state.json` via `saveState()`. Keyed by userId.

| Key | Type | Notes |
|-----|------|-------|
| `state[userId]` | `number\|string` | Active policy document ID (primary key) |
| `state[userId + '_session']` | `string` | RAG chat session ID (in-memory only, not persisted) |
| `state[userId + '_profile']` | `object` | User profile — see Profile fields below |
| `state[userId + '_lastBill']` | `object` | `{ discrepancies, totalOvercharge, correctOwed, billedAmount }` |
| `state[userId + '_apt']` | `object` | In-progress appointment accumulator |
| `state[userId + '_aptStep']` | `string` | `'name' \| 'phone' \| 'datetime' \| 'reason'` |
| `state[userId + '_profileStep']` | `string` | `'location' \| 'conditions' \| 'university'` |
| `state[userId + '_queued']` | `string` | User message queued while profile collection is in progress |
| `state[userId + '_emailStep']` | `string` | `'to' \| 'confirm'` |
| `state[userId + '_emailDraft']` | `object` | Dispute letter draft (persists across send failures) |
| `state[userId + '_pendingFile']` | `object` | File waiting for user to classify as "policy" or "bill" |
| `state[userId + '_ctxHistory']` | `array` | Last 12 turns of contextual chat history |

**Profile fields** (inside `state[userId + '_profile']`):

`patientName`, `insuranceName`, `insuranceNumber`, `location`, `conditions`, `university`,
`email`, `deductible`, `outOfPocketMax`, `copayPrimary`, `copaySpecialist`, `copayER`,
`coinsurance`, `collected`, `locationSkipped`

Helpers: `getProfile(userId)` / `setProfile(userId, patch)` — always patch, never overwrite.

---

## Message handler flow

```
app.message()
  ├─ Dedup (processed Set — prevents socket replay)
  ├─ Slack email fetch (users.info — once per user, cached in profile.email)
  ├─ File upload? → classify bill vs policy → processBillUploadAsync / processPolicyUploadAsync
  ├─ Pending file + "policy"/"bill" reply → classify saved file
  ├─ Greeting ("hi", "hello", "hey", "help", "start", empty)
  │    ├─ Has policy → personalised greeting with coverage snapshot
  │    └─ No policy → onboarding instructions
  └─ Everything else → handleChat(userId, text)
       ├─ No policy → "upload your policy first"
       ├─ Active aptStep → handleAppointmentStep()
       ├─ Active emailStep → handleEmailStep()
       ├─ Active profileStep (location/conditions/university) → profile collection state machine
       ├─ First interaction + no profile collected → queue message, start profile collection
       └─ routeChat(userId, text, policyId)
```

---

## Intent routing order in `routeChat()`

Order matters — earlier checks take priority. Do not reorder.

1. `APPOINTMENT_INTENT` → `startAppointment()`
2. Email capture regex (`my email is X@Y.com`) → save to profile, return confirmation
3. `EMAIL_INTENT` → `startEmail()`
4. `BENEFITS_INTENT` → `handleBenefitsCard()`
5. `PROFILE_INTENT` → `handleHealthProfile()`
6. `MEDICAL_ADVICE_INTENT` → hard block with 911 reminder
7. `SEARCH_INTENT` → `handleProviderSearch()` (OpenStreetMap/Overpass)
8. `LOCATION_INTENT` → `handleContextualChat()` (RAG + location endpoint)
9. Default → `handleRagChat()` (standard RAG)

**Critical:** Email capture (step 2) must fire before `EMAIL_INTENT` (step 3). Otherwise
"my email: user@example.com" matches `EMAIL_INTENT` and routes to the dispute flow.

**Critical:** `SEARCH_INTENT` must fire before `LOCATION_INTENT`. The location intent
matches broadly (any mention of "hospital" or "provider"). Search intent is narrower —
it detects actual "find me X near me" queries and routes to real OSM data instead of
Gemini speculation.

---

## Key functions

### `tryParseDateTime(raw)`
Parses natural language dates for appointment booking. Returns `{ iso, display, date }` or
`null` (caller re-asks).

Two-pass approach:
1. **Weekday path** (step 0): Intercepts `"monday"`, `"next friday 3pm"`, `"this tuesday at 9am"`.
   Uses real arithmetic to find the next occurrence. DO NOT let V8 handle bare weekday names —
   it resolves them to arbitrary far-future dates (January 2027, etc.).
   - `daysAhead = ((targetDay - today.getDay()) + 7) % 7 || 7` — never 0 (today = next week)
   - `"next X"` adds 7 more days on top
   - Time parsed with `(\d{1,2})(?::(\d{2}))?\s*(AM|PM)` — do NOT pre-normalise "2:30 PM"
     to "2:30:00 PM" before this regex (breaks the colon detection)
2. **V8 path** (steps 1–3): Capitalise month names, normalise "9am" → "9:00 AM", try as-is /
   append current year / append next year. Bump past dates +1 year.

### `sanitizeUni(u)`
Strips vague answers ("yes", "ok", etc.) and "yes, X" prefixes from the university field.
Applied both at input time (profile step) and at appointment completion. Without this,
calendar titles show "Medical Appointment — yes, Arizona State Health Center".

### `generateICS()` (in email.js)
Uses **floating local time** (`DTSTART:YYYYMMDDTHHMMSS` — no `Z`) so the calendar event
appears at the correct local hour regardless of which timezone the calendar app uses.
`DTSTAMP` uses UTC (required by spec). Includes a `VALARM` trigger at -PT30M.

### `handleProviderSearch()`
Geocodes `profile.location` via Nominatim, then queries Overpass API for nearby
`hospital|clinic|urgent_care` amenities within 15km. Free, no API key. Adds Google Maps
links per result. Always shows disclaimer to call ahead to verify insurance network status.
Network filtering is impossible without an insurance API — do not attempt it.

### `resolvePolicyId(userId)`
Returns `state[userId]` if present. Falls back to `beliefs.search('active policy_id')`.
`"latest"` is never stored as a policyId — if docId can't be determined after upload,
the function throws.

### `calcDisputeScore(fin, discrepancy)`
Heuristic 0–100 score:
- Base 60 if discrepancies exist
- +15 if total_overcharge > 0
- +10 if network discount missing (`amount_saved` ≤ 0)
- +10 if insurance payment missing
- +5 if overcharge > $500
- Clamped to 95 max

---

## Flows

### Policy upload
1. Download file, POST to `/upload/async` → get `job_id`
2. Poll `/upload/status/{job_id}` every 3s, update Slack message on stage change
3. Extract `docId` from `job.result.additional_info.rag_document_id` (primary)
   — fallback: GET `/documents`, sort by `upload_timestamp`, take newest
   — if both fail: throw (never store `"latest"`)
4. Store `state[userId] = docId`, delete stale `_session`, `saveState()`
5. Extract coverage fields (carrier, deductible, copay, OOP max) into profile patch
6. Fire beliefs SDK: add policy_id + coverage facts as beliefs
7. If `!profile.collected` → start profile collection (location → conditions → university)

### Bill upload
1. Requires `resolvePolicyId()` — fails with clear message if no policy on file
2. POST file to `/bill-checker/upload` → `bill_id`
3. POST to `/bill-checker/analyze/async` with `{ bill_id, policy_id }` → `job_id`
4. Poll `/bill-checker/analyze/status/{job_id}`, show financial breakdown on done
5. Store `state[userId + '_lastBill']` if discrepancies found
6. Show dispute score (`calcDisputeScore`) in reply header

### Appointment booking (multi-step)
Steps: `name` → `phone` → `datetime` → `reason`  
State keys: `_aptStep` (current step) + `_apt` (accumulator)  
Pre-seeds name/insurance/conditions/university from profile — skips steps that are already known.  
On completion: generates Google Calendar link + sends `.ics` via `sendCalendarInvite` if
`profile.email` is set and `isEmailConfigured()` is true.

### Email dispute (multi-step)
Steps: `to` → `confirm`  
- `to === 'me'` resolves to `profile.email || process.env.GMAIL_USER`  
- Shows `previewLetter()` preview with "Reply *send* to confirm"  
- On send failure: keeps state so user can fix `.env` and retry with "send"  
- Only clears `_emailDraft` after confirmed successful send

### Profile collection (triggered after first policy upload or first chat)
Steps: `location` → `conditions` → `university`  
`skip` accepted at any step. University step rejects bare yes/no (asks for actual name).  
Sets `profile.collected = true` when done. If a message was queued during collection,
answers it immediately after profile is saved.

---

## Beliefs SDK

Used fire-and-forget only — never on the critical reply path. Always wrapped in `bgB()`.

```js
bgB(userId, fn)        // fire-and-forget, swallows BETA_ACCESS_REQUIRED
mkB(userId)            // new Beliefs({ thread: userId }) — per-user isolation
searchB(userId, query) // beliefs.search() — used only in resolvePolicyId() fallback
```

Pass **raw AI text** to `beliefs.after()` — not the Slack-formatted reply (no emojis, no
`*bold*` markdown). The beliefs world state is evaluated by Thinkn judges.

---

## Backend API calls

| Endpoint | Called from |
|----------|------------|
| `POST /upload/async` | `processPolicyUploadAsync` |
| `GET /upload/status/:id` | `processPolicyUploadAsync` (polling) |
| `GET /documents` | `processPolicyUploadAsync` (fallback docId) |
| `POST /bill-checker/upload` | `processBillUploadAsync` |
| `POST /bill-checker/analyze/async` | `processBillUploadAsync` |
| `GET /bill-checker/analyze/status/:id` | `processBillUploadAsync` (polling) |
| `POST /chat/sessions` | `handleRagChat` (lazy session creation) |
| `POST /chat/sessions/:id/messages` | `handleRagChat` |
| `POST /chat/contextual` | `handleContextualChat` |

All calls use `api = axios.create({ baseURL: BACKEND, timeout: 60_000 })`.

---

## Email / calendar

Requires `GMAIL_USER` + `GMAIL_APP_PASSWORD` in `.env`.  
`isEmailConfigured()` gates all email features gracefully.  
`.ics` files use `contentType: 'text/calendar; method=REQUEST'`.  
`sendCalendarInvite` attaches the `.ics` to an email sent to `profile.email`.

---

## Known pitfalls

- **"monday" without a date**: the weekday parser always resolves to the actual next
  occurrence via arithmetic. V8 must never touch bare weekday names.
- **"yes" stored as university name**: `sanitizeUni()` strips vague answers and
  "yes, X" prefixes. Applied at input time AND at appointment completion.
- **`docId = 'latest'` corruption**: removed. If docId can't be determined, throw.
  Never store a non-numeric string as policyId — it breaks bill checking and persists.
- **Email routed to dispute flow**: email capture regex fires before `EMAIL_INTENT`. 
  Do not reorder.
- **Socket replay**: dedup `processed` Set at the top of `app.message()`. Capped at 1000
  entries before reset.
- **ICS timezone**: use floating local time (no `Z`) for `DTSTART`. UTC (`Z`) only for `DTSTAMP`.

---

## Open TODOs

- **Session retry on stale sessionId**: if `POST /chat/sessions/:id/messages` returns 4xx,
  clear `state[userId + '_session']` and retry with a new session. Currently fails until
  bot restart.
- **Startup cleanup of orphaned placeholder messages**: on start, find and delete any
  "Thinking..." / "_Reading..._" placeholder messages left over from a previous crash.

---

## Running

```bash
cd heal-slack-bot
node app.js
```

Backend must be running first (`cd backend && python main.py`).  
Socket mode — no public URL needed.
