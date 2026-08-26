import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'bot-state.json');

// Load persisted user state from disk. Returns {} if file is missing or corrupt.
export function loadState() {
    if (!existsSync(STATE_FILE)) return {};
    try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
    catch { return {}; }
}

// Atomically write state to disk. tmp → rename prevents corruption on crash.
// Only policyId is persisted; sessionIds are recreated lazily on restart.
export function saveState(state) {
    try {
        const tmp = STATE_FILE + '.tmp';
        writeFileSync(tmp, JSON.stringify(state, null, 2));
        renameSync(tmp, STATE_FILE);
    } catch (e) { console.warn('[state] save failed:', e.message); }
}
