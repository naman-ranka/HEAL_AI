# HEAL AI Slack Bot Integration 🩺

This directory contains the stateful, headless Slack integration for HEAL AI. It enables a "Zero New Tabs" medical bill checking experience via Slack, utilizing the **Thinkn Beliefs Engine** to persist user memory (like uploaded policy constraints) and the FastAPI RAG backend to validate medical documents.

## Architecture

1. **Slack Socket Mode**: Uses `@slack/bolt` to instantly listen to incoming file uploads and text chats securely behind firewalls, without needing a public endpoint.
2. **State Context via Thinkn**: Links a specific user's Slack ID to their currently active `policy_document_id`.
3. **Conversational RAG**: Connects directly to the HEAL back-end `/chat/sessions` and `/bill-checker` endpoints, seamlessly bridging Slack file uploads and text to the backend APIs.

---

## 🛠️ Step-by-Step Setup Guide

### 1. Create the Slack App
1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**.
2. Choose **From scratch**, name it `HEAL AI Bot`, and select your target workspace.

### 2. Enable Socket Mode
1. In the left sidebar under Settings, navigate to **Socket Mode**.
2. Toggle **Enable Socket Mode** to **On**.
3. A popup will ask you to create an **App-Level Token** (e.g., name it `HealAppToken`).
   - Leave the `connections:write` scope gracefully assigned.
   - Click **Generate**.
   - Copy this token (it starts with `xapp-`). You will place this in your `.env` as `SLACK_APP_TOKEN`.

### 3. Grant OAuth & Permissions
1. Under **Features**, click on **OAuth & Permissions**.
2. Scroll down to **Bot Token Scopes** and add the following required scopes:
   - `app_mentions:read`
   - `channels:history`
   - `chat:write`
   - `files:read`
   - `im:history`
   - `im:read`
   - `im:write`
3. Scroll to the top and click **Install to Workspace** (or Reinstall to Workspace).
4. Copy the **Bot User OAuth Token** (it starts with `xoxb-`). You will place this in your `.env` as `SLACK_BOT_TOKEN`.

### 4. Enable Event Subscriptions
1. Navigate to **Event Subscriptions** in the left sidebar.
2. Toggle **Enable Events** to **On**.
3. (Because you are using Socket Mode, you do not need to provide a Request URL).
4. Under **Subscribe to bot events**, click Add Bot User Event and select:
   - `message.im` (To allow the bot to receive direct messages)
5. Click **Save Changes**.

### 5. Allow Messaging (App Home)
1. Under **Features**, click **App Home**.
2. Scroll down to the **Messages Tab** section.
3. Check the box that says: **"Allow users to send Slash commands and messages from the messages tab"**. This is required so you get a text box when you PM the bot.

### 6. Set up the Environment Variables
Create a `.env` file in the `heal-slack-bot` directory containing:

```env
SLACK_BOT_TOKEN="xoxb-YOUR_BOT_TOKEN"
SLACK_APP_TOKEN="xapp-YOUR_APP_TOKEN"
BELIEFS_KEY="SVHACK"
HEAL_BACKEND_URL="http://localhost:8000"
```

### 7. Run the Bot
```bash
npm install
node app.js
```

Your bot will print `⚡️ Configured HEAL Slack Bot is running!` to the console. You can now DM it inside your configured Slack workspace!
