# 🚀 HEAL.AI Deployment Guide (Railway)

One Railway service runs everything: the Docker image builds the React frontend
into `./static` and FastAPI serves it same-origin, so the SPA and API share one
URL. The Slack bot, if you want it, is a separate service (see the end).

## ⚠️ Read this first: Railway's filesystem is ephemeral

Railway wipes the container filesystem on **every redeploy**. HEAL stores its
database (`heal.db`) and uploaded files on disk. Without a persistent volume,
**all policies, chunks, chat history, and bills are lost on each deploy.**

The app now reads two env vars so you can point storage at a mounted volume:

| Env var | Purpose | Volume value |
|---------|---------|--------------|
| `DB_PATH` | SQLite file location | `/data/heal.db` |
| `UPLOAD_DIR` | Uploaded originals | `/data/uploads` |

If you skip the volume, the app still runs — it just forgets everything on redeploy.

---

## Deploy steps

1. **Push your code to your GitHub repo** (see the "Publish" section below).

2. **Create the Railway project** → New Project → Deploy from GitHub repo → pick
   your `HEAL_AI` repo. Railway reads `railway.json` (Dockerfile build, `python main.py`,
   health check at `/health`).

3. **Add a persistent volume** → service → Settings → Volumes → add one mounted at
   `/data`. (This is the step that prevents data loss.)

4. **Set environment variables** (service → Variables):
   ```env
   GEMINI_API_KEY=your-real-key      # REQUIRED — app refuses to boot without it
   ENVIRONMENT=production
   DB_PATH=/data/heal.db
   UPLOAD_DIR=/data/uploads
   ```
   > The backend fails fast if `GEMINI_API_KEY` is missing (no silent mock data).
   > To run a keyless build on purpose, set `ALLOW_MOCK=1`.

5. **Deploy.** Railway builds the Dockerfile and starts the service. First boot
   creates the tables under `/data`.

6. **Verify** (see checklist below).

---

## 💸 Protect your wallet and the demo

The backend has **no auth** and holds your paid `GEMINI_API_KEY`. A leaked demo
URL can drain your quota. Before sharing the link:

- **Set a spend cap** in Google AI Studio / Cloud billing for the Gemini key.
- Consider a lightweight rate limit or a shared demo password if the link goes public.
- Railway hobby services **cold-start** after idle (first request hangs ~10–30s).
  For an interview window, keep it warm by pinging `/health`, or run an always-on plan.
- Expired Gemini/Slack tokens silently break the demo — check `/health` the morning of.

---

## Post-deployment checklist

- [ ] `https://<app>.up.railway.app/health` returns healthy
- [ ] `https://<app>.up.railway.app/docs` loads
- [ ] The web app loads at the root URL
- [ ] Upload `backend/sample_data/sample_policy.pdf` → coverage extracted
- [ ] Bill-check `sample_bill_overcharged.pdf` → 3 errors flagged, dispute drafts
- [ ] Redeploy once, confirm the uploaded policy is **still there** (volume works)

---

## Local Docker (optional)

```bash
docker compose up --build      # http://localhost:8000  (set GEMINI_API_KEY first)
```

---

## Slack bot (optional, separate service)

Socket-mode, no inbound port. New Railway service from the same repo with root
directory `heal-slack-bot/`, start command `node app.js`, and env vars
`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `HEAL_BACKEND_URL` (= your deployed backend
URL), `BELIEFS_KEY`. See [`heal-slack-bot/README.md`](heal-slack-bot/README.md)
for the Slack app setup.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Service exits immediately | `GEMINI_API_KEY` unset | Set it, or `ALLOW_MOCK=1` |
| Data gone after redeploy | No volume / `DB_PATH` not on mount | Add `/data` volume, set `DB_PATH`/`UPLOAD_DIR` |
| OCR fails on images | tesseract missing | Provided by the Dockerfile; use the Docker build |
| First request hangs | cold start | keep-warm ping on `/health` or always-on plan |

Logs: `railway logs`.
