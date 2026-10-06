/* Point this at a local or self-hosted API while testing:
   COGEXT_API_BASE=http://127.0.0.1:8000/api/v1 */
const API_BASE = process.env.COGEXT_API_BASE || 'https://api.cogextai.com/api/v1';
const SESSION_ID = Math.random().toString(36).slice(2, 8);
const LOCAL_ONLY = process.env.COGEXT_TRY_LOCAL === '1';
export function getSessionId() { return SESSION_ID; }
export function getLiveUrl() { return 'https://cogextai.com/live/' + SESSION_ID; }
export async function createSession() {
    if (LOCAL_ONLY)
        return;
    try {
        await fetch(API_BASE + '/live/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: SESSION_ID })
        });
    }
    catch { }
}
export async function logEvent(event) {
    if (LOCAL_ONLY)
        return;
    try {
        await fetch(API_BASE + '/live/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: SESSION_ID, event })
        });
    }
    catch { }
}
