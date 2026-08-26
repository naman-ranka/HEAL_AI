import dotenv from 'dotenv';
dotenv.config();
import pkg from '@slack/bolt';
const { App, LogLevel } = pkg;

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.DEBUG,
});

app.message(async ({ message, say, client }) => {
    console.log('\n===== INCOMING EVENT =====');
    console.log('user:', message.user);
    console.log('channel:', message.channel);
    console.log('channel_type:', message.channel_type);
    console.log('text:', message.text);
    console.log('ts:', message.ts);
    console.log('thread_ts:', message.thread_ts);
    console.log('subtype:', message.subtype);
    console.log('bot_id:', message.bot_id);
    console.log('==========================\n');

    if (message.subtype || message.bot_id || !message.user) {
        console.log('>>> IGNORED (bot/subtype)');
        return;
    }

    console.log('>>> Attempting client.chat.postMessage...');
    try {
        const result = await client.chat.postMessage({
            channel: message.channel,
            text: 'DIAG REPLY: I got your message: ' + message.text,
        });
        console.log('>>> postMessage SUCCESS:', JSON.stringify(result, null, 2));
    } catch (err) {
        console.error('>>> postMessage FAILED:', err);
    }

    console.log('>>> Attempting say()...');
    try {
        const result2 = await say('DIAG SAY: I got your message: ' + message.text);
        console.log('>>> say() SUCCESS:', JSON.stringify(result2, null, 2));
    } catch (err) {
        console.error('>>> say() FAILED:', err);
    }
});

(async () => {
    await app.start();
    console.log('\n⚡️ DIAGNOSTIC BOT RUNNING — send any message\n');
})();
