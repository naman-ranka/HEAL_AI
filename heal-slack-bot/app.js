import dotenv from 'dotenv';
dotenv.config();

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

    console.log(`[msg] user=${userId} text="${text.slice(0,80)}"`);

    try {

        // ── File upload ───────────────────────────────────────────────────────
        if (message.files?.length) {
            const isPolicy = /policy|insurance/i.test(lc);
            if (isPolicy) {
                // Fire-and-forget: post placeholder immediately, update as stages complete
                const msg = await client.chat.postMessage({ channel, text: '📤 _Uploading your policy..._' });
                processPolicyUploadAsync(userId, message.files[0], client, channel, msg.ts)
                    .catch(async err => {
                        console.error('[policy-upload]', err.message);
                        try { await client.chat.update({ channel, ts: msg.ts, text: `❌ *Error:* ${err.message}` }); } catch {}
                    });
            } else {
                // Fire-and-forget: post placeholder immediately, poll backend for result
                const msg = await client.chat.postMessage({ channel, text: '📤 _Uploading your bill..._' });
                processBillUploadAsync(userId, message.files[0], client, channel, msg.ts)
                    .catch(async err => {
                        console.error('[bill-upload]', err.message);
                        try { await client.chat.update({ channel, ts: msg.ts, text: `❌ *Error:* ${err.message}` }); } catch {}
                    });
            }
            return;
        }

        // ── Greeting ──────────────────────────────────────────────────────────
        if (!text || /^(hi|hello|hey|help|start)\b/i.test(lc)) {
            await client.chat.postMessage({
                channel,
                text:
                    "👋 *Hi! I'm HEAL — your AI Healthcare Financial Advocate.*\n\n" +
                    "*What I can do:*\n" +
                    "• 📋 Explain your insurance coverage in plain English\n" +
                    "• 🏥 Find nearby in-network hospitals, urgent care, specialists\n" +
                    "• 🧾 Audit medical bills and catch overcharges\n" +
                    "• 💬 Answer coverage questions (copay, deductible, what's covered)\n\n" +
                    "*Get started:*\n" +
                    "1. Upload your *insurance policy* PDF — include the word *policy* in your message\n" +
                    "2. I'll ask for your location to personalise provider lookups _(optional)_\n" +
                    "3. Ask anything — or upload a medical bill to check it for errors\n\n" +
                    "⚠️ _I don't provide medical diagnoses or treatment advice — for emergencies, call 911._",
            });
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

                // Extract carrier name and store in user profile for contextual chat
                const carrier = job.result?.policyDetails?.carrier;
                if (carrier) {
                    setProfile(userId, { insuranceName: carrier });
                }

                saveState(state);

                bgB(userId, async b => {
                    const items = [
                        { text: `Active policy_id is ${docId}`, confidence: 0.99, type: 'claim', source: 'slack' },
                    ];
                    if (carrier)
                        items.push({ text: `Insurance carrier is ${carrier}`, confidence: 0.95, type: 'evidence', source: 'heal' });
                    const net = job.result?.coverageCosts?.inNetwork;
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

                await client.chat.update({
                    channel, ts,
                    text:
                        `✅ *Policy saved!* _(ID: \`${docId}\`)_\n\n` +
                        `You can now:\n` +
                        `• Ask me questions about your coverage\n` +
                        `• Upload a medical bill to check it for errors`,
                });
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

                bgB(userId, b => b.after(
                    `Bill: patient owes $${fin?.patient_responsibility}. ${hasDiscrepancy ? 'Discrepancy found.' : 'Clean.'}`,
                    { source: 'heal_bill' }
                ));
                if (hasDiscrepancy) {
                    bgB(userId, b => b.add(
                        `Billing discrepancy: ${discrepancy?.substring(0, 120)}`,
                        { type: 'risk', confidence: 0.9, source: 'heal_bill' }
                    ));
                }

                const overcharge = fin?.total_overcharge;
                const correctOwed = fin?.correct_patient_responsibility;

                let reply;
                if (hasDiscrepancy) {
                    const overchargeLabel = overcharge > 0 ? ` — *${fmt$(overcharge)} overcharge detected*` : '';
                    reply = `🚨 *Billing Errors Found!*${overchargeLabel}\n\n`;

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

// Queries that need location context → contextual endpoint
const LOCATION_INTENT = /hospital|clinic|urgent care|er\b|emergency room|doctor|specialist|physician|provider|dentist|pharmacy|near(by)?|close to|in my area|find a|where (can|do|should)|covered (near|in)/i;

// Queries that are clearly asking for medical advice (hard block)
const MEDICAL_ADVICE_INTENT = /should i take|diagnos|prescri|my symptom|do i have|is it (serious|cancer|covid|flu)|what (disease|condition)|treat(ment)? for/i;

async function handleChat(userId, text) {
    const policyId = await resolvePolicyId(userId);
    if (!policyId) {
        return '⚠️ *No insurance policy on file.* Upload your policy first — include the word "policy" in your message.';
    }

    const profile = getProfile(userId);

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
        delete state[`${userId}_profileStep`];
        setProfile(userId, { collected: true });

        // Answer the original queued question now
        const queued = state[`${userId}_queued`];
        delete state[`${userId}_queued`];
        saveState(state);

        const confirmMsg = `✅ *Profile saved!* I'll use your details for personalised answers.\n\n`;
        if (queued) {
            const answer = await routeChat(userId, queued, policyId);
            return confirmMsg + answer;
        }
        return confirmMsg + `Ask me anything about your coverage or finding nearby providers.`;
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

async function routeChat(userId, text, policyId) {
    const profile = getProfile(userId);

    // Hard block: medical advice
    if (MEDICAL_ADVICE_INTENT.test(text)) {
        return (
            `⚠️ *I can't provide medical advice, diagnoses, or treatment recommendations.*\n\n` +
            `If this is an emergency, call *911* immediately.\n\n` +
            `I *can* help you find in-network providers nearby, understand your coverage, ` +
            `or check whether a procedure is covered. What would you like to know?`
        );
    }

    // Location / provider lookup → contextual endpoint
    if (LOCATION_INTENT.test(text) && (profile.location || profile.locationSkipped)) {
        return await handleContextualChat(userId, text, profile, policyId);
    }

    // Fallback to contextual if no RAG session possible but we have a profile
    if (LOCATION_INTENT.test(text)) {
        return await handleContextualChat(userId, text, profile, policyId);
    }

    // Standard RAG for policy/coverage questions
    return await handleRagChat(userId, text);
}

async function handleContextualChat(userId, text, profile, policyId) {
    const { data } = await api.post('/chat/contextual', {
        message:        text,
        location:       profile.location || '',
        conditions:     profile.conditions || '',
        insurance_name: profile.insuranceName || '',
        policy_id:      policyId,
    });
    const rawReply = data.message || data.response || JSON.stringify(data);
    bgB(userId, b => b.after(rawReply, { source: 'heal_contextual' }));
    return `🧠 *HEAL:*\n\n${rawReply}`;
}

async function handleRagChat(userId, text) {
    const policyId = await resolvePolicyId(userId);
    let sessionId = state[`${userId}_session`];
    if (!sessionId) {
        const { data } = await api.post('/chat/sessions', { document_ids: [policyId] });
        sessionId = data.session_id;
        state[`${userId}_session`] = sessionId;
        saveState(state);
    }
    const { data } = await api.post(`/chat/sessions/${sessionId}/messages`, { message: text });
    const rawReply = data.message || data.response || JSON.stringify(data);
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
