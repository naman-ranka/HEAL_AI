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
                await postThenUpdate(client, channel, '🔍 _Reading your insurance policy..._', async () => {
                    return await processPolicyUpload(userId, message.files[0]);
                });
            } else {
                await postThenUpdate(client, channel, '💸 _Analyzing your medical bill..._', async () => {
                    return await processBillUpload(userId, message.files[0]);
                });
            }
            return;
        }

        // ── Greeting ──────────────────────────────────────────────────────────
        if (!text || /^(hi|hello|hey|help|start)\b/i.test(lc)) {
            await client.chat.postMessage({
                channel,
                text:
                    "👋 *Hi! I'm HEAL — your Silent Medical Billing Advocate.*\n\n" +
                    "*How to use me:*\n" +
                    "1. Upload your *insurance policy* PDF — include the word *policy* in your message\n" +
                    "2. Ask me questions about your coverage, or upload a *medical bill* to check it for errors\n\n" +
                    "_Your policy is remembered for the session._",
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

// ── Policy upload ─────────────────────────────────────────────────────────────

async function processPolicyUpload(userId, file) {
    const tmpPath = path.join(__dirname, `tmp_${Date.now()}_${file.name}`);
    try {
        const dl = await axios.get(file.url_private_download, {
            headers: { Authorization: `Bearer ${BOT_TOKEN}` },
            responseType: 'arraybuffer',
            timeout: 30_000,
        });
        fs.writeFileSync(tmpPath, dl.data);

        const form = new FormData();
        form.append('file', fs.createReadStream(tmpPath));
        const { data: uploadData } = await api.post('/upload', form, { headers: form.getHeaders() });

        // Extract document ID — prefer upload response, fall back to /documents query
        let docId = uploadData?.additional_info?.rag_document_id;
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
        saveState(state);

        // Store beliefs in background
        bgB(userId, async b => {
            const items = [
                { text: `Active policy_id is ${docId}`, confidence: 0.99, type: 'claim', source: 'slack' },
            ];
            const net = uploadData?.coverageCosts?.inNetwork;
            if (net?.deductible?.individual != null)
                items.push({ text: `In-network deductible is $${net.deductible.individual}`, confidence: 0.95, type: 'evidence', source: 'heal' });
            if (net?.outOfPocketMax?.individual != null)
                items.push({ text: `Out-of-pocket max is $${net.outOfPocketMax.individual}`, confidence: 0.95, type: 'evidence', source: 'heal' });
            if (net?.coinsurance)
                items.push({ text: `Coinsurance is ${net.coinsurance}`, confidence: 0.95, type: 'evidence', source: 'heal' });
            if (net?.copay?.primaryCare)
                items.push({ text: `Primary care copay is $${net.copay.primaryCare}`, confidence: 0.95, type: 'evidence', source: 'heal' });
            const d = await b.add(items);
            console.log(`[beliefs] stored ${items.length} beliefs, clarity=${d?.clarity?.toFixed(2)}`);
        });

        return (
            `✅ *Policy saved!* _(ID: \`${docId}\`)_\n\n` +
            `You can now:\n` +
            `• Ask me questions about your coverage\n` +
            `• Upload a medical bill to check it for errors`
        );
    } finally {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
}

// ── Bill upload ───────────────────────────────────────────────────────────────

async function processBillUpload(userId, file) {
    const policyId = await resolvePolicyId(userId);
    if (!policyId) {
        return '⚠️ *No insurance policy on file.* Upload your policy first — include the word "policy" in your message.';
    }

    const tmpPath = path.join(__dirname, `tmp_${Date.now()}_${file.name}`);
    try {
        const dl = await axios.get(file.url_private_download, {
            headers: { Authorization: `Bearer ${BOT_TOKEN}` },
            responseType: 'arraybuffer',
            timeout: 30_000,
        });
        fs.writeFileSync(tmpPath, dl.data);

        const form = new FormData();
        form.append('file', fs.createReadStream(tmpPath));
        const { data: { bill_id } } = await api.post('/bill-checker/upload', form, { headers: form.getHeaders() });

        const { data } = await api.post('/bill-checker/analyze', { bill_id, policy_id: policyId });

        const fin = data?.financial_breakdown;
        const discrepancy = data?.discrepancy_check;
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

        let reply = `✅ *HEAL Financial Breakdown*\n\n`;
        if (fin) {
            reply += `*Total Billed:* $${fin.total_charges}\n`;
            reply += `*Insurance Pays:* $${fin.insurance_payment}\n`;
            reply += `*You Owe:* $${fin.patient_responsibility}\n\n`;
        }
        reply += hasDiscrepancy
            ? `🚨 *Discrepancy Found:* ${discrepancy}\n`
            : `✅ No discrepancies found against your policy.\n`;
        reply += `\n_Powered by HEAL AI + Thinkn_`;
        return reply;
    } finally {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
}

// ── Chat ──────────────────────────────────────────────────────────────────────

async function handleChat(userId, text) {
    const policyId = await resolvePolicyId(userId);
    if (!policyId) {
        return '⚠️ *No insurance policy on file.* Upload your policy first — include the word "policy" in your message.';
    }

    let sessionId = state[`${userId}_session`];
    if (!sessionId) {
        const { data } = await api.post('/chat/sessions', { document_ids: [policyId] });
        sessionId = data.session_id;
        state[`${userId}_session`] = sessionId;
        console.log(`[heal] session ${sessionId} for policy ${policyId}`);
    }

    const { data } = await api.post(`/chat/sessions/${sessionId}/messages`, { message: text });
    const rawReply = data.message || data.response || JSON.stringify(data);

    // Pass clean text to beliefs (no Slack formatting noise — judges see this graph)
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
