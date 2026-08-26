import dotenv from 'dotenv';
dotenv.config();

import { isEmailConfigured, sendDisputeLetter, previewLetter, sendCalendarInvite } from './email.js';

import pkg from '@slack/bolt';
const { App, LogLevel } = pkg;
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import FormData from 'form-data';
import { loadState, saveState } from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Formatting helpers ────────────────────────────────────────────────────────

const NUM_EMOJIS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];

/** Parse AI findings like "**1. TITLE:** text.. **2. TITLE:** text" into clean Slack blocks */
function formatFindings(str) {
    if (!str) return '';
    // Split on bold numbered headers: **1. TITLE:**
    const parts = str.split(/\*\*\d+\.\s+/).filter(Boolean);
    if (parts.length < 2) return str.replace(/\*\*/g, '*').replace(/\.\.\s*/g, '\n').trim();

    return parts.map((part, i) => {
        const sep = part.indexOf(':**');
        if (sep === -1) return `${NUM_EMOJIS[i] || `${i+1}.`} ${part.replace(/\*\*/g, '*').replace(/\.\.\s*/g, '').trim()}`;
        const title = part.slice(0, sep).trim();
        const body  = part.slice(sep + 3).replace(/\.\.\s*$/, '').trim();
        return `${NUM_EMOJIS[i] || `${i+1}.`} *${title}*\n${body}`;
    }).join('\n\n');
}

function fmt$(n) { return n != null ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'; }

// ── Config ────────────────────────────────────────────────────────────────────

const BACKEND   = process.env.HEAL_BACKEND_URL || 'http://localhost:8000';
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const BELIEFS_KEY = process.env.BELIEFS_KEY || 'SVHACK';

if (!BOT_TOKEN) { console.error('SLACK_BOT_TOKEN missing'); process.exit(1); }
if (!APP_TOKEN) { console.error('SLACK_APP_TOKEN missing'); process.exit(1); }

// Backend HTTP client — 60s timeout for AI calls
const api = axios.create({ baseURL: BACKEND, timeout: 60_000 });

// Per-session memory: userId → policyId (persisted), `${userId}_session` → sessionId (in-memory only)
const state = loadState();

// Dedup set — prevents replayed socket events from being processed twice
const processed = new Set();

// ── Beliefs SDK (optional) ────────────────────────────────────────────────────
// Always fire-and-forget. Never on the path that determines what we reply.

let Beliefs = null;
try {
    Beliefs = (await import('beliefs')).default;
    console.log('[beliefs] loaded ✓');
} catch (e) {
    console.warn('[beliefs] unavailable:', e.message);
}

function mkB(userId) {
    if (!Beliefs) return null;
    try { return new Beliefs({ apiKey: BELIEFS_KEY, thread: userId, timeout: 2000, maxRetries: 0 }); }
    catch { return null; }
}

function bgB(userId, fn) {
    const b = mkB(userId);
    if (!b) return;
    fn(b).catch(e => { if (e.code !== 'BETA_ACCESS_REQUIRED') console.warn('[beliefs bg]', e.message); });
}

async function searchB(userId, query) {
    const b = mkB(userId);
    if (!b) return null;
    try { return await b.search(query); }
    catch { return null; }
}

// ── State helpers ─────────────────────────────────────────────────────────────

/** Build a compact user context string to inject into every AI prompt */
function buildUserContext(profile, lastBill) {
    const lines = [];
    if (profile.patientName)     lines.push(`Patient: ${profile.patientName}`);
    if (profile.insuranceName)   lines.push(`Insurance: ${profile.insuranceName}`);
    if (profile.insuranceNumber) lines.push(`Insurance #: ${profile.insuranceNumber}`);
    if (profile.location)        lines.push(`Location: ${profile.location}`);
    if (profile.conditions)      lines.push(`Pre-existing conditions: ${profile.conditions}`);
    if (profile.university)      lines.push(`University: ${profile.university}`);
    if (lastBill?.discrepancies) {
        lines.push(`Last bill analysis: ${String(lastBill.discrepancies).slice(0, 300)}`);
        if (lastBill.totalOvercharge > 0) lines.push(`Bill overcharge found: $${lastBill.totalOvercharge}`);
        if (lastBill.correctOwed  != null) lines.push(`Correct amount owed: $${lastBill.correctOwed}`);
    }
    return lines.join('\n');
}

/** Contextual chat history (location queries) — last 12 turns per user, persisted */
function getContextualHistory(userId) { return state[`${userId}_ctxHistory`] || []; }
function appendContextualHistory(userId, role, text) {
    const hist = getContextualHistory(userId);
    hist.push({ role, text, ts: Date.now() });
    state[`${userId}_ctxHistory`] = hist.slice(-12); // keep last 6 exchanges
    saveState(state);
}

async function resolvePolicyId(userId) {
    if (state[userId]) return state[userId];
    const results = await searchB(userId, 'active policy_id');
    if (results?.length) {
        const best = results
            .filter(r => !['retracted','removed','invalidated'].includes(r.lifecycle))
            .sort((a, b) => (b.confidence||0) - (a.confidence||0))[0];
        const m = best?.text?.match(/policy_id\s+(?:is\s+)?(\S+)/i);
        if (m?.[1]) { state[userId] = m[1]; console.log(`[beliefs] restored policy ${m[1]} for ${userId}`); }
    }
    return state[userId] || null;
}

// ── Slack helpers ─────────────────────────────────────────────────────────────

// Post a placeholder, then replace it in-place with the real content.
// This avoids the "two messages → looks like new thread" problem.
async function postThenUpdate(client, channel, placeholder, fn) {
    const msg = await client.chat.postMessage({ channel, text: placeholder });
    try {
        const text = await fn();
        await client.chat.update({ channel, ts: msg.ts, text });
    } catch (err) {
        await client.chat.update({ channel, ts: msg.ts, text: `❌ *Error:* ${err.message}` });
        throw err;
    }
}

// ── Slack App ─────────────────────────────────────────────────────────────────

const app = new App({
    token: BOT_TOKEN,
    appToken: APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.ERROR,
});

app.error(async (e) => console.error('[bolt]', e.message));

// ── Message handler ───────────────────────────────────────────────────────────

app.message(async ({ message, client }) => {
    // Allow file_share subtype — that's how Slack delivers file uploads
    if ((message.subtype && message.subtype !== 'file_share') || message.bot_id || !message.user) return;

    const userId  = message.user;
    const channel = message.channel;
    const text    = (message.text || '').trim();
    const lc      = text.toLowerCase();

    // Dedup: skip replayed events (socket reconnect redelivery)
    if (processed.has(message.ts)) return;
    processed.add(message.ts);
    if (processed.size > 1000) processed.clear();

    // Eagerly enrich the user profile from Slack metadata (once per user).
    // Uses the slackEnriched flag so re-enrichment happens if any field was added
    // after the user's profile was first created (e.g. timezone added in a later deploy).
    // Fetches: email, first name, real name, timezone offset.  Zero extra API calls —
    // all fields come from the single users.info call we were already making.
    if (!getProfile(userId).slackEnriched) {
        try {
            const userInfo  = await client.users.info({ user: userId });
            const u         = userInfo?.user;
            const patch     = { slackEnriched: true };
            if (u?.profile?.email)      patch.email          = u.profile.email;
            if (u?.profile?.first_name) patch.firstNameSlack = u.profile.first_name;
            if (u?.real_name)           patch.realNameSlack  = u.real_name;
            if (u?.tz_offset != null)   patch.tzOffset       = u.tz_offset;   // seconds from UTC
            if (u?.tz)                  patch.tz             = u.tz;           // e.g. "America/Phoenix"
            setProfile(userId, patch);
            console.log(`[slack-enrich] ${userId} name="${patch.firstNameSlack}" tz="${patch.tz}" email="${patch.email}"`);
        } catch { /* users:read / users:read.email scope not granted — skip */ }
    }

    console.log(`[msg] user=${userId} text="${text.slice(0,80)}"`);

    try {

        // ── File upload ───────────────────────────────────────────────────────
        if (message.files?.length) {
            const file     = message.files[0];
            const filename = (file.name || '').toLowerCase();

            // ── Classify the uploaded file (bill vs policy) ───────────────────
            //
            // Key insight: "based off my policy, check this bill" — "policy" is CONTEXT,
            // not a description of the uploaded file. We need to detect what the FILE is,
            // not what the message mentions in passing.
            //
            // Priority:
            //  1. Filename — strongest, most reliable signal
            //  2. Message explicitly refers to the file as a bill or policy
            //  3. Ambiguous → ask rather than guess wrong

            const BILL_FILENAME    = /bill|invoice|statement|claim|receipt|charges/i;
            const POLICY_FILENAME  = /policy|insurance|coverage|eob|explanation.of.benefit/i;

            // "The file IS a bill" — user refers to the uploaded file as a bill
            const BILL_SUBJECT = /\b(this|the|my|a)\s+(medical\s+)?(bill|invoice|statement|receipt)\b|check\s+(this|the|it)\s*(for\s*(errors?|issues?|problems?))?|is\s+there\s+(any\s+)?(issue|error|problem)\s+in\s+this|any\s+(issue|error|discrepancy)/i;

            // "The file IS a policy" — user is explicitly uploading a policy document.
            // Matches: bare "policy"/"insurance" keyword, explicit upload phrases.
            // Deliberately does NOT override BILL_SUBJECT — checked only when no bill signals.
            const POLICY_SUBJECT = /\b(policy|insurance|coverage|health\s+card|id\s+card|member\s+card|eob|explanation\s+of\s+benefits?)\b/i;

            const isBillFile   = BILL_FILENAME.test(filename);
            const isPolicyFile = POLICY_FILENAME.test(filename);
            const isBillMsg    = BILL_SUBJECT.test(lc);
            const isPolicyMsg  = POLICY_SUBJECT.test(lc);

            const isBill   = isBillFile   || (!isPolicyFile && isBillMsg);
            const isPolicy = isPolicyFile || (!isBillFile  && !isBillMsg && isPolicyMsg);

            console.log(`[file-classify] filename="${filename}" isBill=${isBill}(file:${isBillFile},msg:${isBillMsg}) isPolicy=${isPolicy}(file:${isPolicyFile},msg:${isPolicyMsg})`);

            if (isPolicy) {
                const msg = await client.chat.postMessage({ channel, text: '📤 _Uploading your policy..._' });
                processPolicyUploadAsync(userId, file, client, channel, msg.ts)
                    .catch(async err => {
                        console.error('[policy-upload]', err.message);
                        try { await client.chat.update({ channel, ts: msg.ts, text: `❌ *Error:* ${err.message}` }); } catch {}
                    });
            } else if (isBill) {
                const msg = await client.chat.postMessage({ channel, text: '📤 _Uploading your bill..._' });
                processBillUploadAsync(userId, file, client, channel, msg.ts)
                    .catch(async err => {
                        console.error('[bill-upload]', err.message);
                        try { await client.chat.update({ channel, ts: msg.ts, text: `❌ *Error:* ${err.message}` }); } catch {}
                    });
            } else {
                // Genuinely ambiguous — remember the file, ask once
                state[`${userId}_pendingFile`] = {
                    name:                file.name,
                    url_private_download: file.url_private_download,
                    mimetype:            file.mimetype,
                };
                saveState(state);
                await client.chat.postMessage({
                    channel,
                    text:
                        `📎 Got *${file.name}*. Is this:\n\n` +
                        `• An *insurance policy* → reply \`policy\`\n` +
                        `• A *medical bill* → reply \`bill\``,
                });
            }
            return;
        }

        // ── Pending file resolution (user replied "policy" or "bill") ─────────
        if (state[`${userId}_pendingFile`] && /^(policy|bill)$/i.test(text.trim())) {
            const pf = state[`${userId}_pendingFile`];
            delete state[`${userId}_pendingFile`];
            saveState(state);
            if (/^policy$/i.test(text.trim())) {
                const msg = await client.chat.postMessage({ channel, text: '📤 _Processing your policy..._' });
                processPolicyUploadAsync(userId, pf, client, channel, msg.ts)
                    .catch(async err => {
                        console.error('[policy-upload]', err.message);
                        try { await client.chat.update({ channel, ts: msg.ts, text: `❌ *Error:* ${err.message}` }); } catch {}
                    });
            } else {
                const msg = await client.chat.postMessage({ channel, text: '💸 _Checking your bill..._' });
                processBillUploadAsync(userId, pf, client, channel, msg.ts)
                    .catch(async err => {
                        console.error('[bill-upload]', err.message);
                        try { await client.chat.update({ channel, ts: msg.ts, text: `❌ *Error:* ${err.message}` }); } catch {}
                    });
            }
            return;
        }

        // ── Greeting ──────────────────────────────────────────────────────────
        if (!text || /^(hi|hello|hey|help|start)\b/i.test(lc)) {
            const policyId = state[userId];
            if (policyId) {
                // ── Personalised returning-user greeting ──────────────────────
                const profile  = getProfile(userId);
                const lastBill = state[`${userId}_lastBill`] || null;
                // Prefer insurance policy name; fall back to Slack profile first name
                const firstName = profile.patientName?.split(' ')[0] || profile.firstNameSlack;

                let greet = `👋 *Hey${firstName ? ` ${firstName}` : ''}!* Welcome back to HEAL.\n\n`;

                // Coverage snapshot
                greet += `📋 *Your Coverage*\n`;
                if (profile.insuranceName)   greet += `> Insurance: *${profile.insuranceName}*\n`;
                if (profile.insuranceNumber) greet += `> Member ID: *${profile.insuranceNumber}*\n`;
                if (profile.deductible     != null) greet += `> Deductible: *${fmt$(profile.deductible)}*/yr\n`;
                if (profile.copayPrimary   != null) greet += `> Primary Care: *${fmt$(profile.copayPrimary)} copay*\n`;
                if (profile.outOfPocketMax != null) greet += `> Out-of-Pocket Max: *${fmt$(profile.outOfPocketMax)}*/yr\n`;

                // Last bill status
                if (lastBill?.totalOvercharge > 0) {
                    greet += `\n🚨 *Last Bill:* ${fmt$(lastBill.totalOvercharge)} overcharge detected — type *"email dispute"* to send a formal letter\n`;
                } else if (lastBill) {
                    greet += `\n✅ *Last Bill:* No discrepancies found\n`;
                }

                greet += `\n*Quick commands:*\n`;
                greet += `• *"my benefits"* — full coverage card\n`;
                greet += `• *"my health profile"* — everything HEAL knows about you\n`;
                greet += `• *"hospitals near me"* — find nearby providers\n`;
                greet += `• *"book appointment"* — campus health center\n`;

                await client.chat.postMessage({ channel, text: greet });
            } else {
                // ── First-time onboarding ──────────────────────────────────────
                const newUserName = getProfile(userId).firstNameSlack;
                await client.chat.postMessage({
                    channel,
                    text:
                        `👋 *Hi${newUserName ? ` ${newUserName}` : ''}! I'm HEAL — your AI Healthcare Financial Advocate.*\n\n` +
                        "*What I can do:*\n" +
                        "• 📋 Explain your insurance coverage in plain English\n" +
                        "• 🏥 Find nearby in-network hospitals, urgent care & specialists\n" +
                        "• 🧾 Audit medical bills and catch overcharges\n" +
                        "• 💬 Answer coverage questions (copay, deductible, what's covered)\n" +
                        "• 📅 Book a campus health center appointment with a calendar invite\n" +
                        "• 📧 Send a formal billing dispute letter straight from Slack\n\n" +
                        "*Get started:*\n" +
                        "1. Upload your *insurance policy* PDF — include the word *policy* in your message\n" +
                        "2. I'll ask a few quick questions to personalise your experience _(all optional)_\n" +
                        "3. Ask anything — or upload a medical bill to check for errors\n" +
                        "4. Type *\"book appointment\"* to schedule a campus clinic visit\n" +
                        "5. Type *\"email dispute\"* to send a billing dispute letter\n\n" +
                        "⚠️ _I don't provide medical diagnoses or treatment advice — for emergencies, call 911._",
                });
            }
            return;
        }

        // ── Chat ──────────────────────────────────────────────────────────────
        await postThenUpdate(client, channel, '💬 _Checking your policy..._', async () => {
            return await handleChat(userId, text);
        });

    } catch (err) {
        console.error('[handler]', err);
        try {
            await client.chat.postMessage({ channel, text: `❌ *Error:* ${err.message}` });
        } catch { /* ignore */ }
    }
});

// ── Async policy upload (fire-and-forget with live Slack updates) ─────────────

const STAGE_MSGS = {
    analyzing: '🧠 _Analyzing your coverage details..._',
    indexing:  '📚 _Building your knowledge base..._',
};

async function processPolicyUploadAsync(userId, file, client, channel, ts) {
    const tmpPath = path.join(__dirname, `tmp_${Date.now()}_${file.name}`);
    try {
        // Download file
        const dl = await axios.get(file.url_private_download, {
            headers: { Authorization: `Bearer ${BOT_TOKEN}` },
            responseType: 'arraybuffer',
            timeout: 30_000,
        });
        fs.writeFileSync(tmpPath, dl.data);

        // Kick off async job on backend — returns immediately
        await client.chat.update({ channel, ts, text: '🔍 _Reading your insurance policy..._' });
        const form = new FormData();
        form.append('file', fs.createReadStream(tmpPath));
        const { data: { job_id } } = await api.post('/upload/async', form, { headers: form.getHeaders() });

        // Poll for completion, updating message on stage transitions
        let lastStage = null;
        const maxWait = 120_000;
        const pollMs  = 3_000;
        const started = Date.now();

        while (Date.now() - started < maxWait) {
            await new Promise(r => setTimeout(r, pollMs));
            const { data: job } = await api.get(`/upload/status/${job_id}`);

            if (job.status === 'done') {
                let docId = job.result?.additional_info?.rag_document_id;
                if (!docId) {
                    try {
                        const { data } = await api.get('/documents');
                        const docs = data?.documents;
                        if (docs?.length) {
                            docId = docs.sort((a, b) =>
                                new Date(b.upload_timestamp) - new Date(a.upload_timestamp)
                            )[0].id;
                        }
                    } catch { /* ignore */ }
                }
                if (!docId) throw new Error('Could not determine policy ID after upload. Please try again.');

                state[userId] = docId;
                delete state[`${userId}_session`];

                // Extract policy details and store in user profile for contextual chat + appointments
                const carrier      = job.result?.policyDetails?.carrier;
                const policyHolder = job.result?.policyDetails?.policyHolder;
                const policyNumber = job.result?.policyDetails?.policyNumber;
                const net          = job.result?.coverageCosts?.inNetwork;
                const profilePatch = {};
                if (carrier)      profilePatch.insuranceName    = carrier;
                if (policyHolder) profilePatch.patientName      = policyHolder;
                if (policyNumber) profilePatch.insuranceNumber  = policyNumber;
                // Store key cost numbers for benefits card + personalized greeting
                if (net?.deductible?.individual      != null) profilePatch.deductible      = net.deductible.individual;
                if (net?.outOfPocketMax?.individual  != null) profilePatch.outOfPocketMax  = net.outOfPocketMax.individual;
                if (net?.copay?.primaryCare          != null) profilePatch.copayPrimary    = net.copay.primaryCare;
                if (net?.copay?.specialist           != null) profilePatch.copaySpecialist = net.copay.specialist;
                if (net?.copay?.emergencyRoom        != null) profilePatch.copayER         = net.copay.emergencyRoom;
                if (net?.coinsurance)                         profilePatch.coinsurance     = net.coinsurance;
                if (Object.keys(profilePatch).length) setProfile(userId, profilePatch);

                saveState(state);

                bgB(userId, async b => {
                    const items = [
                        { text: `Active policy_id is ${docId}`, confidence: 0.99, type: 'claim', source: 'slack' },
                    ];
                    if (carrier)
                        items.push({ text: `Insurance carrier is ${carrier}`, confidence: 0.95, type: 'evidence', source: 'heal' });
                    if (net?.deductible?.individual != null)
                        items.push({ text: `In-network deductible is $${net.deductible.individual}`, confidence: 0.95, type: 'evidence', source: 'heal' });
                    if (net?.outOfPocketMax?.individual != null)
                        items.push({ text: `Out-of-pocket max is $${net.outOfPocketMax.individual}`, confidence: 0.95, type: 'evidence', source: 'heal' });
                    if (net?.coinsurance)
                        items.push({ text: `Coinsurance is ${net.coinsurance}`, confidence: 0.95, type: 'evidence', source: 'heal' });
                    if (net?.copay?.primaryCare)
                        items.push({ text: `Primary care copay is $${net.copay.primaryCare}`, confidence: 0.95, type: 'evidence', source: 'heal' });
                    await b.add(items);
                });

                // Kick off upfront profile collection if not yet done
                if (!getProfile(userId).collected) {
                    state[`${userId}_profileStep`] = 'location';
                    saveState(state);
                    await client.chat.update({
                        channel, ts,
                        text:
                            `✅ *Policy saved!* _(ID: \`${docId}\`)_\n\n` +
                            `Let's personalise your experience — a few quick questions.\n\n` +
                            `📍 *What city and state are you in?*\n` +
                            `_(e.g. "Phoenix, AZ" — helps me find nearby in-network providers)_\n\n` +
                            `_Type "skip" if you'd rather not share your location._`,
                    });
                } else {
                    await client.chat.update({
                        channel, ts,
                        text:
                            `✅ *Policy saved!* _(ID: \`${docId}\`)_\n\n` +
                            `You can now:\n` +
                            `• Ask me questions about your coverage\n` +
                            `• Upload a medical bill to check it for errors`,
                    });
                }
                return;
            }

            if (job.status === 'error') {
                throw new Error(job.error || 'Policy processing failed. Please try again.');
            }

            // Still processing — update Slack only when stage changes
            if (job.stage !== lastStage && STAGE_MSGS[job.stage]) {
                lastStage = job.stage;
                await client.chat.update({ channel, ts, text: STAGE_MSGS[job.stage] });
            }
        }

        throw new Error('Policy processing timed out. Please try again.');
    } finally {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
}

// ── Bill upload (async polling with live Slack updates) ───────────────────────

async function processBillUploadAsync(userId, file, client, channel, ts) {
    const policyId = await resolvePolicyId(userId);
    if (!policyId) {
        await client.chat.update({
            channel, ts,
            text: '⚠️ *No insurance policy on file.* Upload your policy first — include the word "policy" in your message.',
        });
        return;
    }

    const tmpPath = path.join(__dirname, `tmp_${Date.now()}_${file.name}`);
    try {
        // Download bill
        const dl = await axios.get(file.url_private_download, {
            headers: { Authorization: `Bearer ${BOT_TOKEN}` },
            responseType: 'arraybuffer',
            timeout: 30_000,
        });
        fs.writeFileSync(tmpPath, dl.data);

        // Upload bill file (fast)
        await client.chat.update({ channel, ts, text: '💸 _Analyzing your medical bill..._' });
        const form = new FormData();
        form.append('file', fs.createReadStream(tmpPath));
        const { data: { bill_id } } = await api.post('/bill-checker/upload', form, { headers: form.getHeaders() });

        // Kick off async analysis — returns job_id immediately
        const { data: { job_id } } = await api.post('/bill-checker/analyze/async', { bill_id, policy_id: policyId });

        // Poll for completion
        const maxWait = 120_000;
        const pollMs  = 3_000;
        const started = Date.now();

        while (Date.now() - started < maxWait) {
            await new Promise(r => setTimeout(r, pollMs));
            const { data: job } = await api.get(`/bill-checker/analyze/status/${job_id}`);

            if (job.status === 'done') {
                const data = job.result;
                const fin = data?.financial_breakdown;
                const discrepancyRaw = data?.discrepancy_check;
                const discrepancy = typeof discrepancyRaw === 'string'
                    ? discrepancyRaw
                    : (Array.isArray(discrepancyRaw) ? discrepancyRaw.join('. ') : JSON.stringify(discrepancyRaw ?? ''));
                const hasDiscrepancy = !!discrepancy && discrepancy !== 'No discrepancies found.';

                // Store bill result for reimbursement email flow
                if (hasDiscrepancy) {
                    state[`${userId}_lastBill`] = {
                        discrepancies:   discrepancy,
                        totalOvercharge: fin?.total_overcharge  || 0,
                        correctOwed:     fin?.correct_patient_responsibility,
                        billedAmount:    fin?.patient_responsibility,
                    };
                    saveState(state);
                }

                bgB(userId, b => b.after(
                    `Bill: patient owes $${fin?.patient_responsibility}. ${hasDiscrepancy ? 'Discrepancy found.' : 'Clean.'}`,
                    { source: 'heal_bill' }
                ));
                if (hasDiscrepancy) {
                    const ds = calcDisputeScore(fin, discrepancy);
                    bgB(userId, b => b.add([
                        { text: `Billing discrepancy: ${discrepancy?.substring(0, 120)}`, type: 'risk', confidence: 0.9, source: 'heal_bill' },
                        { text: `Billing dispute success probability is ${ds}%`, type: 'evidence', confidence: 0.8, source: 'heal_bill' },
                    ]));
                }

                const overcharge = fin?.total_overcharge;
                const correctOwed = fin?.correct_patient_responsibility;

                let reply;
                if (hasDiscrepancy) {
                    const overchargeLabel = overcharge > 0 ? ` — *${fmt$(overcharge)} overcharge detected*` : '';
                    const disputeScore = calcDisputeScore(fin, discrepancy);
                    const scoreLabel = disputeScore >= 80 ? 'Strong case' : disputeScore >= 65 ? 'Good case' : 'Reasonable case';
                    reply = `🚨 *Billing Errors Found!*${overchargeLabel}\n`;
                    reply += `🎯 *Dispute Likelihood: ${disputeScore}% — ${scoreLabel}*\n\n`;

                    // Financial summary
                    reply += `*Financial Summary*\n`;
                    reply += `> Total Billed: *${fmt$(fin?.total_charges)}*\n`;
                    const discount = fin?.amount_saved;
                    if (discount > 0) {
                        reply += `> Network Discount: -${fmt$(discount)}\n`;
                    } else {
                        reply += `> Network Discount: $0.00 ❌  _not applied_\n`;
                    }
                    if (fin?.insurance_payment > 0) {
                        reply += `> Insurance Payment: -${fmt$(fin.insurance_payment)}\n`;
                    } else {
                        reply += `> Insurance Payment: $0.00 ❌  _not credited_\n`;
                    }
                    reply += `> Bill Claims You Owe: *${fmt$(fin?.patient_responsibility)}* ❌\n`;
                    if (correctOwed != null) {
                        reply += `> Correct Amount Owed: *${fmt$(correctOwed)}* ✅\n`;
                    }
                    reply += '\n';

                    // Numbered discrepancies
                    reply += `*Discrepancies*\n\n`;
                    reply += formatFindings(discrepancy);
                    reply += `\n\n*Next Steps:* Call the billing department and request a corrected statement. `;
                    reply += `Ask them to apply all EOB adjustments and insurance payments. You can dispute in writing if they refuse.`;
                } else {
                    reply = `✅ *HEAL Financial Breakdown*\n\n`;
                    reply += `> Total Billed: *${fmt$(fin?.total_charges)}*\n`;
                    reply += `> Network Discount: -${fmt$(fin?.amount_saved || 0)}\n`;
                    reply += `> Insurance Pays: ${fmt$(fin?.insurance_payment)}\n`;
                    reply += `> *You Owe: ${fmt$(fin?.patient_responsibility)}*\n\n`;
                    reply += `✅ No discrepancies found — your bill matches your policy.`;
                }
                reply += `\n\n_Powered by HEAL AI + Thinkn_`;

                await client.chat.update({ channel, ts, text: reply });
                return;
            }

            if (job.status === 'error') {
                throw new Error(job.error || 'Bill analysis failed. Please try again.');
            }
            // still processing — leave current message as-is
        }

        throw new Error('Bill analysis timed out. Please try again.');
    } finally {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
}

// ── Chat ──────────────────────────────────────────────────────────────────────

// ── Profile helpers ───────────────────────────────────────────────────────────

function getProfile(userId) { return state[`${userId}_profile`] || {}; }
function setProfile(userId, patch) {
    state[`${userId}_profile`] = { ...getProfile(userId), ...patch };
    saveState(state);
}

// Queries that want a REAL-WORLD provider location (triggers OSM search)
// Distinct from policy questions that merely *mention* hospitals/doctors
const SEARCH_INTENT = /near(by| me| my|est)|\bfind (a|me|the|an?)\b|\bshow me\b|\bwhere (can i|should i|do i) (go|visit|find|see)\b|in my area|close to me|covered.*(near|in|around)|(hospital|clinic|provider|doctor|dentist|pharmacy|urgent care).*(near|around|close|visit|covered)/i;

// Queries that need location context → contextual endpoint (coverage questions that mention location)
const LOCATION_INTENT = /hospital|clinic|urgent care|er\b|emergency room|doctor|specialist|physician|provider|dentist|pharmacy|near(by)?|close to|in my area|find a|where (can|do|should)|covered (near|in)/i;

// Queries that are clearly asking for medical advice (hard block).
// "do i have" stays here to catch "do I have diabetes?" — the COVERAGE_QUERY guard
// at the call site prevents false positives like "do I have dental coverage."
const MEDICAL_ADVICE_INTENT = /should i take|diagnos|prescri|my symptom|\bdo i have\b|is it (serious|cancer|covid|flu)|what (disease|condition)|treat(ment)? for/i;

// Medical facility types — used to detect "hospitals in X" style queries
const MEDICAL_FACILITY_RE = /\b(hospital|clinic|urgent care|er\b|emergency room|doctor|specialist|dentist|pharmacy|provider)\b/i;

/**
 * Extract an explicit city/location from query text like "hospitals in Salt Lake City"
 * or "find a doctor near Austin, TX".
 *
 * Returns null when no named location is found (i.e. user just said "near me").
 * Filters out pronouns and vague words ("me", "here", "my area", "network", "plan").
 */
function extractLocationFromText(text) {
    // Vague words that look like locations but aren't place names
    const NOT_PLACE = /^(me|here|the|a|an|my|your|this|that|there|anywhere|somewhere|any|network|plan|area|home|work)$/i;

    // Match "in/near/around/at <Location Name>" — up to 4 words
    const m = text.match(/\b(?:in|near|around|at)\s+((?:[A-Za-z][A-Za-z'-]*(?:\s+|,\s*)?){1,4})/);
    if (!m) return null;

    // Strip trailing punctuation and comma-only tails
    let candidate = m[1].trim().replace(/[,.\s]+$/, '');
    if (!candidate) return null;

    const firstWord = candidate.split(/[\s,]+/)[0];

    // Reject if it starts with a non-place word
    if (NOT_PLACE.test(firstWord)) return null;

    // Reject phrases like "my network", "the plan", "in-network"
    if (/^(network|plan|my|the|a|an|this|your|in-network)/i.test(candidate)) return null;

    return candidate;
}

// Signals the user is asking about their insurance/coverage (not medical advice).
// Used to prevent false-positive MEDICAL_ADVICE_INTENT blocks on coverage questions.
// Note: no trailing \b — "insurance", "coinsurance" etc. contain substrings that
// would fail a trailing word-boundary check if abbreviated.
const COVERAGE_QUERY = /\b(coverage|covered|covers?|insurance|insured|insurer|policy|benefits?|copay|deductible|in-network|out.of.pocket|out.of.network|premium|coinsurance|plan|dental|vision|mental.health|prescription|formulary)/i;

// Appointment booking intent
const APPOINTMENT_INTENT = /book|schedule|appointment|appt|campus (health|clinic)|health center|make an? (appointment|booking)/i;

// Reimbursement email intent
const EMAIL_INTENT = /email|dispute (letter|email)|reimburs|send.*bill|billing (dispute|complaint)|send.*email/i;
// Retry keywords that should re-enter an in-progress email confirm step
const EMAIL_RETRY = /^(send|try again|retry|yes)$/i;

// Benefits card intent
const BENEFITS_INTENT = /\bmy (benefits?|coverage|plan|insurance summary|policy summary)\b|show (my )?(benefits?|coverage|plan)|what('s| is) (covered|my coverage|my benefits?|my plan)|coverage (summary|card|overview)/i;

// Health profile / beliefs world state intent
const PROFILE_INTENT = /\bmy (health )?profile\b|(show|what) (do you know about me|is my profile|have you learned|have you stored)|health (profile|summary|record)/i;

/** Build a Google Calendar quick-add URL pre-filled with appointment details */
function makeCalendarLink({ name, university, phone, datetime, reason, insuranceName, insuranceNumber, conditions }) {
    const uniHealth = university ? `${university} Health Center` : 'Campus Health Center';

    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: `Medical Appointment — ${uniHealth}`,
        details: [
            `Patient: ${name || 'N/A'}`,
            `Phone: ${phone || 'N/A'}`,
            `Insurance: ${insuranceName || 'N/A'}`,
            `Insurance #: ${insuranceNumber || 'N/A'}`,
            `Pre-existing conditions: ${conditions || 'None'}`,
            `Reason: ${reason || 'N/A'}`,
        ].join('\n'),
        location: uniHealth,
    });

    // Try to parse the datetime string for calendar dates (YYYYMMDDTHHMMSSZ/...)
    if (datetime) {
        const parsed = new Date(datetime);
        if (!isNaN(parsed.getTime())) {
            const fmt = d => d.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
            const end = new Date(parsed.getTime() + 60 * 60 * 1000); // 1-hour slot
            params.set('dates', `${fmt(parsed)}/${fmt(end)}`);
        }
    }

    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

async function handleChat(userId, text) {
    const policyId = await resolvePolicyId(userId);
    if (!policyId) {
        return '⚠️ *No insurance policy on file.* Upload your policy first — include the word "policy" in your message.';
    }

    const profile = getProfile(userId);

    // ── In-progress flow interceptors (appointment / email) ───────────────────
    if (state[`${userId}_aptStep`])   return await handleAppointmentStep(userId, text);
    if (state[`${userId}_emailStep`]) return await handleEmailStep(userId, text);
    // Retry shorthand when no active step but draft is still saved
    if (state[`${userId}_emailDraft`] && EMAIL_RETRY.test(text.trim())) {
        state[`${userId}_emailStep`] = 'confirm';
        saveState(state);
        return await handleEmailStep(userId, text);
    }

    // ── Profile collection state machine ─────────────────────────────────────
    const step = state[`${userId}_profileStep`];

    if (step === 'location') {
        const loc = text.trim();
        if (/^skip$/i.test(loc)) {
            setProfile(userId, { locationSkipped: true });
        } else {
            setProfile(userId, { location: loc });
            bgB(userId, b => b.add([
                { text: `User is located in ${loc}`, confidence: 0.99, type: 'evidence', source: 'user' }
            ]));
        }
        // Move to conditions step
        state[`${userId}_profileStep`] = 'conditions';
        saveState(state);
        return `📍 Got it${profile.locationSkipped ? '' : ` — *${text.trim()}*`}.\n\nOne more (optional): do you have any *pre-existing conditions* I should keep in mind? _(e.g. "diabetes, hypertension" — or type "skip")_`;
    }

    if (step === 'conditions') {
        if (!/^skip$/i.test(text.trim())) {
            const cond = text.trim();
            setProfile(userId, { conditions: cond });
            bgB(userId, b => b.add([
                { text: `Pre-existing conditions: ${cond}`, confidence: 0.9, type: 'evidence', source: 'user' }
            ]));
        }
        // Move to university step
        state[`${userId}_profileStep`] = 'university';
        saveState(state);
        return `🎓 Are you a student? *What university do you attend?*\n_(e.g. "Arizona State University" — helps me find your campus health center)_\n\n_Type "skip" if not applicable._`;
    }

    if (step === 'university') {
        const uniInput = text.trim();
        // Reject bare yes/no — user probably answered "are you a student?" instead of giving the name
        const isVague = /^(yes|no|yeah|nope|ok|okay|sure|n\/a|na|none|nah|yep|yup|maybe|idk|not sure)$/i.test(uniInput);
        if (isVague) {
            return `🎓 Got it! What's the *name* of your university?\n_(e.g. "Arizona State University")_\n\n_Type "skip" if you're not a student or prefer not to say._`;
        }
        if (!/^skip$/i.test(uniInput)) {
            // Sanitize before storing — strips "yes, X" prefix so profile doesn't
            // end up as "yes, Arizona State". Falls back to raw input if sanitize
            // can't extract anything (shouldn't happen after the isVague check above).
            const uni = sanitizeUni(uniInput) || uniInput;
            setProfile(userId, { university: uni });
            bgB(userId, b => b.add([
                { text: `Student at ${uni}`, confidence: 0.95, type: 'evidence', source: 'user' }
            ]));
        }
        delete state[`${userId}_profileStep`];
        setProfile(userId, { collected: true });

        const queued = state[`${userId}_queued`];
        delete state[`${userId}_queued`];
        saveState(state);

        const uni = getProfile(userId).university;
        const confirmMsg = `✅ *Profile saved!*${uni ? ` I know your campus health center at *${uni}*.` : ''} Ask me anything — coverage questions, nearby providers, or type *"book appointment"* to schedule a campus clinic visit.\n\n`;
        if (queued) {
            const answer = await routeChat(userId, queued, policyId);
            return confirmMsg + answer;
        }
        return confirmMsg;
    }

    // ── First interaction — collect profile ───────────────────────────────────
    if (!profile.collected && !profile.locationSkipped && !state[`${userId}_profileStep`]) {
        state[`${userId}_profileStep`] = 'location';
        state[`${userId}_queued`]      = text;
        saveState(state);
        return (
            `👋 Before I answer, a quick question — *what city and state are you in?*\n` +
            `_(e.g. "Phoenix, AZ" — helps me find nearby in-network providers)_\n\n` +
            `_Type "skip" if you'd rather not share your location._`
        );
    }

    // ── Route to appropriate handler ──────────────────────────────────────────
    return await routeChat(userId, text, policyId);
}

// ── Appointment booking ───────────────────────────────────────────────────────

// ── Date/time parser for appointment booking ─────────────────────────────────
// Returns { iso, display } on success, null if the input is too ambiguous.
// Stores ISO string so generateICS always gets a clean Date — no more guessing.
//
// tzOffsetSeconds: user's UTC offset in seconds (from profile.tzOffset).
// Used to calculate "user-local now" so past-date detection is correct when the
// server runs in a different timezone than the user (e.g. server=UTC, user=UTC-7).

function tryParseDateTime(raw, tzOffsetSeconds = null) {
    // "now" from the user's perspective.
    // If tzOffset is available, shift: userNow = serverNow + (userOffset - serverOffset)
    const serverNow = new Date();
    const now = tzOffsetSeconds != null
        ? new Date(serverNow.getTime() + (tzOffsetSeconds - (-serverNow.getTimezoneOffset() * 60)) * 1000)
        : serverNow;
    const yr  = now.getFullYear();

    // Helper: build a { iso, display, date } result from a resolved Date
    const makeResult = d => ({
        iso:     d.toISOString(),
        display: d.toLocaleString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long',
            day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
        }),
        date: d,
    });

    // 0. Handle relative weekday names: "monday", "next friday 3pm", "this tuesday at 9am"
    //    V8's Date parser resolves bare weekday names to arbitrary far-future dates — do it ourselves.
    const WEEKDAY_RE = /^(?:(next|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b(.*)/i;
    const wdMatch = raw.trim().match(WEEKDAY_RE);
    if (wdMatch) {
        const modifier  = (wdMatch[1] || '').toLowerCase();   // 'next', 'this', or ''
        const weekday   = wdMatch[2].toLowerCase();
        const timePart  = wdMatch[3].trim();
        const DAYS      = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
        const targetDay = DAYS.indexOf(weekday);

        const base = new Date(now);
        base.setHours(0, 0, 0, 0);
        let daysAhead = ((targetDay - base.getDay()) + 7) % 7;
        if (daysAhead === 0) daysAhead = 7;    // today is that day → next week's occurrence
        if (modifier === 'next') daysAhead += 7; // "next X" → skip the immediate one
        base.setDate(base.getDate() + daysAhead);

        // Parse the time component if provided ("3pm", "at 2:30 PM", "14:00", "9 AM")
        if (timePart) {
            // Strip filler words, collapse spaces — but do NOT pre-normalise digits here
            // (pre-normalising "2:30 PM" → "2:30:00 PM" would break the 12-hr regex below)
            const t = timePart.replace(/\bat\b/gi, ' ').replace(/\s+/g, ' ').trim();

            // 12-hour: "2 PM", "2:30pm", "2:30 PM", "9AM"
            const m12 = t.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
            // 24-hour: "14:30" (only when no am/pm found)
            const m24 = !m12 && t.match(/(\d{1,2}):(\d{2})/);

            if (m12) {
                let h = parseInt(m12[1]);
                const min = parseInt(m12[2] || '0');
                const ap = m12[3].toUpperCase();
                if (ap === 'PM' && h < 12) h += 12;
                if (ap === 'AM' && h === 12) h = 0;
                base.setHours(h, min, 0, 0);
            } else if (m24) {
                base.setHours(parseInt(m24[1]), parseInt(m24[2]), 0, 0);
            }
        }

        return makeResult(base);
    }

    // 1. Capitalise month names so V8 handles "april" reliably
    const withMonth = raw.replace(
        /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi,
        m => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()
    );

    // 2. "9am" / "9 am" → "9:00 AM"  (must run before "at" removal)
    const normed = withMonth
        .replace(/\b(\d{1,2})\s*(am|pm)\b/gi, (_, h, ap) => `${h}:00 ${ap.toUpperCase()}`)
        .replace(/\bat\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // 3. Try: normed as-is, then append current year, then next year
    for (const candidate of [normed, `${normed} ${yr}`, `${normed} ${yr + 1}`]) {
        const d = new Date(candidate);
        if (!isNaN(d.getTime()) && d.getFullYear() >= 2024 && d.getFullYear() <= 2030) {
            // Bump to next year if the date is > 1 day in the past (recurring annual dates)
            if (d < new Date(now.getTime() - 86_400_000)) d.setFullYear(d.getFullYear() + 1);
            return makeResult(d);
        }
    }
    return null;  // caller should re-ask
}

// Strips vague yes/no answers and accidental "yes, X" prefixes from university field
function sanitizeUni(u) {
    if (!u) return null;
    const VAGUE_EXACT = /^(yes|no|yeah|nope|ok|okay|sure|n\/a|na|none|nah|yep|yup|maybe|idk)$/i;
    if (VAGUE_EXACT.test(u.trim())) return null;
    const stripped = u.trim().replace(/^(yes|no|yeah|nope|ok|okay)\s*[,;]\s*/i, '').trim();
    return stripped || null;
}

async function startAppointment(userId) {
    const profile = getProfile(userId);
    const uni     = sanitizeUni(profile.university);
    const uniHealth = uni ? `${uni} Health Center` : 'your campus health center';

    // Seed accumulator with whatever we already know from the policy
    state[`${userId}_apt`] = {
        name:           profile.patientName    || null,
        insuranceName:  profile.insuranceName  || null,
        insuranceNumber: profile.insuranceNumber || null,
        conditions:     profile.conditions     || null,
        university:     uni                    || null,
    };

    if (!profile.patientName) {
        state[`${userId}_aptStep`] = 'name';
        saveState(state);
        return (
            `📅 *Book a Campus Appointment*\n\n` +
            `Let's get you set up at ${uniHealth}.\n\n` +
            `What is your *full name*?`
        );
    }

    state[`${userId}_aptStep`] = 'phone';
    saveState(state);
    return (
        `📅 *Book a Campus Appointment*\n\n` +
        `Setting up your visit at ${uniHealth}.\n\n` +
        `*Name:* ${profile.patientName} ✓\n` +
        `*Insurance:* ${profile.insuranceName || 'from your policy'} ✓\n\n` +
        `What is your *phone number*?`
    );
}

// Shared appointment completion — called once all required fields are known.
// Extracted so both the 'reason' step (email already on file) and the 'email'
// step (email just collected) can reach the same finish without code duplication.
async function finishAppointment(userId, apt, profile) {
    const uni       = sanitizeUni(apt.university) || sanitizeUni(profile.university) || null;
    const aptMerged = { ...apt, ...profile, university: uni };
    const calLink   = makeCalendarLink(aptMerged);
    const uniHealth = uni ? `${uni} Health Center` : 'Campus Health Center';

    let emailNote = '';
    const toEmail = profile.email;
    if (toEmail && isEmailConfigured()) {
        try {
            await sendCalendarInvite({ to: toEmail, ...aptMerged });
            emailNote = `\n\n📧 *Calendar invite sent to* ${toEmail}`;
        } catch (err) {
            console.error('[calendar-email]', err.message);
            emailNote = `\n\n⚠️ _Couldn't send calendar email: ${err.message}_`;
        }
    }

    return (
        `📅 *Appointment Request Ready!*\n\n` +
        `*Location:* ${uniHealth}\n` +
        `*Patient:* ${apt.name}\n` +
        `*Phone:* ${apt.phone}\n` +
        `*Insurance:* ${apt.insuranceName || 'On file'} (${apt.insuranceNumber || 'see policy'})\n` +
        `*Conditions:* ${apt.conditions || profile.conditions || 'None reported'}\n` +
        `*Date/Time:* ${apt.datetimeDisplay || apt.datetime}\n` +
        `*Reason:* ${apt.reason}\n\n` +
        `👉 <${calLink}|*Add to Google Calendar*>` +
        emailNote
    );
}

async function handleAppointmentStep(userId, text) {
    const aptStep = state[`${userId}_aptStep`];
    const apt     = state[`${userId}_apt`] || {};
    const profile = getProfile(userId);

    if (aptStep === 'name') {
        apt.name = text.trim();
        state[`${userId}_apt`]   = apt;
        state[`${userId}_aptStep`] = 'phone';
        saveState(state);
        return `👤 *Name:* ${apt.name} ✓\n\nWhat is your *phone number*?`;
    }

    if (aptStep === 'phone') {
        apt.phone = text.trim();
        state[`${userId}_apt`]   = apt;
        state[`${userId}_aptStep`] = 'datetime';
        saveState(state);
        return (
            `📱 *Phone:* ${apt.phone} ✓\n\n` +
            `What is your *preferred date and time?*\n` +
            `_(e.g. "Monday at 2pm", "April 15 at 10am")_`
        );
    }

    if (aptStep === 'datetime') {
        const parsed = tryParseDateTime(text.trim(), profile.tzOffset ?? null);
        if (!parsed) {
            // Don't advance the step — ask again with a clear example
            return (
                `🗓️ I couldn't parse *"${text.trim()}"* as a date and time.\n\n` +
                `Please be more specific:\n` +
                `• *"April 20 at 9am"*\n` +
                `• *"April 20, 2026 2:30pm"*\n` +
                `• *"2026-04-20 14:30"*`
            );
        }
        apt.datetime        = parsed.iso;      // ISO string → ICS generation is reliable
        apt.datetimeDisplay = parsed.display;  // human-readable for Slack
        state[`${userId}_apt`]     = apt;
        state[`${userId}_aptStep`] = 'reason';
        saveState(state);
        return (
            `🗓️ *Date/Time:* ${parsed.display} ✓\n\n` +
            `What is the *reason for your visit?*\n` +
            `_(e.g. "annual checkup", "sore throat", "prescription refill")_`
        );
    }

    if (aptStep === 'reason') {
        apt.reason = text.trim();
        state[`${userId}_apt`] = apt;

        // Gap check: if no email on file, pause and ask before finalising.
        // Without it we can't send the .ics invite, and we know they'll want one.
        if (!profile.email && isEmailConfigured()) {
            state[`${userId}_aptStep`] = 'email';
            saveState(state);
            return (
                `✅ *Reason:* ${apt.reason} ✓\n\n` +
                `Almost done! To send you a *calendar invite (.ics)* I need your email.\n\n` +
                `*What's your email address?*\n` +
                `_(e.g. "you@email.com" — type "skip" to skip the invite)_`
            );
        }

        // Email already on file — clean up state BEFORE calling finishAppointment.
        // If we don't delete here, the next user message would re-enter handleAppointmentStep
        // with aptStep='reason' and treat it as a new appointment request.
        delete state[`${userId}_aptStep`];
        delete state[`${userId}_apt`];
        saveState(state);
        return await finishAppointment(userId, apt, profile);
    }

    if (aptStep === 'email') {
        // User is providing their email so we can send the calendar invite
        if (/^skip$/i.test(text.trim())) {
            // They chose to skip — complete without email
            delete state[`${userId}_aptStep`];
            const savedApt = state[`${userId}_apt`] || apt;
            delete state[`${userId}_apt`];
            saveState(state);
            return await finishAppointment(userId, savedApt, profile);
        }

        const emailMatch = text.trim().match(/[\w.+%-]+@[\w.-]+\.[a-zA-Z]{2,}/);
        if (!emailMatch) {
            // Invalid format — re-ask, don't advance
            return (
                `📧 That doesn't look like a valid email address. Try again:\n` +
                `_(e.g. "you@example.com" — or type "skip" to skip the invite)_`
            );
        }

        const captured = emailMatch[0].toLowerCase();
        setProfile(userId, { email: captured });
        bgB(userId, b => b.add([
            { text: `User email is ${captured}`, confidence: 1.0, type: 'evidence', source: 'user' }
        ]));

        delete state[`${userId}_aptStep`];
        const savedApt = state[`${userId}_apt`] || apt;
        delete state[`${userId}_apt`];
        saveState(state);
        return await finishAppointment(userId, savedApt, getProfile(userId));  // re-fetch profile with new email
    }

    // Unknown step — reset gracefully
    delete state[`${userId}_aptStep`];
    delete state[`${userId}_apt`];
    saveState(state);
    return '⚠️ Something went wrong. Type *"book appointment"* to start again.';
}

// ── Reimbursement email ───────────────────────────────────────────────────────

async function startEmail(userId) {
    if (!isEmailConfigured()) {
        return (
            `⚠️ *Email not configured.* Add \`GMAIL_USER\` and \`GMAIL_APP_PASSWORD\` to \`.env\` to enable this feature.\n\n` +
            `Setup (2 min):\n` +
            `1. Enable 2FA: myaccount.google.com → Security → 2-Step Verification\n` +
            `2. Create App Password: myaccount.google.com → Security → App passwords → "HEAL"\n` +
            `3. Paste the 16-char password as \`GMAIL_APP_PASSWORD\` in \`heal-slack-bot/.env\``
        );
    }

    const bill = state[`${userId}_lastBill`];
    if (!bill?.discrepancies) {
        return (
            `⚠️ *No bill discrepancies on file.* Upload a medical bill first — ` +
            `I'll find any errors, then you can send a dispute letter directly from here.`
        );
    }

    state[`${userId}_emailStep`] = 'to';
    saveState(state);
    return (
        `📧 *Send Billing Dispute Letter*\n\n` +
        `I'll draft a formal dispute letter based on your last bill analysis.\n\n` +
        `What is the *billing department's email address?*\n` +
        `_(Or type \`me\` to send it to yourself for review)_`
    );
}

async function handleEmailStep(userId, text) {
    const emailStep = state[`${userId}_emailStep`];
    const profile   = getProfile(userId);
    const bill      = state[`${userId}_lastBill`] || {};

    if (emailStep === 'capture_email') {
        // User typed "me" but had no email on file — we asked for it, this is the reply
        if (/^skip$/i.test(text.trim())) {
            // They don't want to give email — fall back to bot Gmail with a note
            state[`${userId}_emailStep`] = 'to';
            saveState(state);
            return await handleEmailStep(userId, process.env.GMAIL_USER || '');
        }
        const emailMatch = text.trim().match(/[\w.+%-]+@[\w.-]+\.[a-zA-Z]{2,}/);
        if (!emailMatch) {
            return (
                `📧 That doesn't look like a valid email. Try again:\n` +
                `_(e.g. "you@example.com" — or type "skip" to send to the bot's Gmail)_`
            );
        }
        const captured = emailMatch[0].toLowerCase();
        setProfile(userId, { email: captured });
        bgB(userId, b => b.add([
            { text: `User email is ${captured}`, confidence: 1.0, type: 'evidence', source: 'user' }
        ]));
        // Continue with the now-known email address
        state[`${userId}_emailStep`] = 'to';
        saveState(state);
        return await handleEmailStep(userId, captured);
    }

    if (emailStep === 'to') {
        const rawTo = text.trim();

        // "me" with no email → ask for it first rather than silently using bot's Gmail
        if (rawTo.toLowerCase() === 'me' && !profile.email) {
            state[`${userId}_emailStep`] = 'capture_email';
            saveState(state);
            return (
                `📧 To send it to yourself I need your email address.\n\n` +
                `*What's your email?*\n` +
                `_(e.g. "you@example.com" — type "skip" to use the bot's Gmail as a fallback)_`
            );
        }

        // "me" with email on file, or explicit address
        const to = rawTo.toLowerCase() === 'me' ? profile.email : rawTo;

        const draft = {
            to,
            patientName:     profile.patientName    || 'Patient',
            insuranceName:   profile.insuranceName  || 'Insurance',
            insuranceNumber: profile.insuranceNumber || 'N/A',
            discrepancies:   bill.discrepancies     || 'See attached bill.',
            totalOvercharge: bill.totalOvercharge   || 0,
            correctOwed:     bill.correctOwed,
            billedAmount:    bill.billedAmount,
        };

        state[`${userId}_emailDraft`] = draft;
        state[`${userId}_emailStep`]  = 'confirm';
        saveState(state);

        return previewLetter(draft);
    }

    if (emailStep === 'confirm') {
        const trimmed   = text.trim().toLowerCase();
        const cancelled = trimmed === 'cancel';
        const confirmed = /^(send|try again|retry|yes)/.test(trimmed);

        if (cancelled) {
            delete state[`${userId}_emailStep`];
            delete state[`${userId}_emailDraft`];
            saveState(state);
            return '🚫 *Dispute email cancelled.* Type *"email dispute"* any time to try again.';
        }

        if (!confirmed) {
            return 'Please reply *send* to send the email, or *cancel* to abort.';
        }

        // Keep state alive until we know the send succeeded
        const draft = state[`${userId}_emailDraft`] || {};
        try {
            const { subject, to } = await sendDisputeLetter(draft);
            // Only clear state on success
            delete state[`${userId}_emailStep`];
            delete state[`${userId}_emailDraft`];
            saveState(state);
            bgB(userId, b => b.add(
                `Billing dispute email sent to ${to}`,
                { type: 'action', confidence: 1.0, source: 'heal_email' }
            ));
            return (
                `✅ *Dispute letter sent!*\n\n` +
                `*To:* ${to}\n` +
                `*Subject:* ${subject}\n\n` +
                `_Keep a copy for your records. If the billing department doesn't respond within 30 days, ` +
                `you can escalate to your state insurance commissioner._`
            );
        } catch (err) {
            console.error('[email]', err.message);
            // Leave state intact so user can fix .env and type "send" again
            return (
                `❌ *Failed to send:* ${err.message}\n\n` +
                `Fix your \`GMAIL_APP_PASSWORD\` in \`.env\`, restart the bot, then type *send* to retry — your draft is still saved.`
            );
        }
    }

    // Unknown step — reset
    delete state[`${userId}_emailStep`];
    delete state[`${userId}_emailDraft`];
    saveState(state);
    return '⚠️ Something went wrong. Type *"email dispute"* to start again.';
}

async function routeChat(userId, text, policyId) {
    const profile = getProfile(userId);

    // Appointment booking
    if (APPOINTMENT_INTENT.test(text)) {
        return await startAppointment(userId);
    }

    // Email address capture — "my email is X" / "my email: X" / "email: X@Y.com"
    // Must fire BEFORE EMAIL_INTENT (which would wrongly match the word "email")
    const emailCapture = text.match(/(?:my\s+)?email\s*(?:is|[:=])\s*([\w.+%-]+@[\w.-]+\.[a-zA-Z]{2,})/i);
    if (emailCapture) {
        const captured = emailCapture[1].toLowerCase();
        setProfile(userId, { email: captured });
        bgB(userId, b => b.add([
            { text: `User email is ${captured}`, confidence: 1.0, type: 'evidence', source: 'user' }
        ]));
        return `✅ *Email saved:* ${captured}\n\n_I'll use this for calendar invites and dispute letters._`;
    }

    // Reimbursement email
    if (EMAIL_INTENT.test(text)) {
        return await startEmail(userId);
    }

    // Benefits coverage card
    if (BENEFITS_INTENT.test(text)) {
        return await handleBenefitsCard(userId, policyId);
    }

    // Health profile / beliefs world state
    if (PROFILE_INTENT.test(text)) {
        return await handleHealthProfile(userId);
    }

    // Hard block: medical advice.
    // Skip the block if the message is clearly about insurance/coverage — "do I have
    // dental coverage" and "is my prescription covered" are coverage questions, not
    // requests for medical diagnosis or treatment advice.
    if (MEDICAL_ADVICE_INTENT.test(text) && !COVERAGE_QUERY.test(text)) {
        return (
            `⚠️ *I can't provide medical advice, diagnoses, or treatment recommendations.*\n\n` +
            `If this is an emergency, call *911* immediately.\n\n` +
            `I *can* help you find in-network providers nearby, understand your coverage, ` +
            `or check whether a procedure is covered. What would you like to know?`
        );
    }

    // Real-world provider search → OpenStreetMap (not Gemini hallucination)
    //
    // Two triggers:
    //  1. Standard SEARCH_INTENT ("find a hospital near me", "hospitals near Phoenix")
    //  2. Explicit named city + medical facility type ("hospitals in Salt Lake City",
    //     "doctors in Austin TX") — this catches queries that don't match SEARCH_INTENT
    //     but clearly want a real-world result, not a RAG/policy answer.
    const explicitSearchLoc = extractLocationFromText(text);
    if (SEARCH_INTENT.test(text) || (MEDICAL_FACILITY_RE.test(text) && explicitSearchLoc)) {
        // handleProviderSearch now resolves location internally (explicit > profile)
        // so we only need to gate on "no location at all" here.
        if (!profile.location && !explicitSearchLoc) {
            // Queue the question, collect location first
            state[`${userId}_profileStep`] = 'location';
            state[`${userId}_queued`]      = text;
            saveState(state);
            return (
                `📍 To find nearby providers I need your location.\n\n` +
                `*What city and state are you in?*\n` +
                `_(e.g. "Phoenix, AZ" — or type "skip" for a Google Maps link)_`
            );
        }
        return await handleProviderSearch(userId, text, profile);
    }

    // Location / coverage context → RAG + location endpoint
    if (LOCATION_INTENT.test(text)) {
        return await handleContextualChat(userId, text, profile, policyId);
    }

    // Standard RAG for policy/coverage questions.
    // After answering, append a one-line gap hint if critical info is missing and
    // would meaningfully improve future interactions.  One hint at a time — not a
    // nag list.  Only appended on the standard RAG path (not on location/search/
    // appointment flows which already ask for what they need inline).
    const ragReply = await handleRagChat(userId, text);
    const hint = gapHint(profile, text);
    return hint ? `${ragReply}\n\n${hint}` : ragReply;
}

/**
 * Returns a single contextually relevant tip when a critical profile field is
 * missing and the user's question suggests they would benefit from it.
 * Returns null when nothing useful to say.
 */
function gapHint(profile, text) {
    const lc = text.toLowerCase();

    // No email and they're asking about appointments, billing, or sending things
    if (!profile.email && /appoint|book|invite|calendar|dispute|letter|send|email/i.test(lc)) {
        return `_💡 Tip: Tell me your email (\`my email is you@example.com\`) and I'll send calendar invites and dispute letters directly to you._`;
    }

    // No location and they asked something that mentions hospitals, doctors, or nearby
    if (!profile.location && /hospital|clinic|doctor|specialist|urgent care|near|provider/i.test(lc)) {
        return `_💡 Tip: Tell me your city (\`I'm in Phoenix, AZ\`) and I can show real nearby providers._`;
    }

    // No university and they asked about campus health, student, or campus
    if (!sanitizeUni(profile.university) && /campus|student|university|college|health cent/i.test(lc)) {
        return `_💡 Tip: Tell me your university and I'll tailor campus health center appointments for you._`;
    }

    return null;
}

async function handleContextualChat(userId, text, profile, policyId) {
    const lastBill = state[`${userId}_lastBill`] || {};
    const history  = getContextualHistory(userId);

    const { data } = await api.post('/chat/contextual', {
        message:              text,
        location:             profile.location       || '',
        conditions:           profile.conditions     || '',
        insurance_name:       profile.insuranceName  || '',
        policy_id:            policyId,
        user_context:         buildUserContext(profile, lastBill),
        conversation_history: history,
    });

    const rawReply = data.message || data.response || JSON.stringify(data);

    // Persist this exchange to the contextual history buffer
    appendContextualHistory(userId, 'user',      text);
    appendContextualHistory(userId, 'assistant', rawReply);

    bgB(userId, b => b.after(rawReply, { source: 'heal_contextual' }));
    return `🧠 *HEAL:*\n\n${rawReply}`;
}

// ── Hospital / provider search (OpenStreetMap — free, no API key) ─────────────

// Cache geocoded coordinates per location string to respect Nominatim 1 req/sec
const geocodeCache = {};

async function geocodeLocation(locationStr) {
    if (geocodeCache[locationStr]) return geocodeCache[locationStr];
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationStr)}&format=json&limit=1`;
    const { data } = await axios.get(url, {
        headers: { 'User-Agent': 'HEAL-AI-HealthcareBot/1.0 (hackathon project)' },
        timeout: 10_000,
    });
    if (!data?.length) return null;
    const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    geocodeCache[locationStr] = result;
    return result;
}

async function searchNearbyHospitals(locationStr, radiusMeters = 15000, amenityType = null) {
    const coords = await geocodeLocation(locationStr);
    if (!coords) return [];

    const amenityFilter = amenityType
        ? `["amenity"="${amenityType}"]`
        : `["amenity"~"hospital|clinic|urgent_care"]`;

    const query =
        `[out:json][timeout:20];\n` +
        `(\n` +
        `  node${amenityFilter}(around:${radiusMeters},${coords.lat},${coords.lng});\n` +
        `  way${amenityFilter}(around:${radiusMeters},${coords.lat},${coords.lng});\n` +
        `);\n` +
        `out center 8;`;

    const { data } = await axios.post(
        'https://overpass-api.de/api/interpreter',
        `data=${encodeURIComponent(query)}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 25_000 }
    );

    return (data.elements || [])
        .filter(el => el.tags?.name)
        .map(el => {
            const lat = el.lat ?? el.center?.lat;
            const lng = el.lon ?? el.center?.lon;
            const addr = [
                el.tags['addr:housenumber'],
                el.tags['addr:street'],
                el.tags['addr:city'] || locationStr,
            ].filter(Boolean).join(' ');
            return { name: el.tags.name, addr, lat, lng, type: el.tags.amenity };
        })
        .slice(0, 5);
}

function formatHospitalResults(hospitals, location, insuranceName) {
    if (!hospitals.length) {
        const fallback = `https://www.google.com/maps/search/hospitals+near+${encodeURIComponent(location)}`;
        return (
            `⚠️ No providers found within 15 miles of *${location}*.\n\n` +
            `Try searching directly:\n<${fallback}|🗺️ Hospitals near ${location} — Google Maps>`
        );
    }

    const typeEmoji = { hospital: '🏥', clinic: '🏨', urgent_care: '🚑', dentist: '🦷' };

    let reply = `🏥 *Healthcare Providers near ${location}*\n`;
    reply += insuranceName
        ? `_Showing nearest results — call ahead to verify *${insuranceName}* is accepted_\n\n`
        : '\n';

    hospitals.forEach((h, i) => {
        const icon = typeEmoji[h.type] || '🏥';
        const q    = encodeURIComponent(`${h.name} ${h.addr || location}`);
        const mapUrl = (h.lat && h.lng)
            ? `https://www.google.com/maps/search/?api=1&query=${q}`
            : `https://www.google.com/maps/search/${q}`;
        reply += `${NUM_EMOJIS[i] || `${i + 1}.`} ${icon} *${h.name}*\n`;
        if (h.addr) reply += `   📍 ${h.addr}\n`;
        reply += `   <${mapUrl}|View on Google Maps>\n\n`;
    });

    if (insuranceName) {
        reply += `_⚠️ Always confirm *${insuranceName}* in-network status before your visit._`;
    }
    return reply;
}

async function handleProviderSearch(userId, text, profile) {
    // Prefer an explicitly named city/location in the query ("hospitals in Salt Lake City")
    // over the stored profile location.  Falls back to profile.location for "near me" queries.
    const explicitLoc   = extractLocationFromText(text);
    const location      = explicitLoc || profile.location;
    const insuranceName = profile.insuranceName || '';
    const wantsDentist  = /dentist|dental/i.test(text);
    const radiusMeters  = 15000; // ~9 miles

    if (!location) {
        // Neither explicit city in query nor profile location — ask
        state[`${userId}_profileStep`] = 'location';
        state[`${userId}_queued`]      = text;
        saveState(state);
        return (
            `📍 To find nearby providers I need your location.\n\n` +
            `*What city and state are you in?*\n` +
            `_(e.g. "Phoenix, AZ" — or type "skip" for a Google Maps link)_`
        );
    }

    if (explicitLoc) {
        console.log(`[hospital-search] using explicit location "${explicitLoc}" (profile: "${profile.location || 'none'}")`);
    }

    try {
        const hospitals = await searchNearbyHospitals(location, radiusMeters, wantsDentist ? 'dentist' : null);
        return formatHospitalResults(hospitals, location, insuranceName);
    } catch (err) {
        console.error('[hospital-search]', err.message);
        const fallback = `https://www.google.com/maps/search/hospitals+near+${encodeURIComponent(location)}`;
        return (
            `⚠️ Couldn't fetch live results right now (${err.message}).\n\n` +
            `Search directly: <${fallback}|🗺️ Hospitals near ${location} — Google Maps>`
        );
    }
}

// ── Benefits card ─────────────────────────────────────────────────────────────

function formatBenefitsCard(profile) {
    let msg = `📋 *${profile.insuranceName || 'Your Insurance'} — Coverage Summary*\n\n`;

    if (profile.patientName)    msg += `*Policyholder:* ${profile.patientName}\n`;
    if (profile.insuranceNumber) msg += `*Member ID:* ${profile.insuranceNumber}\n`;
    if (profile.patientName || profile.insuranceNumber) msg += '\n';

    msg += `*In-Network Benefits*\n`;
    if (profile.deductible      != null) msg += `> 💰 Deductible: *${fmt$(profile.deductible)}/yr*\n`;
    if (profile.copayPrimary    != null) msg += `> 🏥 Primary Care Visit: *${fmt$(profile.copayPrimary)} copay*\n`;
    if (profile.copaySpecialist != null) msg += `> 🩺 Specialist Visit: *${fmt$(profile.copaySpecialist)} copay*\n`;
    if (profile.copayER         != null) msg += `> 🚨 Emergency Room: *${fmt$(profile.copayER)} copay*\n`;
    if (profile.coinsurance)             msg += `> 📊 Coinsurance: *${profile.coinsurance}*\n`;
    if (profile.outOfPocketMax  != null) msg += `> 🛑 Out-of-Pocket Max: *${fmt$(profile.outOfPocketMax)}/yr*\n`;

    msg += `\n_Ask me about specific procedures, referrals, or prescription coverage._`;
    return msg;
}

async function handleBenefitsCard(userId, policyId) {
    const profile = getProfile(userId);
    const hasNumbers = profile.deductible != null || profile.copayPrimary != null || profile.outOfPocketMax != null;
    if (hasNumbers) return formatBenefitsCard(profile);
    // Fallback: ask RAG
    return await handleRagChat(userId,
        'Give me a structured summary of my deductible, copay amounts (primary care, specialist, ER), ' +
        'coinsurance rate, and annual out-of-pocket maximum. Format as a clean bullet list.'
    );
}

// ── Health profile (beliefs world state) ─────────────────────────────────────

async function handleHealthProfile(userId) {
    const profile  = getProfile(userId);
    const lastBill = state[`${userId}_lastBill`] || null;

    let msg = `🧬 *Your HEAL Health Profile*\n\n`;

    // Personal details
    if (profile.patientName || profile.insuranceName) {
        msg += `*You*\n`;
        if (profile.patientName)     msg += `> Name: ${profile.patientName}\n`;
        if (profile.location)        msg += `> Location: ${profile.location}\n`;
        if (profile.university)      msg += `> University: ${profile.university}\n`;
        if (profile.conditions)      msg += `> Conditions: ${profile.conditions}\n`;
        msg += '\n';
    }

    // Insurance
    if (profile.insuranceName) {
        msg += `*Insurance*\n`;
        msg += `> Carrier: ${profile.insuranceName}\n`;
        if (profile.insuranceNumber) msg += `> Member ID: ${profile.insuranceNumber}\n`;
        if (profile.deductible     != null) msg += `> Deductible: ${fmt$(profile.deductible)}/yr\n`;
        if (profile.copayPrimary   != null) msg += `> Primary Care: ${fmt$(profile.copayPrimary)} copay\n`;
        if (profile.outOfPocketMax != null) msg += `> OOP Max: ${fmt$(profile.outOfPocketMax)}/yr\n`;
        msg += '\n';
    }

    // Last bill
    if (lastBill) {
        msg += `*Last Bill Analysis*\n`;
        if (lastBill.totalOvercharge > 0) {
            msg += `> 🚨 Overcharge: ${fmt$(lastBill.totalOvercharge)}\n`;
            msg += `> Correct amount owed: ${fmt$(lastBill.correctOwed)}\n`;
        } else {
            msg += `> ✅ No billing errors found\n`;
        }
        msg += '\n';
    }

    // Beliefs world state
    const b = mkB(userId);
    if (b) {
        try {
            const worldState = await b.read();
            const beliefs = worldState?.beliefs ?? worldState?.state?.beliefs ?? [];
            const active = beliefs
                .filter(bel => !['retracted', 'removed', 'invalidated'].includes(bel.lifecycle))
                .filter(bel => (bel.confidence ?? 0) >= 0.8)
                .slice(0, 6);
            if (active.length) {
                msg += `*🧠 What HEAL Knows* _(Thinkn Belief Graph)_\n`;
                active.forEach(bel => { msg += `> ${bel.text}\n`; });
                msg += '\n';
            }
        } catch (e) { console.warn('[beliefs.read]', e.message); }
    }

    msg += `_Powered by HEAL AI + Thinkn Beliefs SDK_`;
    return msg;
}

// ── Dispute probability score ─────────────────────────────────────────────────

function calcDisputeScore(fin, discrepancy) {
    let score = 50;

    // Number of distinct discrepancies
    const text = String(discrepancy || '');
    const numItems = Math.max(1, (text.match(/\b\d+\./g) || []).length);
    if (numItems >= 3) score += 25;
    else if (numItems >= 2) score += 15;
    else score += 5;

    // Missing network discount — most winnable dispute
    if (!fin?.amount_saved || fin.amount_saved === 0) score += 15;

    // Insurance payment not applied
    if (!fin?.insurance_payment || fin.insurance_payment === 0) score += 12;

    // Overcharge magnitude
    const overcharge = fin?.total_overcharge ?? 0;
    if (overcharge > 200) score += 8;
    else if (overcharge > 50) score += 4;

    return Math.min(95, Math.max(42, score));
}

async function handleRagChat(userId, text) {
    const policyId   = await resolvePolicyId(userId);
    const profile    = getProfile(userId);
    const lastBill   = state[`${userId}_lastBill`] || {};
    const userCtx    = buildUserContext(profile, lastBill);

    // Helper: send a message on a known sessionId
    async function sendMessage(sid) {
        return api.post(`/chat/sessions/${sid}/messages`, {
            message:      text,
            user_context: userCtx,
        });
    }

    // Create a session if we don't have one.
    // Sessions are in-memory only — NOT persisted to bot-state.json.
    // They recreate lazily on restart. The stale-session retry below handles
    // the case where the backend restarted and its session table was cleared.
    async function newSession() {
        const { data } = await api.post('/chat/sessions', { document_ids: [policyId] });
        const sid = data.session_id;
        state[`${userId}_session`] = sid;
        // Do NOT call saveState() here — sessions are transient
        return sid;
    }

    let sessionId = state[`${userId}_session`];
    if (!sessionId) sessionId = await newSession();

    let response;
    try {
        response = await sendMessage(sessionId);
    } catch (err) {
        // Stale session (backend restarted, SQLite lost it) — create a new one and retry
        if (err.response?.status >= 400 && err.response?.status < 500) {
            console.log(`[rag] stale session ${sessionId} (${err.response.status}), creating new session`);
            sessionId = await newSession();
            response  = await sendMessage(sessionId);
        } else {
            throw err;
        }
    }

    const rawReply = response.data.message || response.data.response || JSON.stringify(response.data);
    bgB(userId, b => b.after(rawReply, { source: 'heal_chat' }));
    return `🧠 *HEAL:*\n\n${rawReply}`;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Properly closes the WebSocket so Slack immediately drops the connection.
// Without this, force-killed processes leave zombie connections that cause
// Slack to round-robin events to dead sockets, creating reply delays.

async function shutdown(signal) {
    console.log(`\n${signal} received — closing Slack socket...`);
    try { await app.stop(); } catch { /* ignore */ }
    console.log('Socket closed. Goodbye.');
    process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Start ─────────────────────────────────────────────────────────────────────

(async () => {
    try {
        await app.start();
        console.log('⚡️ HEAL bot running');
        const { data } = await api.get('/health');
        console.log(`✅ backend ok — model=${data.model_status} db=${data.database_status}`);
    } catch (err) {
        console.error('❌ startup failed:', err.message);
        process.exit(1);
    }
})();
