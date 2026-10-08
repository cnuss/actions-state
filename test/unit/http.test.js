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

test('redactUrl hides SAS signatures', () => {
  assert.equal(h.redactUrl('https://x.blob.core/c?sv=1&sig=abc'), 'https://x.blob.core/c?sv=1&sig=REDACTED');
});

test('parseJson returns {} for bad input', () => {
  assert.deepEqual(h.parseJson('nope'), {});
  assert.deepEqual(h.parseJson(''), {});
});
