# HEAL.AI — Claude Context

## Project Overview
HEAL.AI is a healthcare financial assistant: upload an insurance policy → AI extracts coverage → upload a medical bill → AI cross-references for errors, discrepancies, and patient responsibility.

**2nd place winner — Devlabs Hackathon.**

Current active branch: `hackathon-thinkn-uchenova`
Goal: Win two hackathon tracks by integrating a Slack bot with the Thinkn Beliefs SDK.

---

## Architecture

```
heal-slack-bot/app.js     ← Slack bot (Node.js, @slack/bolt, socket mode)
backend/main.py            ← FastAPI backend (Python 3.11, port 8000)
frontend-clean/            ← React + TypeScript + Vite frontend
```

### Backend Stack
- **FastAPI** — main API server (`backend/main.py`)
- **Google Gemini** — `embedding-001` for embeddings (768-dim), `gemini-2.5-flash/pro` for analysis
- **SQLite** — local DB (`backend/heal.db`)
- **RAG pipeline** — `backend/rag/` (document_processor → embedder → retriever → chatbot)
- **google-generativeai==0.4.0** — do NOT upgrade without testing; `embedding-001` is the correct model for this version

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

## Known Bugs (to fix)

1. **`backend/rag/document_processor.py:311`** — fallback embedding dim is 384, must be 768
2. **`heal-slack-bot/app.js:150`** — `beliefs.before()` return value ignored; policy_id never extracted
3. **`heal-slack-bot/app.js:130`** — `beliefs.add()` stores but never queried back; use `beliefs.search()` or per-thread scoping
4. **All users share one `beliefs` instance** — must use `thread: userId` in constructor for isolation

## Fix Plan
See `.claude/plans/fancy-doodling-zebra.md` for the full implementation plan.

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
- Embedding model must be `embedding-001` (not `text-embedding-004`) for this library version
- All embedding dimensions must be 768 everywhere — mismatches cause silent RAG failures
- Keep `fallbackBeliefsState` in the Slack bot as a backup when Thinkn SDK throws `BetaAccessError`
- The `beliefs` SDK may throw `BetaAccessError` with `err.code === 'BETA_ACCESS_REQUIRED'` — always wrap in try/catch
