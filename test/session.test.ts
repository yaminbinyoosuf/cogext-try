import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLiveClient, type LiveClientOptions } from '../src/session.js';

/* Every request goes to an in-process fake fetch. Nothing here reaches a
   network, and no production session is used. */
const BASE = 'http://api.test/api/v1';
const TOKEN = 'tok_' + 'A1b2C3d4'.repeat(5);

type Reply = Response | Error | Promise<Response | Error>;
type Handler = (body: Record<string, unknown>) => Reply;

function json(status: number, body: unknown): Handler {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const created: Handler = (body) => json(200, { session_id: body.session_id, created_at: 'now', publish_token: TOKEN })(body);
const ok: Handler = json(200, { ok: true });
const networkError: Handler = () => new TypeError('fetch failed');
const timeout: Handler = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

interface Call { path: string; url: string; body: Record<string, unknown>; init: RequestInit }

/* script maps a path to one handler, or a queue whose last entry repeats. */
function harness(script: Record<string, Handler | Handler[]>, options: Partial<LiveClientOptions> = {}) {
  const calls: Call[] = [];
  const lines: string[] = [];
  let ids = 0;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(BASE.length);
    const body = JSON.parse(String(init?.body));
    calls.push({ path, url, body, init: init ?? {} });
    const entry = script[path];
    const handler = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]) : entry;
    if (!handler) return new Response('unexpected ' + path, { status: 599 });
    const reply = await handler(body);
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  const client = createLiveClient({
    apiBase: BASE,
    local: false,
    publish: false,
    ...options,
    fetch: fakeFetch,
    log: (line) => lines.push(line),
    newSessionId: () => 'sess' + (++ids)
  });
  return {
    client,
    calls,
    lines,
    paths: () => calls.map((c) => c.path),
    bodies: (path: string) => calls.filter((c) => c.path === path).map((c) => c.body)
  };
}

function assertNoTokenLeak(h: ReturnType<typeof harness>): void {
  assert.ok(!h.lines.join('\n').includes(TOKEN), 'token appeared in log output');
  assert.ok(!h.client.getLiveUrl().includes(TOKEN), 'token appeared in the live URL');
  for (const c of h.calls) {
    assert.ok(!c.url.includes(TOKEN), 'token appeared in a request URL');
    if (c.body.event !== undefined) assert.ok(!JSON.stringify(c.body.event).includes(TOKEN), 'token appeared inside an event');
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// ---------------------------------------------------------------- session ids

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/* A client with the real id generator (no newSessionId override). */
function realIdClient(script: Record<string, Handler | Handler[]>) {
  const calls: Record<string, unknown>[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).slice(BASE.length);
    const body = JSON.parse(String(init?.body));
    calls.push({ path, ...body });
    const entry = script[path];
    const handler = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]) : entry;
    const reply = await handler(body);
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  const client = createLiveClient({ apiBase: BASE, local: false, publish: false, fetch: fakeFetch, log: () => {} });
  return { client, calls };
}

test('default session ids are RFC 4122 v4 UUIDs (122 random bits) and do not repeat', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const id = realIdClient({}).client.getSessionId();
    assert.match(id, UUID_V4);
    ids.add(id);
  }
  assert.equal(ids.size, 2000);
});

test('default session ids do not use Math.random', () => {
  const original = Math.random;
  Math.random = () => { throw new Error('Math.random must not be used for session ids'); };
  try {
    assert.match(realIdClient({}).client.getSessionId(), UUID_V4);
  } finally {
    Math.random = original;
  }
});

test('409 rotation with the real generator moves to a different UUID, and the live URL follows it', async () => {
  const { client, calls } = realIdClient({ '/live/session': [json(409, { detail: 'exists' }), created], '/live/event': ok });
  const first = client.getSessionId();
  await client.createSession();
  const second = client.getSessionId();
  assert.match(second, UUID_V4);
  assert.notEqual(second, first);
  assert.deepEqual(calls.map((c) => c.session_id), [first, second]);
  assert.equal(client.getLiveUrl(), 'https://cogextai.com/live/' + second);
  await client.logEvent({ n: 1 });
  assert.deepEqual(calls.at(-1), { path: '/live/event', session_id: second, event: { n: 1 }, publish_token: TOKEN });
});

test('a lost create response keeps the same UUID on retry', async () => {
  const { client, calls } = realIdClient({ '/live/session': [timeout, created], '/live/event': ok });
  const id = client.getSessionId();
  await client.createSession();
  await client.logEvent({ n: 1 });
  assert.deepEqual(calls.map((c) => c.session_id), [id, id, id]);
});

// ---------------------------------------------------------------- token acquisition

test('createSession stores the token and events carry it in the body', async () => {
  const h = harness({ '/live/session': created, '/live/event': ok });
  await h.client.createSession();
  const event = { kind: 'tool_call', tool: 'send_email' };
  await h.client.logEvent(event);

  assert.deepEqual(h.paths(), ['/live/session', '/live/event']);
  assert.deepEqual(h.bodies('/live/session'), [{ session_id: 'sess1' }]);
  assert.deepEqual(h.bodies('/live/event'), [{ session_id: 'sess1', event, publish_token: TOKEN }]);
  assert.deepEqual(event, { kind: 'tool_call', tool: 'send_email' }, 'caller event was mutated');
  assert.equal(h.client.isStreaming(), true);
  assert.equal(h.client.getLiveUrl(), 'https://cogextai.com/live/sess1');
  assertNoTokenLeak(h);
});

test('every request carries a timeout signal and a JSON body', async () => {
  const h = harness({ '/live/session': created, '/live/event': ok, '/live/publish': ok }, { publish: true });
  await h.client.createSession();
  await h.client.logEvent({ n: 1 }, { catch: true });
  await h.client.publishIfEnabled();
  assert.equal(h.calls.length, 3);
  for (const c of h.calls) {
    assert.ok(c.init.signal instanceof AbortSignal, c.path + ' has no signal');
    assert.equal(c.init.method, 'POST');
    assert.deepEqual(c.init.headers, { 'Content-Type': 'application/json' });
  }
});

test('COGEXT_TRY_LOCAL sends nothing', async () => {
  const h = harness({}, { local: true, publish: true });
  await h.client.createSession();
  await h.client.logEvent({ n: 1 }, { catch: true });
  await h.client.publishIfEnabled();
  assert.equal(h.calls.length, 0);
  assert.equal(h.client.isStreaming(), false);
  assert.equal(h.client.isPublishEnabled(), false);
});

// ---------------------------------------------------------------- older backends: fail closed

for (const [label, reply] of [
  ['no publish_token field (pre-token backend)', { session_id: 'sess1', created_at: 'now' }],
  ['null publish_token', { session_id: 'sess1', publish_token: null }],
  ['empty publish_token', { session_id: 'sess1', publish_token: '' }],
  ['non-string publish_token', { session_id: 'sess1', publish_token: 12345678901234567890 }],
  ['publish_token containing whitespace', { session_id: 'sess1', publish_token: 'abc def ghi jkl mno pqr' }],
  ['JSON null body', null]
] as const) {
  test('fails closed on ' + label + ': no event, no publish, clear message', async () => {
    const h = harness({ '/live/session': json(200, reply), '/live/event': ok, '/live/publish': ok }, { publish: true });
    await h.client.createSession();
    await h.client.logEvent({ n: 1 }, { catch: true });
    await h.client.logEvent({ n: 2 }, { catch: true });
    await h.client.publishIfEnabled();

    assert.deepEqual(h.paths(), ['/live/session'], 'sent something without a token, or retried creation');
    assert.equal(h.client.isStreaming(), false);
    assert.equal(h.lines.length, 1);
    assert.match(h.lines[0], /did not return a valid publish token/);
    assert.match(h.lines[0], /COGEXT_API_BASE/);
  });
}

test('fails closed when the session response is not JSON', async () => {
  const h = harness({ '/live/session': () => new Response('<html>proxy</html>', { status: 200 }), '/live/event': ok });
  await h.client.createSession();
  await h.client.logEvent({ n: 1 });
  assert.deepEqual(h.paths(), ['/live/session']);
  assert.equal(h.client.isStreaming(), false);
  assert.match(h.lines[0], /not JSON/);
});

// ---------------------------------------------------------------- create: permanent failures

for (const status of [401, 403, 404, 410, 400, 422]) {
  test('create HTTP ' + status + ' is permanent: no retry, nothing sent', async () => {
    const h = harness({ '/live/session': json(status, { detail: 'no' }), '/live/event': ok });
    await h.client.createSession();
    await h.client.logEvent({ n: 1 });
    await h.client.logEvent({ n: 2 });
    assert.deepEqual(h.paths(), ['/live/session']);
    assert.equal(h.client.isStreaming(), false);
    assert.match(h.lines[0], new RegExp('HTTP ' + status));
  });
}

// ---------------------------------------------------------------- create: 409 and rotation

test('409 on the first startup attempt rotates to a fresh id once, before the id is shown', async () => {
  const h = harness({ '/live/session': [json(409, { detail: 'session_id already exists' }), created], '/live/event': ok });
  await h.client.createSession();
  await h.client.logEvent({ n: 1 });
  assert.deepEqual(h.bodies('/live/session'), [{ session_id: 'sess1' }, { session_id: 'sess2' }]);
  assert.equal(h.client.getSessionId(), 'sess2');
  assert.equal(h.client.getLiveUrl(), 'https://cogextai.com/live/sess2');
  assert.deepEqual(h.bodies('/live/event'), [{ session_id: 'sess2', event: { n: 1 }, publish_token: TOKEN }]);
});

test('a second 409 after rotation stops: at most one replacement id', async () => {
  const h = harness({ '/live/session': json(409, { detail: 'exists' }), '/live/event': ok });
  await h.client.createSession();
  await h.client.logEvent({ n: 1 });
  assert.deepEqual(h.bodies('/live/session'), [{ session_id: 'sess1' }, { session_id: 'sess2' }]);
  assert.equal(h.client.isStreaming(), false);
  assert.ok(!h.paths().includes('/live/event'));
});

test('409 on a lazy create (no startup call) does not rotate the id', async () => {
  const h = harness({ '/live/session': json(409, { detail: 'exists' }), '/live/event': ok });
  await h.client.logEvent({ n: 1 });
  assert.deepEqual(h.bodies('/live/session'), [{ session_id: 'sess1' }]);
  assert.equal(h.client.getSessionId(), 'sess1');
  assert.equal(h.client.isStreaming(), false);
});

// ---------------------------------------------------------------- create: lost responses

for (const [label, failure] of [['network error', networkError], ['timeout', timeout], ['HTTP 503', json(503, {})], ['HTTP 429', json(429, {})]] as const) {
  test('create ' + label + ' keeps the same id and retries on the next tool call', async () => {
    const h = harness({ '/live/session': [failure, created], '/live/event': ok });
    await h.client.createSession();
    assert.equal(h.client.isStreaming(), true, 'an uncertain create must not disable streaming');
    assert.ok(!h.paths().includes('/live/event'));

    await h.client.logEvent({ n: 1 });
    assert.deepEqual(h.bodies('/live/session'), [{ session_id: 'sess1' }, { session_id: 'sess1' }]);
    assert.deepEqual(h.bodies('/live/event'), [{ session_id: 'sess1', event: { n: 1 }, publish_token: TOKEN }]);
    assertNoTokenLeak(h);
  });
}

test('lost create response followed by 409 does not create a replacement session', async () => {
  // First request reached the server but its response was lost; the retry
  // with the same id now meets our own row. A new id would orphan it.
  const h = harness({ '/live/session': [timeout, json(409, { detail: 'exists' })], '/live/event': ok });
  await h.client.createSession();
  await h.client.logEvent({ n: 1 });
  await h.client.logEvent({ n: 2 });
  assert.deepEqual(h.bodies('/live/session'), [{ session_id: 'sess1' }, { session_id: 'sess1' }]);
  assert.equal(h.client.getSessionId(), 'sess1');
  assert.ok(!h.paths().includes('/live/event'));
  assert.equal(h.client.isStreaming(), false);
  assert.match(h.lines.at(-1)!, /Restart cogext-try/);
});

test('a 200 whose body is cut off in transit is treated as uncertain, not as an old backend', async () => {
  const truncated: Handler = () => ({ status: 200, ok: true, json: () => Promise.reject(new TypeError('terminated')) } as unknown as Response);
  const h = harness({ '/live/session': [truncated, json(409, { detail: 'exists' })], '/live/event': ok });
  await h.client.createSession();
  assert.equal(h.client.isStreaming(), true);
  await h.client.logEvent({ n: 1 });
  assert.deepEqual(h.bodies('/live/session'), [{ session_id: 'sess1' }, { session_id: 'sess1' }]);
  assert.equal(h.client.isStreaming(), false);
  assert.ok(!h.lines.some((l) => l.includes('valid publish token')));
});

test('create attempts are capped', async () => {
  const h = harness({ '/live/session': networkError, '/live/event': ok });
  await h.client.createSession();
  for (let i = 0; i < 10; i++) await h.client.logEvent({ n: i });
  assert.equal(h.bodies('/live/session').length, 4);
  assert.ok(h.bodies('/live/session').every((b) => b.session_id === 'sess1'));
  assert.ok(!h.paths().includes('/live/event'));
  assert.equal(h.client.isStreaming(), false);
});

// ---------------------------------------------------------------- duplicate creation

test('concurrent first events create the session once', async () => {
  const gate = deferred<void>();
  const h = harness({ '/live/session': async (b) => { await gate.promise; return created(b); }, '/live/event': ok });
  const all = Promise.all([1, 2, 3, 4].map((n) => h.client.logEvent({ n })));
  gate.resolve();
  await all;
  assert.equal(h.bodies('/live/session').length, 1);
  assert.equal(h.bodies('/live/event').length, 4);
  assert.ok(h.bodies('/live/event').every((b) => b.publish_token === TOKEN));
});

test('startup create and a concurrent tool call share one create', async () => {
  const gate = deferred<void>();
  const h = harness({ '/live/session': async (b) => { await gate.promise; return created(b); }, '/live/event': ok });
  const both = Promise.all([h.client.createSession(), h.client.logEvent({ n: 1 })]);
  gate.resolve();
  await both;
  assert.equal(h.bodies('/live/session').length, 1);
  assert.equal(h.bodies('/live/event').length, 1);
});

// ---------------------------------------------------------------- events

for (const status of [401, 403, 404, 410]) {
  test('event HTTP ' + status + ' is permanent: streaming stops, no retry', async () => {
    const h = harness({ '/live/session': created, '/live/event': json(status, { detail: 'Invalid publish token' }), '/live/publish': ok }, { publish: true });
    await h.client.createSession();
    await h.client.logEvent({ n: 1 }, { catch: true });
    await h.client.logEvent({ n: 2 }, { catch: true });
    await h.client.publishIfEnabled();
    assert.deepEqual(h.paths(), ['/live/session', '/live/event']);
    assert.equal(h.client.isStreaming(), false);
    assert.match(h.lines[0], new RegExp('HTTP ' + status));
    assertNoTokenLeak(h);
  });
}

for (const [label, failure] of [['network error', networkError], ['timeout', timeout], ['HTTP 502', json(502, {})]] as const) {
  test('event ' + label + ' is not resent, and the session is kept', async () => {
    const h = harness({ '/live/session': created, '/live/event': [failure, ok] });
    await h.client.createSession();
    await h.client.logEvent({ n: 1 });
    await h.client.logEvent({ n: 2 });
    assert.deepEqual(h.bodies('/live/event').map((b) => b.event), [{ n: 1 }, { n: 2 }]);
    assert.ok(h.bodies('/live/event').every((b) => b.publish_token === TOKEN));
    assert.equal(h.bodies('/live/session').length, 1);
    assert.equal(h.client.isStreaming(), true);
    assert.equal(h.lines.length, 1);
  });
}

test('other event 4xx (e.g. 413, 409) drops that event only', async () => {
  const h = harness({ '/live/session': created, '/live/event': [json(413, {}), json(409, {}), ok] });
  await h.client.createSession();
  await h.client.logEvent({ n: 1 });
  await h.client.logEvent({ n: 2 });
  await h.client.logEvent({ n: 3 });
  assert.equal(h.bodies('/live/event').length, 3);
  assert.equal(h.client.isStreaming(), true);
});

// ---------------------------------------------------------------- publishing

test('publishing is off by default even after an accepted catch', async () => {
  const h = harness({ '/live/session': created, '/live/event': ok, '/live/publish': ok });
  await h.client.createSession();
  await h.client.logEvent({ n: 1 }, { catch: true });
  await h.client.publishIfEnabled();
  assert.ok(!h.paths().includes('/live/publish'));
  assert.equal(h.client.isPublishEnabled(), false);
});

test('opt-in publishing waits for an accepted catch, then publishes once with the token', async () => {
  const h = harness({ '/live/session': created, '/live/event': ok, '/live/publish': json(200, { ok: true, url: 'https://cogextai.com/square#sess1' }) }, { publish: true });
  await h.client.createSession();
  await h.client.logEvent({ n: 1 });
  await h.client.publishIfEnabled();
  assert.ok(!h.paths().includes('/live/publish'), 'published without a catch');

  await h.client.logEvent({ n: 2 }, { catch: true });
  await h.client.publishIfEnabled();
  await h.client.logEvent({ n: 3 }, { catch: true });
  await h.client.publishIfEnabled();

  assert.deepEqual(h.bodies('/live/publish'), [{ session_id: 'sess1', publish_token: TOKEN }]);
  assert.ok(h.lines.some((l) => l === 'Published session sess1 to the Square: https://cogextai.com/square#sess1'));
  assertNoTokenLeak(h);
});

test('a catch whose event was not confirmed does not trigger publishing', async () => {
  const h = harness({ '/live/session': created, '/live/event': timeout, '/live/publish': ok }, { publish: true });
  await h.client.createSession();
  await h.client.logEvent({ n: 1 }, { catch: true });
  await h.client.publishIfEnabled();
  assert.ok(!h.paths().includes('/live/publish'));
});

test('uncertain publish is retried after the next catch, then stops once done', async () => {
  const h = harness({ '/live/session': created, '/live/event': ok, '/live/publish': [timeout, ok] }, { publish: true });
  await h.client.createSession();
  await h.client.logEvent({ n: 1 }, { catch: true });
  await h.client.publishIfEnabled();
  await h.client.logEvent({ n: 2 }, { catch: true });
  await h.client.publishIfEnabled();
  await h.client.logEvent({ n: 3 }, { catch: true });
  await h.client.publishIfEnabled();
  assert.equal(h.bodies('/live/publish').length, 2);
  assert.ok(h.lines.some((l) => l.startsWith('Published session sess1')));
});

test('publish attempts are capped', async () => {
  const h = harness({ '/live/session': created, '/live/event': ok, '/live/publish': json(503, {}) }, { publish: true });
  await h.client.createSession();
  for (let i = 0; i < 6; i++) {
    await h.client.logEvent({ n: i }, { catch: true });
    await h.client.publishIfEnabled();
  }
  assert.equal(h.bodies('/live/publish').length, 3);
  assert.equal(h.client.isStreaming(), true);
});

for (const status of [401, 403, 404, 410]) {
  test('publish HTTP ' + status + ' is permanent: no retry, streaming stops', async () => {
    const h = harness({ '/live/session': created, '/live/event': ok, '/live/publish': json(status, { detail: 'Invalid publish token' }) }, { publish: true });
    await h.client.createSession();
    await h.client.logEvent({ n: 1 }, { catch: true });
    await h.client.publishIfEnabled();
    await h.client.logEvent({ n: 2 }, { catch: true });
    await h.client.publishIfEnabled();
    assert.equal(h.bodies('/live/publish').length, 1);
    assert.equal(h.bodies('/live/event').length, 1);
    assert.equal(h.client.isStreaming(), false);
    assertNoTokenLeak(h);
  });
}

test('concurrent publish calls send one request', async () => {
  const gate = deferred<void>();
  const h = harness({ '/live/session': created, '/live/event': ok, '/live/publish': async (b) => { await gate.promise; return ok(b); } }, { publish: true });
  await h.client.createSession();
  await h.client.logEvent({ n: 1 }, { catch: true });
  const all = Promise.all([h.client.publishIfEnabled(), h.client.publishIfEnabled(), h.client.publishIfEnabled()]);
  gate.resolve();
  await all;
  assert.equal(h.bodies('/live/publish').length, 1);
});

test('an untrusted publish URL from the server is not printed', async () => {
  const h = harness({ '/live/session': created, '/live/event': ok, '/live/publish': json(200, { ok: true, url: 'javascript:alert(1)' }) }, { publish: true });
  await h.client.createSession();
  await h.client.logEvent({ n: 1 }, { catch: true });
  await h.client.publishIfEnabled();
  assert.ok(h.lines.includes('Published session sess1 to the Square: https://cogextai.com/square#sess1'));
});

// ---------------------------------------------------------------- module defaults

test('module defaults: publishing off unless COGEXT_TRY_PUBLISH=1; importing sends nothing', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const probe = "const m = await import('./src/session.ts'); console.log(JSON.stringify({ publish: m.isPublishEnabled(), streaming: m.isStreaming(), id: m.getSessionId(), url: m.getLiveUrl() }));";
  const run = (env: Record<string, string>) => {
    const clean = { ...process.env };
    delete clean.COGEXT_TRY_PUBLISH;
    delete clean.COGEXT_TRY_LOCAL;
    // Never a real API, in case anything were sent at import time.
    clean.COGEXT_API_BASE = 'http://127.0.0.1:9/api/v1';
    const r = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], { cwd: root, env: { ...clean, ...env }, encoding: 'utf8' }));
    assert.match(r.id, UUID_V4);
    assert.equal(r.url, 'https://cogextai.com/live/' + r.id);
    return { publish: r.publish, streaming: r.streaming };
  };
  assert.deepEqual(run({}), { publish: false, streaming: true });
  assert.deepEqual(run({ COGEXT_TRY_PUBLISH: '1' }), { publish: true, streaming: true });
  assert.deepEqual(run({ COGEXT_TRY_PUBLISH: 'true' }), { publish: false, streaming: true });
  assert.deepEqual(run({ COGEXT_TRY_PUBLISH: '1', COGEXT_TRY_LOCAL: '1' }), { publish: false, streaming: false });
});
