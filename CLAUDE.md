# HEAL.AI — Claude Context

## Project Overview

**HEAL AI is a healthcare financial advocate that lives in Slack.**

The problem: 1 in 3 American medical bills contains errors. Most patients don't understand their EOB, can't tell when they're overcharged, and have no idea how to dispute. HEAL fixes this — entirely inside the tools people already use at work and school.

Upload your insurance policy → AI extracts all your coverage details.
Upload a medical bill → AI cross-references for billing errors, flags overcharges, and drafts a formal dispute letter. Ask anything → plain-English answers about copays, deductibles, what's covered.

**Awards:** 2nd place — Devlabs Hackathon.

**Current branch:** `hackathon-thinkn-uchenova`
**Goal:** Win two additional hackathon tracks (Thinkn + UcheNova) via the Slack bot.

### What makes it different

- **No new tab needed.** The entire experience is a Slack DM. Employees/students can use it without leaving their workflow.
- **Real data, not hallucinations.** Nearby hospitals come from OpenStreetMap (Overpass API), not Gemini speculation.
- **Persistent memory.** The Thinkn `beliefs` SDK builds a per-user knowledge graph. After one conversation, HEAL remembers your policy, conditions, and history — across restarts.
- **Dispute in one click.** After finding billing errors, users can send a formal dispute letter to the billing department directly from Slack with one command.
- **Calendar invites.** Book a campus health center appointment and get a `.ics` file in your inbox, pre-filled with your insurance details.

---

## Architecture

```
heal-slack-bot/app.js     ← Slack bot (Node.js, @slack/bolt, socket mode)
backend/main.py            ← FastAPI backend (Python 3.11, port 8000)
frontend-clean/            ← React + TypeScript + Vite frontend
```

### Backend Stack
- **FastAPI** — main API server (`backend/main.py`)
- **Google Gemini** — `gemini-embedding-2-preview` for embeddings (768-dim, via hand-rolled v1beta REST), `gemini-2.5-flash/pro` for analysis
- **SQLite** — local DB (`backend/heal.db`)
- **RAG pipeline** — `backend/rag/` (document_processor → embedder → retriever → chatbot)
- **Embedding model = `gemini-embedding-2-preview`** — the live default in `ai/embedder.py:44` and `:332`. `text-embedding-004` appears ONLY in dead files (`genkit_rag_chat.py`, `langchain_main.py`) that the live `rag/` path never imports; don't "restore" it — the stored vectors are in the preview model's space (same 768 dim, different space, and the dim guard won't catch a swap).
- **google-generativeai==0.4.0** — do NOT upgrade without testing (newer `google-genai` has breaking changes)

### Slack Bot Stack
- `@slack/bolt` v4 — socket mode
- `beliefs` npm SDK — Thinkn's belief infrastructure SDK
- `axios` — HTTP calls to HEAL backend
- `form-data` — multipart file uploads

---

## Key API Endpoints (backend)

| Endpoint | Purpose |
|----------|---------|
| `POST /upload` | Upload insurance policy PDF/image → returns `PolicyAnalysisOutput` JSON with coverage details |
| `GET /documents` | List all uploaded documents (sorted desc by timestamp) |
| `POST /bill-checker/upload` | Upload medical bill → returns `{ bill_id }` |
| `POST /bill-checker/analyze` | `{ bill_id, policy_id }` → returns financial breakdown, discrepancies |
| `POST /chat/sessions` | Create RAG chat session `{ document_ids: [int] }` → returns `{ session_id }` |
| `POST /chat/sessions/{id}/messages` | `{ message }` → RAG response with sources |
| `GET /health` | Health check |

---

## Hackathon Tracks

### Thinkn Track — Belief Infrastructure for Agents
- **Prize**: $300 / $200 / $100
- **Judge criteria**: Best use of the `beliefs` npm SDK
- **SDK key**: `SVHACK` (beta access code, also env var `BELIEFS_KEY`)
- **SDK API** (from `node_modules/beliefs/dist/client-IVkquQfr.d.ts`):
  - `beliefs.before(input?)` → `BeliefContext` { prompt, beliefs[], clarity, goals, gaps, moves }
  - `beliefs.after(text, options?)` → `BeliefDelta` { changes, clarity, readiness, moves, state }
  - `beliefs.add(text, options?)` or `beliefs.add(items[])` → `BeliefDelta`
  - `beliefs.search(query)` → `Belief[]`
  - `beliefs.read()` → `WorldState`
  - Constructor accepts `{ apiKey, thread }` — use `thread: userId` for per-user scoping
- **Key**: Create per-user `Beliefs` instances with `thread: slackUserId` so each user has isolated belief graph

### UcheNova Track — Silent Integrations for Small Businesses
- **Prize**: $400 + career dev "first pick"
- **Scoring**: Integration depth (50%) + end-to-end functionality (30%) + specific pain point (20%)
- **Pain point**: Employees/patients can't understand medical bills or insurance coverage
- **Delivery**: Pure Slack — no new browser tab needed
- **Track repo**: https://github.com/D0odi/uchenova_track_villagehacks_2026

---

## Fixed Bugs (as of 2026-04-12)

All bugs resolved. Current state of `heal-slack-bot/app.js`:
- Per-user beliefs isolation via `thread: userId` in `mkB()` ✓
- `beliefs.search()` used in `resolvePolicyId()` for state recovery after restart ✓
- `beliefs.before()` removed (was unused) ✓
- `document_processor.py` fallback dim is 768 ✓
- `embedder.py` `initialize_embedder` + constructor default to `gemini-embedding-2-preview` (768-dim) ✓
- State persisted to `bot-state.json` via `state.js` (survives restarts) ✓
- `docId = 'latest'` fallback removed — throws if ID can't be determined ✓
- Beliefs `after()` receives clean AI text, not Slack-formatted string ✓
- Event dedup Set prevents socket replay ✓
- Stale session auto-retry — if backend restarts, `handleRagChat` creates a new session and retries ✓
- Appointment state cleanup — `_aptStep`/`_apt` deleted before `finishAppointment` (reason path) ✓
- University sanitized at input time — `sanitizeUni()` applied before `setProfile` in profile step ✓
- "hospitals in Sacramento" → OSM — `extractLocationFromText` + `MEDICAL_FACILITY_RE` routing ✓
- `bot-state.json` gitignored — contains user PII, was previously tracked ✓
- `.env.example` files added for both `heal-slack-bot/` and `backend/` ✓

## Open TODOs

- Startup cleanup of orphaned "Thinking..." placeholder messages (post-hackathon)

---

## Environment Variables

### Slack Bot (`heal-slack-bot/.env`)
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-1-...
HEAL_BACKEND_URL=http://localhost:8000
BELIEFS_KEY=SVHACK
```

### Backend (`backend/.env`)
```
GEMINI_API_KEY=...
ENVIRONMENT=development
```

---

## Running Locally

```bash
# Backend
cd backend
source venv/Scripts/activate  # Windows: venv\Scripts\activate
python main.py                 # runs on :8000

# Slack bot
cd heal-slack-bot
node app.js
```

---

## Important Constraints
- Do NOT upgrade `google-generativeai` from 0.4.0 without testing — newer SDK is `google-genai` and has breaking changes
- Embedding model is `gemini-embedding-2-preview` (768-dim), called via a hand-rolled v1beta REST POST in `ai/embedder.py`. Do NOT swap the model without re-embedding every stored chunk — vectors from a different model share the 768 dim but not the space, and the dimension guard in `retriever.py` won't catch it
- All embedding dimensions must be 768 everywhere — mismatches cause silent RAG failures
- Keep `fallbackBeliefsState` in the Slack bot as a backup when Thinkn SDK throws `BetaAccessError`
- The `beliefs` SDK may throw `BetaAccessError` with `err.code === 'BETA_ACCESS_REQUIRED'` — always wrap in try/catch
