'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeHttp = require('node:http');
const h = require('../../src/core/http');

function serve(handler) {
  return new Promise((resolve) => {
    const server = nodeHttp.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

test('request sends method, headers and body on a closed connection', async () => {
  let seen;
  const srv = await serve((req, res, body) => {
    seen = { method: req.method, path: req.url, auth: req.headers.authorization, body, connection: req.headers.connection };
    res.writeHead(201, { 'x-test': '1' });
    res.end('done');
  });
  const r = await h.request('PUT', `${srv.url}/p?q=1`, { Authorization: 'Bearer t' }, 'hello');
  await srv.close();
  assert.equal(r.status, 201);
  assert.equal(r.text, 'done');
  assert.equal(r.headers['x-test'], '1');
  assert.deepEqual(seen, { method: 'PUT', path: '/p?q=1', auth: 'Bearer t', body: 'hello', connection: 'close' });
});

test('cacheClient posts twirp JSON with the runtime token', async () => {
  let seen;
  const srv = await serve((req, res, body) => {
    seen = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.end('{"ok":true}');
  });
  const twirp = h.cacheClient({ token: 'rt', resultsUrl: `${srv.url}/` });
  const r = await twirp('CreateCacheEntry', { key: 'k', version: 'v' });
  await srv.close();
  assert.equal(seen.path, '/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry');
  assert.equal(seen.auth, 'Bearer rt');
  assert.deepEqual(seen.body, { key: 'k', version: 'v' });
  assert.deepEqual(r.json, { ok: true });
});

test('cacheClient refuses to start without the runtime environment', () => {
  assert.throws(() => h.cacheClient({ token: '', resultsUrl: '' }), /ACTIONS_RUNTIME_TOKEN/);
});

test('restClient sends GitHub API headers and parses JSON', async () => {
  let seen;
  const srv = await serve((req, res, body) => {
    seen = { path: req.url, method: req.method, accept: req.headers.accept, version: req.headers['x-github-api-version'], body };
    res.end('{"id":1}');
  });
  const rest = h.restClient({ token: 'gh', apiUrl: srv.url });
  const r = await rest('DELETE', '/repos/o/r/actions/caches/5');
  await srv.close();
  assert.deepEqual(seen, { path: '/repos/o/r/actions/caches/5', method: 'DELETE', accept: 'application/vnd.github+json', version: '2022-11-28', body: '' });
  assert.deepEqual(r.json, { id: 1 });
});

test('restClient retries a rate-limited request after the wait GitHub asks for', async () => {
  const statuses = [[429, { 'retry-after': '2' }], [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' }], [200, {}]];
  const seen = [];
  const srv = await serve((req, res, body) => {
    seen.push(body);
    const [status, headers] = statuses.shift();
    res.writeHead(status, headers);
    res.end(status === 200 ? '{"ok":true}' : '{}');
  });
  const slept = [];
  const rest = h.restClient({ token: 'gh', apiUrl: srv.url, sleep: async (ms) => { slept.push(ms); } });
  const r = await rest('POST', '/x', { a: 1 });
  await srv.close();
  assert.equal(r.status, 200);
  assert.deepEqual(slept, [2000, 0]);
  assert.deepEqual(seen, ['{"a":1}', '{"a":1}', '{"a":1}']);
});

test('isRateLimited covers 429 and GitHub rate-limit 403s, not permission 403s', () => {
  assert.equal(h.isRateLimited({ status: 429, headers: {} }), true);
  assert.equal(h.isRateLimited({ status: 403, headers: { 'retry-after': '60' } }), true);
  assert.equal(h.isRateLimited({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }), true);
  assert.equal(h.isRateLimited({ status: 403, headers: { 'x-ratelimit-remaining': '12' } }), false);
  assert.equal(h.isRateLimited({ status: 503, headers: {} }), false);
});

test('rateLimitWaitMs uses Retry-After, then the quota reset, then the fallback', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  assert.equal(h.rateLimitWaitMs({ 'retry-after': '3' }, 1000, now), 3000);
  assert.equal(h.rateLimitWaitMs({ 'retry-after': 'Sun, 11 Oct 2026 12:00:07 GMT' }, 1000, now), 7000);
  assert.equal(h.rateLimitWaitMs({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 30) }, 1000, now), 30000);
  assert.equal(h.rateLimitWaitMs({}, 1000, now), 1000);
});

test('retryRateLimited backs off without headers and returns the last response after its tries', async () => {
  const slept = [];
  let sent = 0;
  const r = await h.retryRateLimited(async () => { sent += 1; return { status: 429, headers: {} }; }, { sleep: async (ms) => { slept.push(ms); } });
  assert.equal(r.status, 429);
  assert.equal(sent, 4);
  assert.deepEqual(slept, [1000, 2000, 4000]);
});

test('retryRateLimited does not wait more than a minute', async () => {
  let sent = 0;
  const r = await h.retryRateLimited(async () => { sent += 1; return { status: 429, headers: { 'retry-after': '3600' } }; },
    { sleep: async () => { throw new Error('slept'); } });
  assert.equal(r.status, 429);
  assert.equal(sent, 1);
});

test('retryAfterMs honours seconds, falls back, and caps at a minute', () => {
  assert.equal(h.retryAfterMs({ 'retry-after': '5' }, 3000), 5000);
  assert.equal(h.retryAfterMs({}, 3000), 3000);
  assert.equal(h.retryAfterMs({ 'retry-after': '600' }, 3000), 60000);
});

test('isThrottled covers 429 and 5xx only', () => {
  assert.equal(h.isThrottled({ status: 429 }), true);
  assert.equal(h.isThrottled({ status: 503 }), true);
  assert.equal(h.isThrottled({ status: 409 }), false);
});

test('redactUrl drops the query string', () => {
  assert.equal(h.redactUrl('https://x.blob.core/c/d?sv=1&sig=abc&se=2026'), 'https://x.blob.core/c/d');
  assert.equal(h.redactUrl('not a url'), 'not a url');
});

test('parseJson returns {} for bad input', () => {
  assert.deepEqual(h.parseJson('nope'), {});
  assert.deepEqual(h.parseJson(''), {});
});

test('request times out when the server never answers', async () => {
  const sockets = new Set();
  const server = nodeHttp.createServer(() => {});
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(h.request('GET', `http://127.0.0.1:${server.address().port}/`, {}, null, { timeoutMs: 100 }), /timeout/);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
});

async function timeoutOf(options) {
  const srv = await serve((req, res) => res.end('ok'));
  const orig = nodeHttp.request;
  let captured;
  nodeHttp.request = (...args) => { captured = orig(...args); return captured; };
  try {
    assert.equal((await h.request('GET', `${srv.url}/`, {}, null, options)).text, 'ok');
  } finally {
    nodeHttp.request = orig;
    await srv.close();
  }
  return captured.timeout;
}

test('request applies a 60 s timeout by default, an explicit one, or none for 0', async () => {
  assert.equal(h.DEFAULT_TIMEOUT_MS, 60_000);
  assert.equal(await timeoutOf(undefined), 60_000);
  assert.equal(await timeoutOf({}), 60_000);
  assert.equal(await timeoutOf({ timeoutMs: 1234 }), 1234);
  assert.equal(await timeoutOf({ timeoutMs: 0 }), undefined);
});

test('signed blob transfers get the longer blob timeout', async () => {
  assert.equal(h.BLOB_TIMEOUT_MS, 300_000);
  const srv = await serve((req, res) => { res.writeHead(req.method === 'PUT' ? 201 : 200); res.end('b'); });
  const orig = nodeHttp.request;
  const seen = [];
  nodeHttp.request = (...args) => { const r = orig(...args); seen.push(r.timeout); return r; };
  try {
    await h.blobs.put(`${srv.url}/blob`, Buffer.from('x'));
    assert.equal((await h.blobs.get(`${srv.url}/blob`)).toString(), 'b');
  } finally {
    nodeHttp.request = orig;
    await srv.close();
  }
  assert.deepEqual(seen, [300_000, 300_000]);
});
