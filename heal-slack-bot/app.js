import dotenv from 'dotenv';
dotenv.config();

import pkg from '@slack/bolt';
const { App } = pkg;
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import FormData from 'form-data';
import Beliefs from 'beliefs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fallback state for when the Thinkn SDK is in beta-access strict mode
const fallbackBeliefsState = {}; // maps slackUserId -> policyId, slackUserId_chat_session -> sessionId

// Per-user Beliefs factory — each user gets their own scoped belief graph via thread
function getBeliefsForUser(userId) {
    return new Beliefs({
        apiKey: process.env.BELIEFS_KEY || "SVHACK",
        thread: userId,
    });
}

// Store structured policy beliefs after a successful policy upload
async function storePolicyBeliefs(userId, documentId, analysisData) {
    const b = getBeliefsForUser(userId);
    try {
        const items = [
            {
                text: `Active policy_id is ${documentId}`,
                confidence: 0.99,
                type: 'claim',
                source: 'slack_upload',
            },
        ];

        // Extract key coverage details from HEAL's PolicyAnalysisOutput
        const inNet = analysisData?.coverageCosts?.inNetwork;
        if (inNet?.deductible?.individual !== undefined) {
            items.push({
                text: `Individual in-network deductible is $${inNet.deductible.individual}`,
                confidence: 0.95,
                type: 'evidence',
                source: 'heal_policy_analysis',
            });
        }
        if (inNet?.outOfPocketMax?.individual !== undefined) {
            items.push({
                text: `Individual in-network out-of-pocket maximum is $${inNet.outOfPocketMax.individual}`,
                confidence: 0.95,
                type: 'evidence',
                source: 'heal_policy_analysis',
            });
        }
        if (inNet?.coinsurance) {
            items.push({
                text: `In-network coinsurance is ${inNet.coinsurance}`,
                confidence: 0.95,
                type: 'evidence',
                source: 'heal_policy_analysis',
            });
        }
        if (inNet?.copay?.primaryCare) {
            items.push({
                text: `Primary care copay is $${inNet.copay.primaryCare}`,
                confidence: 0.95,
                type: 'evidence',
                source: 'heal_policy_analysis',
            });
        }

        const delta = await b.add(items);
        console.log(`[THINKN] Stored ${items.length} policy beliefs. Clarity: ${delta.clarity?.toFixed(2)}, Readiness: ${delta.readiness}`);
        return delta;
    } catch (err) {
        if (err.code === 'BETA_ACCESS_REQUIRED') {
            console.log(`[THINKN] Beta access required — falling back to local state.`);
        } else {
            console.log(`[THINKN] beliefs.add failed: ${err.message}`);
        }
        return null;
    }
}

// Retrieve policy ID from the user's belief graph
async function getPolicyIdFromBeliefs(userId) {
    const b = getBeliefsForUser(userId);
    try {
        const results = await b.search('active policy_id');
        if (results && results.length > 0) {
            const active = results
                .filter(bl => bl.lifecycle !== 'retracted' && bl.lifecycle !== 'removed' && bl.lifecycle !== 'invalidated')
                .sort((a, bel) => (bel.confidence || 0) - (a.confidence || 0));
            if (active.length > 0) {
                const match = active[0].text.match(/policy_id\s+(?:is\s+)?(\S+)/i);
                if (match) return match[1];
            }
        }
    } catch (err) {
        if (err.code !== 'BETA_ACCESS_REQUIRED') {
            console.log(`[THINKN] beliefs.search failed: ${err.message}`);
        }
    }
    return null;
}

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
});

app.message(async ({ message, say }) => {
    console.log(`[SLACK INCOMING] Received message from ${message.user} in ${message.channel}`);

    if (message.bot_id) return; // ignore bot messages

    const msgText = (message.text || "").toLowerCase();

    // ── TEXT-ONLY FLOW ──────────────────────────────────────────────────────────
    if (!message.files || message.files.length === 0) {
        if (msgText.match(/(hi|hello|help)/i)) {
            await say("👋 *Hi! I'm the HEAL Silent Advocate.*\nI am stateful. First, upload your *Insurance Policy* (include the word 'policy' in your message). Then ask me questions about your coverage or upload *Medical Bills* for me to analyze!\n\n_What would you like to do?_");
            return;
        }

        // Conversational question — look up policy from beliefs first
        let targetPolicyId = fallbackBeliefsState[message.user];

        try {
            const b = getBeliefsForUser(message.user);
            const ctx = await b.before(message.text);
            console.log(`[THINKN] Chat context — clarity: ${ctx.clarity?.toFixed(2)}, beliefs: ${ctx.beliefs.length}`);

            // Try to find policy_id in the user's belief graph
            const policyBelief = ctx.beliefs.find(
                bl => bl.type === 'claim' &&
                      bl.lifecycle !== 'retracted' &&
                      bl.text.includes('policy_id')
            );
            if (policyBelief) {
                const match = policyBelief.text.match(/policy_id\s+(?:is\s+)?(\S+)/i);
                if (match) targetPolicyId = match[1];
            }
        } catch (err) {
            if (err.code !== 'BETA_ACCESS_REQUIRED') {
                console.log(`[THINKN] beliefs.before failed: ${err.message}`);
            }
        }

        if (!targetPolicyId) {
            await say("⚠️ *No active insurance policy on file.* Please upload your insurance document first and include the word 'policy' in your message.");
            return;
        }

        await say("💬 *Checking your policy details...*");
        try {
            const backendUrl = process.env.HEAL_BACKEND_URL || "http://localhost:8000";
            let sessionId = fallbackBeliefsState[`${message.user}_chat_session`];

            if (!sessionId) {
                const sessionRes = await axios.post(`${backendUrl}/chat/sessions`, {
                    document_ids: [targetPolicyId],
                });
                sessionId = sessionRes.data.session_id;
                fallbackBeliefsState[`${message.user}_chat_session`] = sessionId;
                console.log(`[HEAL API] Created chat session: ${sessionId}`);
            }

            const chatRes = await axios.post(`${backendUrl}/chat/sessions/${sessionId}/messages`, {
                message: message.text,
            });

            const aiReply = chatRes.data.message || chatRes.data.response || JSON.stringify(chatRes.data);

            // Feed the AI's answer back into beliefs to extract any new coverage facts
            try {
                const b = getBeliefsForUser(message.user);
                const delta = await b.after(aiReply, { source: 'heal_rag_chat' });
                console.log(`[THINKN] Chat after() — readiness: ${delta.readiness}, clarity: ${delta.clarity?.toFixed(2)}`);
            } catch (err) { /* non-fatal */ }

            await say(`🧠 *HEAL Assistant says:*\n\n${aiReply}`);
        } catch (err) {
            console.error(err);
            await say(`❌ *Error connecting to chat engine:*\n${err.message}`);
        }
        return;
    }

    // ── FILE UPLOAD FLOW ────────────────────────────────────────────────────────
    const file = message.files[0];
    const isPolicy = msgText.includes("policy") || msgText.includes("insurance");

    await say(isPolicy
        ? "🔍 *Processing your Insurance Policy...* I'll digest this and update my Beliefs about your coverage."
        : "💸 *Received your Medical Bill!* Fetching your policy from my Beliefs and cross-referencing for errors..."
    );

    try {
        // Download file from Slack
        const download = await axios.get(file.url_private_download, {
            headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
            responseType: 'arraybuffer',
        });
        const tmpFilePath = path.join(__dirname, 'tmp_' + file.name);
        fs.writeFileSync(tmpFilePath, download.data);

        const backendUrl = process.env.HEAL_BACKEND_URL || "http://localhost:8000";

        if (isPolicy) {
            // ── POLICY UPLOAD ──
            const formData = new FormData();
            formData.append('file', fs.createReadStream(tmpFilePath));
            const uploadRes = await axios.post(`${backendUrl}/upload`, formData, {
                headers: { ...formData.getHeaders() },
            });
            fs.unlinkSync(tmpFilePath);

            // Get the document ID (most recent) from /documents
            let documentId = "latest";
            try {
                const docsRes = await axios.get(`${backendUrl}/documents`);
                if (docsRes.data?.documents?.length > 0) {
                    const sorted = docsRes.data.documents.sort(
                        (a, b) => new Date(b.upload_timestamp) - new Date(a.upload_timestamp)
                    );
                    documentId = sorted[0].id;
                }
            } catch (e) {
                console.log("[HEAL API] Could not fetch document list, using 'latest'");
            }

            // Always store in fallback state
            fallbackBeliefsState[message.user] = documentId;
            // Reset chat session so next conversation uses the new policy
            delete fallbackBeliefsState[`${message.user}_chat_session`];

            // Store structured beliefs (policy_id + coverage details from analysis)
            const delta = await storePolicyBeliefs(message.user, documentId, uploadRes.data);
            const clarityNote = delta ? ` Belief clarity: *${(delta.clarity * 100).toFixed(0)}%*` : '';

            await say(
                `✅ *Policy memorized!* Document ID \`${documentId}\`.${clarityNote}\n` +
                `You can now send me a medical bill to check it against your policy, or ask me questions about your coverage.`
            );

        } else {
            // ── BILL UPLOAD ──
            const formData = new FormData();
            formData.append('file', fs.createReadStream(tmpFilePath));
            const uploadRes = await axios.post(`${backendUrl}/bill-checker/upload`, formData, {
                headers: { ...formData.getHeaders() },
            });
            const billId = uploadRes.data.bill_id;
            fs.unlinkSync(tmpFilePath);

            // Resolve policy_id: try beliefs first, fall back to local state
            let targetPolicyId = fallbackBeliefsState[message.user];
            try {
                const b = getBeliefsForUser(message.user);
                const ctx = await b.before("What is my active insurance policy and current deductible status?");
                console.log(`[THINKN] Bill context — clarity: ${ctx.clarity?.toFixed(2)}, beliefs: ${ctx.beliefs.length}`);

                const policyFromBeliefs = await getPolicyIdFromBeliefs(message.user);
                if (policyFromBeliefs) {
                    targetPolicyId = policyFromBeliefs;
                    console.log(`[THINKN] Resolved policy_id from beliefs: ${targetPolicyId}`);
                }
            } catch (err) {
                if (err.code !== 'BETA_ACCESS_REQUIRED') {
                    console.log(`[THINKN] beliefs.before failed: ${err.message}`);
                }
            }

            if (!targetPolicyId) {
                await say("⚠️ *No active insurance policy on file.* Please upload your insurance document first and include the word 'policy' in your message.");
                return;
            }

            // Analyze bill against policy
            const analyzeRes = await axios.post(`${backendUrl}/bill-checker/analyze`, {
                bill_id: billId,
                policy_id: targetPolicyId,
            });
            const aiData = analyzeRes.data;

            // Record the bill analysis outcome in beliefs
            let billDelta = null;
            try {
                const b = getBeliefsForUser(message.user);
                const patientOwes = aiData?.financial_breakdown?.patient_responsibility;
                const hasDiscrepancy = aiData?.discrepancy_check && aiData.discrepancy_check !== "No discrepancies found.";

                billDelta = await b.after(
                    `Bill analysis complete. Patient responsibility: $${patientOwes}. ` +
                    (hasDiscrepancy
                        ? `Discrepancy found: ${aiData.discrepancy_check?.substring(0, 120)}`
                        : 'No discrepancies found.'),
                    { source: 'heal_bill_analysis' }
                );
                console.log(`[THINKN] Bill recorded — readiness: ${billDelta.readiness}, clarity: ${billDelta.clarity?.toFixed(2)}`);

                // Flag discrepancy as a risk belief
                if (hasDiscrepancy) {
                    await b.add(
                        `Potential billing discrepancy: ${aiData.discrepancy_check.substring(0, 120)}`,
                        { type: 'risk', confidence: 0.9, source: 'heal_bill_analysis' }
                    );
                }
            } catch (err) { /* non-fatal */ }

            // Format Slack response
            let responseText = `✅ *HEAL Financial Breakdown (against your Policy)*\n\n`;
            if (aiData.financial_breakdown) {
                responseText += `*Total Billed*: $${aiData.financial_breakdown.total_charges}\n`;
                responseText += `*Insurance Pays*: $${aiData.financial_breakdown.insurance_payment}\n`;
                responseText += `*You Owe*: $${aiData.financial_breakdown.patient_responsibility}\n\n`;
            }
            if (aiData.discrepancy_check && aiData.discrepancy_check !== "No discrepancies found.") {
                responseText += `🚨 *Discrepancy Found*: ${aiData.discrepancy_check}\n\n`;
            } else {
                responseText += `✅ *No discrepancies found against your policy.*\n\n`;
            }
            const readinessNote = billDelta?.readiness ? ` | Belief readiness: ${billDelta.readiness}` : '';
            responseText += `_Analysis powered by HEAL AI & Thinkn Belief tracking${readinessNote}_`;

            console.log(`[SLACK OUTGOING] Sending bill analysis response`);
            await say(responseText);
        }

    } catch (err) {
        console.error(err);
        const tmpFilePath = path.join(__dirname, 'tmp_' + file.name);
        if (fs.existsSync(tmpFilePath)) fs.unlinkSync(tmpFilePath);
        await say(`❌ *Sorry, an error occurred:*\n${err.message}`);
    }
});

(async () => {
    try {
        await app.start();
        console.log('⚡️ HEAL Silent Advocate is running!');
    } catch (error) {
        console.error("Failed to start bot:", error.message);
    }
})();
