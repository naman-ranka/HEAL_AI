# HEAL Slack Bot — Claude Context

## What this is

HEAL AI is a healthcare financial advocate that lives inside Slack. Users upload their
insurance policy and medical bills; HEAL cross-references them for billing errors, answers
coverage questions via RAG, finds nearby hospitals in any city, books campus health center
appointments with real calendar invites, and sends formal billing dispute letters by email.

**Hackathon context:** 2nd place — Devlabs Hackathon. Competing in two additional tracks:
- **Thinkn** ($300) — best use of the `beliefs` npm SDK for agent memory
- **UcheNova** ($400) — silent Slack integration solving real healthcare pain points

**The problem:** Medical billing errors affect 1 in 3 Americans. Most people can't decode
their EOB, don't know when they're overcharged, and have no idea how to dispute. HEAL
makes the whole process as simple as sending a Slack message.

**Stack:** Node.js · `@slack/bolt` v4 · socket mode · `beliefs` SDK · FastAPI backend (`:8000`)
· Google Gemini (embeddings + analysis) · SQLite · OpenStreetMap/Overpass for real provider data

---

## File map

| File | Purpose |
|------|---------|
| `app.js` | Everything — message handler, all flows, all helpers (~1700 lines) |
| `email.js` | Nodemailer: `sendDisputeLetter`, `sendCalendarInvite`, `generateICS`, `previewLetter` |
| `state.js` | `loadState()` / `saveState()` — atomic JSON write to `bot-state.json` |
| `bot-state.json` | **Runtime only, gitignored** — persisted state (policyId + profile per user) |
| `.env` | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `HEAL_BACKEND_URL`, `BELIEFS_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD` |
| `.env.example` | Template — copy to `.env` and fill in keys |

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
| `state[userId + '_aptStep']` | `string` | `'name' \| 'phone' \| 'datetime' \| 'reason' \| 'email'` |
| `state[userId + '_profileStep']` | `string` | `'location' \| 'conditions' \| 'university'` |
| `state[userId + '_queued']` | `string` | User message queued while profile collection is in progress |
| `state[userId + '_emailStep']` | `string` | `'to' \| 'confirm' \| 'capture_email'` |
| `state[userId + '_emailDraft']` | `object` | Dispute letter draft (persists across send failures) |
| `state[userId + '_pendingFile']` | `object` | File waiting for user to classify as "policy" or "bill" |
| `state[userId + '_ctxHistory']` | `array` | Last 12 turns of contextual chat history |

**Profile fields** (inside `state[userId + '_profile']`):

`patientName`, `insuranceName`, `insuranceNumber`, `location`, `conditions`, `university`,
`email`, `deductible`, `outOfPocketMax`, `copayPrimary`, `copaySpecialist`, `copayER`,
`coinsurance`, `collected`, `locationSkipped`,
`firstNameSlack`, `realNameSlack`, `tzOffset` (seconds from UTC), `tz` (e.g. "America/Phoenix"),
`slackEnriched` (flag — set true after first successful users.info call)

Helpers: `getProfile(userId)` / `setProfile(userId, patch)` — always patch, never overwrite.

---

## Message handler flow

```
app.message()
  ├─ Dedup (processed Set — prevents socket replay)
  ├─ Slack email fetch (users.info — once per user, cached in profile via slackEnriched flag)
  ├─ File upload? → classify bill vs policy → processBillUploadAsync / processPolicyUploadAsync
  ├─ Pending file + "policy"/"bill" reply → classify saved file
  ├─ Greeting ("hi", "hello", "hey", "help", "start", empty)
  │    ├─ Has policy → personalised greeting with coverage snapshot + first name from Slack
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
6. `MEDICAL_ADVICE_INTENT` (+ `COVERAGE_QUERY` guard) → hard block with 911 reminder
7. `SEARCH_INTENT` OR (`MEDICAL_FACILITY_RE` + `extractLocationFromText`) → `handleProviderSearch()`
8. `LOCATION_INTENT` → `handleContextualChat()` (RAG + location endpoint)
9. Default → `handleRagChat()` (standard RAG) + `gapHint()` appended

**Critical:** Email capture (step 2) must fire before `EMAIL_INTENT` (step 3). Otherwise
"my email: user@example.com" matches `EMAIL_INTENT` and routes to the dispute flow.

**Critical:** Provider search (step 7) has two triggers:
1. `SEARCH_INTENT` — "find a hospital near me", "hospitals near Phoenix"
2. `MEDICAL_FACILITY_RE.test(text) && extractLocationFromText(text)` — "hospitals in Salt Lake City"

This prevents "hospitals in Sacramento" from falling through to `LOCATION_INTENT` → RAG,
which was returning policy-document examples (San Francisco) instead of real OSM data.

---

## Key functions

### Slack metadata enrichment

Runs once per user at the top of `app.message()`, gated by `profile.slackEnriched`.
Fetches `users.info` and stores `email`, `firstNameSlack`, `realNameSlack`, `tzOffset`
(seconds from UTC), `tz` (IANA zone name) in the profile. Uses `slackEnriched: true`
as the completion flag so the enrichment re-runs for users created before the timezone
field was added.

**Why `slackEnriched` not `!email`:** If email was stored in a prior session before
`firstNameSlack` / `tzOffset` were added, the old guard would never re-fetch. The flag
ensures the full enrichment always runs once per deployment change.

---

### `tryParseDateTime(raw, tzOffsetSeconds?)`
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
Applied at **both** input time (profile step, before `setProfile`) and at appointment
completion (via `finishAppointment`). Without this, profiles and calendar titles show
"Medical Appointment — yes, Arizona State Health Center".

### `extractLocationFromText(text)`
Parses an explicit city/location from query text.
- `"hospitals in Salt Lake City"` → `"Salt Lake City"`
- `"find a doctor near Austin, TX"` → `"Austin, TX"`
- `"hospitals near me"` → `null` (vague, falls back to `profile.location`)
- `"hospitals in my network"` → `null` (filters out non-place words)

Used in `handleProviderSearch` and `routeChat` to route city-specific provider queries
to OSM instead of the RAG endpoint.

### `generateICS()` (in email.js)
Uses **floating local time** (`DTSTART:YYYYMMDDTHHMMSS` — no `Z`) so the calendar event
appears at the correct local hour regardless of which timezone the calendar app uses.
`DTSTAMP` uses UTC (required by spec). Includes a `VALARM` trigger at -PT30M.

### `handleProviderSearch()`
Geocodes the search location via Nominatim, then queries Overpass API for nearby
`hospital|clinic|urgent_care` amenities within 15km. Free, no API key. Adds Google Maps
links per result. Always shows disclaimer to call ahead to verify insurance network status.

**Location priority:** `extractLocationFromText(text)` (explicit city in query) → `profile.location`.
"hospitals in Salt Lake City" returns Salt Lake City results even when profile says "San Francisco".

### `resolvePolicyId(userId)`
Returns `state[userId]` if present. Falls back to `beliefs.search('active policy_id')`.
`"latest"` is never stored as a policyId — if docId can't be determined after upload,
the function throws.

### `calcDisputeScore(fin, discrepancy)`
Heuristic 0–100 score:
- Base 50 with adjustments for number of discrepancy items (+5/+15/+25)
- +15 if network discount missing
- +12 if insurance payment missing
- +4/+8 if overcharge > $50/$200
- Clamped to 42–95 range

### `gapHint(profile, text)`
Appended to standard RAG replies when a critical profile field is missing and the
user's query suggests they'd benefit from having it. Returns one hint or `null`.
Rules (checked in order, first match wins):
1. No email + asked about appointment/dispute/send → prompt to save email
2. No location + asked about hospitals/doctors/nearby → prompt to share city
3. No university + asked about campus/student/health center → prompt to share uni

Only fires on the standard `handleRagChat` path.

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
Steps: `name` → `phone` → `datetime` → `reason` → [`email` if missing] → DONE
State keys: `_aptStep` (current step) + `_apt` (accumulator)
Pre-seeds name/insurance/conditions/university from profile — skips steps that are already known.
The `email` step is injected dynamically after `reason` if `!profile.email && isEmailConfigured()`.
Completion logic lives in `finishAppointment(userId, apt, profile)` — shared by both the `reason`
path (email already known) and the `email` path (just collected).

**State cleanup:** `_aptStep` and `_apt` are deleted BEFORE calling `finishAppointment` so the
next user message doesn't re-enter appointment flow. The email path deletes explicitly; the reason
path (email already on file) deletes inline before the call.

### Dispute email (multi-step)
Steps: [`capture_email` if "me" and no email] → `to` → `confirm` → DONE
If user types "me" and `!profile.email`, enters `capture_email` step which collects email,
saves it to profile, then continues to the `to` step with the captured address.

On send failure: keeps `_emailDraft` state so user can fix `.env` and retry with "send".
Only clears `_emailDraft` after confirmed successful send.

### Profile collection (triggered after first policy upload or first chat)
Steps: `location` → `conditions` → `university`
`skip` accepted at any step. University step rejects bare yes/no (asks for actual name).
University stored via `sanitizeUni()` to strip "yes, X" prefixes before saving.
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

## Security & ops

- `.env` files are gitignored via `.env*` pattern in root `.gitignore`
- `bot-state.json` is gitignored — contains real user PII (names, insurance numbers)
- `heal-slack-bot/tmp_*` is gitignored — temp upload files auto-cleaned via `finally` block
- `bot-state.json` is written atomically (`.tmp` → `rename`) to prevent corruption on crash
- Sessions (`_session` keys) are **not persisted** — recreated lazily; stale sessions
  auto-retry with a fresh session on 4xx response

---

## Known pitfalls

- **"monday" without a date**: the weekday parser always resolves to the actual next
  occurrence via arithmetic. V8 must never touch bare weekday names.
- **"yes" stored as university name**: `sanitizeUni()` strips vague answers and
  "yes, X" prefixes. Applied at input time AND at appointment completion.
- **`docId = 'latest'` corruption**: removed. If docId can't be determined, throw.
  Never store a non-numeric string as policyId.
- **Email routed to dispute flow**: email capture regex fires before `EMAIL_INTENT`.
  Do not reorder.
- **Socket replay**: dedup `processed` Set at top of `app.message()`. Capped at 1000.
- **ICS timezone**: use floating local time (no `Z`) for `DTSTART`. UTC (`Z`) only for `DTSTAMP`.
- **Appointment state stuck**: `_aptStep` and `_apt` must be deleted before `finishAppointment`
  in the reason path (email already on file). Without it, next message re-enters appointment flow.
- **"hospitals in Sacramento" → RAG**: Fixed. `extractLocationFromText` detects named cities
  and routes to OSM via `MEDICAL_FACILITY_RE` + explicit location check before `LOCATION_INTENT`.

---

## Open TODOs

- **Startup cleanup of orphaned placeholder messages** — On bot start, find and delete any
  "Thinking..." / "_Reading..._" placeholder messages left over from a previous crash.

---

## Running

```bash
# Backend (required first)
cd backend
source venv/Scripts/activate  # Windows: venv\Scripts\activate
python main.py                 # runs on :8000

# Slack bot
cd heal-slack-bot
cp .env.example .env           # fill in your keys
node app.js
```

Socket mode — no public URL or ngrok needed.
