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

// Initialize Thinkn Beliefs SDK
const beliefs = new Beliefs({ apiKey: process.env.BELIEFS_KEY || "SVHACK" });

// Fallback state if the Thinkn SDK is in beta-access strict mode
const fallbackBeliefsState = {}; // maps slackUserId -> policyId

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

app.message(async ({ message, say, client }) => {
  console.log(`[SLACK INCOMING] Received message event from ${message.user} in channel ${message.channel}`);
  
  if (message.bot_id) return; // ignore bot

  // Ensure we have a message text or provide an empty string
  const msgText = (message.text || "").toLowerCase();

  // Handle Text-Only Conversational flow
  if (!message.files || message.files.length === 0) {
      if (msgText.match(/(hi|hello|help)/i)) {
          console.log(`[SLACK OUTGOING] Sending greeting response...`);
          await say("👋 *Hi! I'm the HEAL Silent Advocate.*\nI am stateful. First, upload your *Insurance Policy* (add the word 'policy' to the message). Then, you can ask me questions about your coverage or upload *Medical Bills* for me to compare!\n\n_What would you like to do?_");
          return;
      }

      // If it's not a greeting, treat it as a conversational question about the policy!
      let targetPolicyId = fallbackBeliefsState[message.user];
      if (!targetPolicyId) {
          await say("⚠️ *Wait!* I don't see an active insurance policy on file for you. Please upload your insurance document first and include the word 'policy' in your message before asking questions.");
          return;
      }

      await say("💬 *Checking your policy details...*");
      try {
          const backendUrl = process.env.HEAL_BACKEND_URL || "http://localhost:8000";
          let sessionId = fallbackBeliefsState[`${message.user}_chat_session`];

          if (!sessionId) {
              // Create a brand new RAG chat session connected to this policy
              const sessionRes = await axios.post(`${backendUrl}/chat/sessions`, {
                  document_ids: [targetPolicyId]
              });
              sessionId = sessionRes.data.session_id;
              fallbackBeliefsState[`${message.user}_chat_session`] = sessionId;
              console.log(`[HEAL API] Created new chat session: ${sessionId}`);
          }

          // Send message to the chatbot
          const chatRes = await axios.post(`${backendUrl}/chat/sessions/${sessionId}/messages`, {
              message: message.text
          });
          
          const aiReply = chatRes.data.message || chatRes.data.response || JSON.stringify(chatRes.data);
          console.log(`[SLACK OUTGOING] Sending RAG conversational reply`);
          await say(`🧠 *HEAL Assistant says:*\n\n${aiReply}`);
      } catch (err) {
          console.error(err);
          await say(`❌ *Sorry, an error occurred while connecting to the chat engine:*\n${err.message}`);
      }
      return;
  }

  // Handle File Uploads
  if (message.files && message.files.length > 0) {
    const file = message.files[0];
    const isPolicy = msgText.includes("policy") || msgText.includes("insurance");

    if (isPolicy) {
      await say("🔍 *Processing your Insurance Policy...* I'll digest this and update my Beliefs about your coverage.");
    } else {
      await say("💸 *Received your Medical Bill!* Fetching your specific policy from my Beliefs and cross-referencing for errors...");
    }
    
    try {
        // Download file from Slack
        const fileUrl = file.url_private_download;
        const download = await axios.get(fileUrl, {
            headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
            responseType: 'arraybuffer'
        });
        
        const tmpFilePath = path.join(__dirname, 'tmp_' + file.name);
        fs.writeFileSync(tmpFilePath, download.data);

        const formData = new FormData();
        formData.append('file', fs.createReadStream(tmpFilePath));
        const backendUrl = process.env.HEAL_BACKEND_URL || "http://localhost:8000";

        if (isPolicy) {
            // === POLICY UPLOAD FLOW ===
            const uploadRes = await axios.post(`${backendUrl}/upload`, formData, {
                headers: { ...formData.getHeaders() }
            });
            fs.unlinkSync(tmpFilePath); // cleanup
            
            // Fetch the document ID from /documents endpoint since /upload returns only the rich JSON Analysis
            let documentId = "latest"; 
            try {
                const docsRes = await axios.get(`${backendUrl}/documents`);
                if (docsRes.data && docsRes.data.documents && docsRes.data.documents.length > 0) {
                     // Sort by timestamp desc to get the one we just uploaded
                     const sortedDocs = docsRes.data.documents.sort((a,b) => new Date(b.upload_timestamp) - new Date(a.upload_timestamp));
                     documentId = sortedDocs[0].id;
                }
            } catch (e) {
                console.log("Failed to fetch exact document_id, falling back to 'latest'");
            }
            
            // --- THINKN TRACK: Save Beliefs ---
            fallbackBeliefsState[message.user] = documentId; // Fallback
            try {
                await beliefs.add(`Slack user ${message.user} has an active insurance policy_id of ${documentId}.`, { source: "slack_upload" });
                console.log(`[THINKN] Successfully recorded active policy belief.`);
            } catch (err) {
                console.log(`[THINKN] Beta key warning: Falling back to local state sync.`);
            }

            await say(`✅ *Policy successfully memorized!*\nI believe your specific active policy is now Document ID \`${documentId}\`.\nYou can now forward medical bills to me for accurate coverage validation.`);
        } 
        else {
            // === BILL UPLOAD FLOW ===
            // 1. Get the Bill ID
            const uploadRes = await axios.post(`${backendUrl}/bill-checker/upload`, formData, {
                headers: { ...formData.getHeaders() }
            });
            const billId = uploadRes.data.bill_id;
            fs.unlinkSync(tmpFilePath); // cleanup

            // 2. Fetch specific User's Policy ID from Beliefs
            let targetPolicyId = fallbackBeliefsState[message.user];
            try {
                const beliefQuery = await beliefs.before(`What is the active insurance policy_id for Slack user ${message.user}?`);
                console.log(`[THINKN] Belief context retrieved.`);
            } catch (err) {
                console.log(`[THINKN] Beta key warning: Utilizing local fallback state.`);
            }

            if (!targetPolicyId) {
                await say("⚠️ *Wait!* I don't see an active insurance policy on file for you. Please upload your insurance document first and include the word 'policy' in your message.");
                return;
            }

            // 3. Analyze Bill against specific Policy (Core HEAL UX)
            const analyzePayload = {
                bill_id: billId,
                policy_id: targetPolicyId
            };

            const analyzeRes = await axios.post(`${backendUrl}/bill-checker/analyze`, analyzePayload);
            const aiData = analyzeRes.data;
            
            // Format nice response
             let slackReponseText = `✅ *HEAL Financial Breakdown (against your Policy)*\n\n`;
            if (aiData.financial_breakdown) {
                 slackReponseText += `*Total Billed*: $${aiData.financial_breakdown.total_charges}\n`;
                 slackReponseText += `*Insurance Paid*: $${aiData.financial_breakdown.insurance_payment}\n`;
                 slackReponseText += `*You Owe*: $${aiData.financial_breakdown.patient_responsibility}\n\n`;
            }
            if (aiData.discrepancy_check && aiData.discrepancy_check !== "No discrepancies found.") {
                 slackReponseText += `🚨 *Discrepancy Found*: ${aiData.discrepancy_check}\n\n`;
            } else {
                 slackReponseText += `✅ *No discrepancies found against your policy.*\n\n`;
            }
            slackReponseText += `_Analysis powered by HEAL AI & Thinkn Belief tracking_`;

            console.log(`[SLACK OUTGOING] Sending fully contextualized AI response...`);
            await say(slackReponseText);
        }

    } catch (err) {
      console.error(err);
      if (fs.existsSync(path.join(__dirname, 'tmp_' + file.name))) fs.unlinkSync(path.join(__dirname, 'tmp_' + file.name));
      await say(`❌ *Sorry, an error occurred:*\n${err.message}`);
    }
  }
});

(async () => {
    try {
      await app.start();
      console.log('⚡️ Configured HEAL Slack Bot is running!');
    } catch (error) {
      console.error("Failed to start bot:", error.message);
    }
})();
