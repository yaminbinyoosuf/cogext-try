import { randomUUID } from 'node:crypto';
/* Point this at a local or self-hosted API while testing:
   COGEXT_API_BASE=http://127.0.0.1:8000/api/v1 */
const DEFAULT_API_BASE = 'https://api.cogextai.com/api/v1';
/* The backend issues a publish token exactly once, in the response to
   POST /live/session, and requires it on every /live/event and /live/publish.
   The token lives only inside the client closure below: it is never printed,
   never put in a URL or an event, and never written to disk. There is no
   token-less fallback; if no valid token arrives, nothing is sent. */
const REQUEST_TIMEOUT_MS = 5_000;
// Total POST /live/session attempts per process, across the same session id.
const MAX_CREATE_ATTEMPTS = 4;
// Total POST /live/publish attempts per process.
const MAX_PUBLISH_ATTEMPTS = 3;
// Responses that mean "this will not start working by retrying".
const PERMANENT = new Set([401, 403, 404, 410]);
/* 122 random bits from the OS CSPRNG, so ids cannot be guessed or enumerated.
   Unguessable is not the same as authorised: writes are still gated by the
   publish token, and the id alone must never grant anything. */
function randomSessionId() {
    return randomUUID();
}
function isValidToken(value) {
    // token_urlsafe(32) is 43 characters. Accept any printable, space-free
    // string of plausible length; anything else is treated as no token.
    return typeof value === 'string' && /^[\x21-\x7e]{16,512}$/.test(value);
}
function isUncertain(status) {
    return status === 429 || status >= 500;
}
export function createLiveClient(opts) {
    const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
    const log = opts.log ?? ((line) => { process.stderr.write('[cogext-try] ' + line + '\n'); });
    const newSessionId = opts.newSessionId ?? randomSessionId;
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    let sessionId = newSessionId();
    let token;
    let state = 'new';
    let createAttempts = 0;
    let creating;
    let catchAccepted = false;
    let publishState = 'idle';
    let publishAttempts = 0;
    let publishing;
    const warned = new Set();
    function logOnce(key, line) {
        if (warned.has(key))
            return;
        warned.add(key);
        log(line);
    }
    function disable(line) {
        state = 'disabled';
        token = undefined;
        log(line + ' Live streaming is off for the rest of this run; tool calls and local catch frames still work.');
    }
    /* Undefined means the outcome is unknown: network error, timeout or abort.
       The request may or may not have reached the server. */
    async function post(path, body) {
        try {
            return await doFetch(opts.apiBase + path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs)
            });
        }
        catch {
            return undefined;
        }
    }
    function describe(res) {
        return res ? 'HTTP ' + res.status : 'network error or timeout';
    }
    function markPending(res) {
        state = 'pending';
        if (createAttempts >= MAX_CREATE_ATTEMPTS) {
            disable('Could not create live session ' + sessionId + ' after ' + createAttempts +
                ' attempts (last: ' + describe(res) + ').');
            return;
        }
        logOnce('create-pending', 'Could not confirm live session ' + sessionId + ' (' + describe(res) +
            '). Retrying with the same session id on the next tool call.');
    }
    async function attemptCreate(allowRotate) {
        createAttempts++;
        const firstAttemptForId = state === 'new';
        const res = await post('/live/session', { session_id: sessionId });
        if (!res || isUncertain(res.status)) {
            // The row may exist server-side. Only the same id may be retried: a new
            // id could leave a second, orphaned session behind.
            markPending(res);
            return;
        }
        if (res.status === 200) {
            let body;
            try {
                body = await res.json();
            }
            catch (err) {
                if (err instanceof SyntaxError) {
                    disable('The COGEXT API answered POST /live/session with a body that is not JSON. Check COGEXT_API_BASE.');
                }
                else {
                    // The body was cut off in transit; the session was probably created.
                    markPending(undefined);
                }
                return;
            }
            const issued = body?.publish_token;
            if (!isValidToken(issued)) {
                disable('The COGEXT API created session ' + sessionId + ' but did not return a valid publish token. ' +
                    'It is probably older than this version of cogext-try requires. Point COGEXT_API_BASE at an ' +
                    'up-to-date API, or set COGEXT_TRY_LOCAL=1 to run without streaming.');
                return;
            }
            token = issued;
            state = 'ready';
            return;
        }
        if (res.status === 409) {
            if (allowRotate && firstAttemptForId) {
                // Our very first request for this id was refused, so the row belongs
                // to someone else and nothing of ours exists under it. The id has not
                // been shown yet, so a fresh one orphans nothing.
                sessionId = newSessionId();
                return attemptCreate(false);
            }
            disable('Live session ' + sessionId + ' already exists, but this process holds no token for it ' +
                '(an earlier create may have succeeded without its response arriving). Restart cogext-try to start a new session.');
            return;
        }
        if (PERMANENT.has(res.status)) {
            disable('The COGEXT API refused to create a live session (HTTP ' + res.status + '). Check COGEXT_API_BASE.');
            return;
        }
        disable('Creating live session failed with HTTP ' + res.status + '.');
    }
    function ensureSession(allowRotate) {
        if (opts.local || state === 'ready' || state === 'disabled')
            return Promise.resolve();
        // Single flight: concurrent callers share one POST /live/session.
        if (!creating) {
            creating = attemptCreate(allowRotate).finally(() => { creating = undefined; });
        }
        return creating;
    }
    async function logEvent(event, options = {}) {
        if (opts.local)
            return;
        if (state !== 'ready')
            await ensureSession(false);
        const id = sessionId;
        const held = token;
        if (state !== 'ready' || held === undefined)
            return;
        const res = await post('/live/event', { session_id: id, event, publish_token: held });
        if (!res || isUncertain(res.status)) {
            // It may have been appended. Appends are not idempotent, so the event
            // is not resent; the session and its token are kept.
            logOnce('event-uncertain', 'An event could not be confirmed (' + describe(res) +
                '). It is not resent, to avoid duplicating it.');
            return;
        }
        if (res.status === 200) {
            if (options.catch)
                catchAccepted = true;
            return;
        }
        if (PERMANENT.has(res.status)) {
            if (state === 'ready') {
                disable('The COGEXT API rejected events for session ' + id + ' (HTTP ' + res.status + '). Restart cogext-try to start a new session.');
            }
            return;
        }
        logOnce('event-' + res.status, 'An event was rejected with HTTP ' + res.status + ' and dropped.');
    }
    async function attemptPublish() {
        publishAttempts++;
        const id = sessionId;
        const res = await post('/live/publish', { session_id: id, publish_token: token });
        if (!res || isUncertain(res.status)) {
            // Publishing only sets flags, so repeating it is safe. Not marked done.
            if (publishAttempts >= MAX_PUBLISH_ATTEMPTS) {
                publishState = 'failed';
                log('Could not publish session ' + id + ' after ' + publishAttempts + ' attempts (last: ' + describe(res) + ').');
                return;
            }
            logOnce('publish-uncertain', 'Could not confirm publishing session ' + id + ' (' + describe(res) +
                '). Will retry after the next catch.');
            return;
        }
        if (res.status === 200) {
            publishState = 'done';
            let url = 'https://cogextai.com/square#' + id;
            try {
                const body = await res.json();
                if (typeof body?.url === 'string' && /^https?:\/\//.test(body.url))
                    url = body.url;
            }
            catch { }
            log('Published session ' + id + ' to the Square: ' + url);
            return;
        }
        publishState = 'failed';
        if (PERMANENT.has(res.status)) {
            disable('The COGEXT API rejected publishing session ' + id + ' (HTTP ' + res.status + ').');
            return;
        }
        log('Publishing session ' + id + ' failed with HTTP ' + res.status + '. Not retrying.');
    }
    /* Publishes once, and only if COGEXT_TRY_PUBLISH=1 and the backend has
       accepted at least one catch event for this session. */
    function publishIfEnabled() {
        if (!opts.publish || opts.local)
            return Promise.resolve();
        if (publishState !== 'idle' || !catchAccepted || state !== 'ready' || token === undefined)
            return Promise.resolve();
        if (!publishing) {
            publishing = attemptPublish().finally(() => { publishing = undefined; });
        }
        return publishing;
    }
    return {
        getSessionId: () => sessionId,
        getLiveUrl: () => 'https://cogextai.com/live/' + sessionId,
        /* Called once at startup, before the session id is shown. */
        createSession: () => ensureSession(true),
        logEvent,
        publishIfEnabled,
        isStreaming: () => !opts.local && state !== 'disabled',
        isPublishEnabled: () => opts.publish && !opts.local
    };
}
const client = createLiveClient({
    apiBase: process.env.COGEXT_API_BASE || DEFAULT_API_BASE,
    local: process.env.COGEXT_TRY_LOCAL === '1',
    publish: process.env.COGEXT_TRY_PUBLISH === '1'
});
export function getSessionId() { return client.getSessionId(); }
export function getLiveUrl() { return client.getLiveUrl(); }
export function createSession() { return client.createSession(); }
export function logEvent(event, options) {
    return client.logEvent(event, options);
}
export function publishIfEnabled() { return client.publishIfEnabled(); }
export function isStreaming() { return client.isStreaming(); }
export function isPublishEnabled() { return client.isPublishEnabled(); }
