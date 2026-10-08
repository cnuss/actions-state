'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeHttp = require('node:http');
const { createApp } = require('../../src/server');
const { request } = require('../../src/core/http');
const { getAdapter } = require('../../src/adapters');
const { isEncrypted, encrypt } = require('../../src/core/crypto');
const { PREFIX } = require('../../src/core/store');

function fakeLock() {
  const state = { holder: null, released: [], acquireCalls: 0 };
  return {
    state,
    async acquire({ info }) {
      state.acquireCalls += 1;
      if (state.holder) return { ok: false, current: { entryId: 'e0', holder: { lockInfo: state.holder } } };
      state.holder = info;
      return { ok: true, entryId: 'e1', holderId: 'h1' };
    },
    async release(h) { state.released.push(h.entryId); state.holder = null; },
    async readCurrent() { return state.holder ? { entryId: 'e0', holder: { lockInfo: state.holder } } : null; },
    async forceRelease(id) {
      if (!state.holder || (id && state.holder.ID !== id)) return false;
      state.holder = null;
      return true;
    },
    async waitUntilFree() { return !state.holder; },
  };
}

function fakeStore() {
  const versions = [];
  return {
    versions,
    failPushes: [],
    async resolve() {
      const v = versions[versions.length - 1];
      return v ? { digest: v.digest, manifest: v.manifest } : null;
    },
    async pull(resolved) {
      const v = versions.find((x) => x.digest === resolved.digest);
      return { bytes: v.bytes, mediaType: v.manifest.layers[0].mediaType, annotations: v.manifest.annotations };
    },
    async push({ bytes, mediaType, annotations, tags }) {
      const failure = this.failPushes.shift();
      if (failure) throw failure;
      const digest = `sha256:${versions.length + 1}`;
      versions.push({ digest, bytes, tags, manifest: { annotations, layers: [{ mediaType }] } });
      return digest;
    },
  };
}

const stateJson = (serial, lineage = 'L') => JSON.stringify({ version: 4, serial, lineage, resources: [] });

async function setup(overrides = {}) {
  const lock = overrides.lock || fakeLock();
  const store = overrides.store || fakeStore();
  const events = { shutdown: 0, held: [] };
  const app = createApp({
    password: 'pw', lock, store, adapter: getAdapter('terraform'), slug: 'root', name: 'root',
    isDefaultRef: true, allowAnyRef: false, lockTimeoutMs: 1000, passphrase: '', aad: 'o/r:root',
    meta: { runId: '9', sha: 'abc', ref: 'refs/heads/main', defaultRef: 'refs/heads/main', source: 'https://github.com/o/r' },
    sleep: async () => {},
    onHeldChange: (h) => events.held.push(h),
    onShutdown: () => { events.shutdown += 1; },
    ...overrides,
  });
  const server = nodeHttp.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body = null, password = 'pw') => request(method, `${url}${path}`, {
    Authorization: `Basic ${Buffer.from(`actions-state:${password}`).toString('base64')}`,
  }, body);
  const lockBody = (ID, Operation = 'OperationTypeApply') => JSON.stringify({ ID, Operation, Who: 'tester', Info: '', Version: '1', Created: '', Path: '' });
  return { app, lock, store, events, url, call, lockBody, close: () => new Promise((r) => server.close(r)) };
}

test('requests without the password are refused', async () => {
  const s = await setup();
  assert.equal((await s.call('GET', '/state', null, 'wrong')).status, 401);
  await s.close();
});

test('lock, read empty state, save, read it back', async () => {
  const s = await setup();
  assert.equal((await s.call('LOCK', '/lock', s.lockBody('a'))).status, 200);
  assert.equal((await s.call('GET', '/state')).status, 404);
  assert.equal((await s.call('POST', '/state?ID=a', stateJson(1))).status, 200);
  assert.deepEqual(s.store.versions[0].tags, ['root.v1', 'root']);
  assert.equal(s.store.versions[0].manifest.annotations[`${PREFIX}.serial`], '1');
  assert.equal(s.store.versions[0].manifest.annotations[`${PREFIX}.previous`], '');
  const got = await s.call('GET', '/state');
  assert.equal(got.status, 200);
  assert.equal(got.text, stateJson(1));
  assert.equal((await s.call('UNLOCK', '/lock', s.lockBody('a'))).status, 200);
  assert.deepEqual(s.lock.state.released, ['e1']);
  await s.close();
});

test('POST without a lock ID is refused', async () => {
  const s = await setup();
  await s.call('GET', '/state');
  const r = await s.call('POST', '/state', stateJson(1));
  assert.equal(r.status, 409);
  assert.match(r.text, /-lock=false/);
  await s.close();
});

test('POST with a lock ID this server does not hold is refused', async () => {
  const s = await setup();
  await s.call('LOCK', '/lock', s.lockBody('a'));
  await s.call('GET', '/state');
  assert.equal((await s.call('POST', '/state?ID=b', stateJson(1))).status, 409);
  await s.close();
});

test('POST is refused when a newer version appeared after the read', async () => {
  const s = await setup();
  await s.call('LOCK', '/lock', s.lockBody('a'));
  await s.call('GET', '/state');
  await s.store.push({ bytes: Buffer.from(stateJson(5)), mediaType: 'x', annotations: { [`${PREFIX}.serial`]: '5' }, tags: ['root'] });
  const r = await s.call('POST', '/state?ID=a', stateJson(2));
  assert.equal(r.status, 409);
  assert.match(r.text, /state changed since it was loaded \(loaded serial none, current serial 5\)/);
  await s.close();
});

test('POST with a non-state body is a 400', async () => {
  const s = await setup();
  await s.call('LOCK', '/lock', s.lockBody('a'));
  await s.call('GET', '/state');
  assert.equal((await s.call('POST', '/state?ID=a', 'not json')).status, 400);
  await s.close();
});

test('LOCK held by another job times out with its lock info', async () => {
  const s = await setup();
  s.lock.state.holder = { ID: 'other', Who: 'someone@elsewhere' };
  const r = await s.call('LOCK', '/lock', s.lockBody('a'));
  assert.equal(r.status, 423);
  assert.equal(JSON.parse(r.text).Who, 'someone@elsewhere');
  await s.close();
});

test('LOCK is idempotent for the holder and refused for anyone else', async () => {
  const s = await setup();
  assert.equal((await s.call('LOCK', '/lock', s.lockBody('a'))).status, 200);
  assert.equal((await s.call('LOCK', '/lock', s.lockBody('a'))).status, 200);
  const r = await s.call('LOCK', '/lock', s.lockBody('b'));
  assert.equal(r.status, 423);
  assert.equal(JSON.parse(r.text).ID, 'a');
  assert.equal(s.lock.state.acquireCalls, 1);
  await s.close();
});

test('UNLOCK with an empty body force-releases another job\'s lock', async () => {
  const s = await setup();
  s.lock.state.holder = { ID: 'other' };
  assert.equal((await s.call('UNLOCK', '/lock', '')).status, 200);
  assert.equal(s.lock.state.holder, null);
  await s.close();
});

test('UNLOCK naming a different ID than the holder is a 409', async () => {
  const s = await setup();
  s.lock.state.holder = { ID: 'other', Who: 'x' };
  const r = await s.call('UNLOCK', '/lock', s.lockBody('mine'));
  assert.equal(r.status, 409);
  assert.equal(JSON.parse(r.text).ID, 'other');
  await s.close();
});

test('a plan-only ref plans without a cache lock and is refused applies and saves', async () => {
  const s = await setup({ isDefaultRef: false, meta: { runId: '9', sha: 'abc', ref: 'refs/pull/1/merge', defaultRef: 'refs/heads/main', source: 'https://github.com/o/r' } });
  assert.equal((await s.call('LOCK', '/lock', s.lockBody('p', 'OperationTypePlan'))).status, 200);
  assert.equal(s.lock.state.acquireCalls, 0);
  assert.equal((await s.call('UNLOCK', '/lock', s.lockBody('p'))).status, 200);
  const refused = await s.call('LOCK', '/lock', s.lockBody('x', 'OperationTypeApply'));
  assert.equal(refused.status, 423);
  assert.match(JSON.parse(refused.text).Info, /may only plan.*allow-apply-from-any-ref/);
  assert.equal((await s.call('POST', '/state?ID=x', stateJson(1))).status, 403);
  await s.close();
});

test('allow-apply-from-any-ref takes a real lock on other refs', async () => {
  const s = await setup({ isDefaultRef: false, allowAnyRef: true });
  assert.equal((await s.call('LOCK', '/lock', s.lockBody('x'))).status, 200);
  assert.equal(s.lock.state.acquireCalls, 1);
  await s.close();
});

test('with a passphrase, saved layers are encrypted and reads decrypt them', async () => {
  const s = await setup({ passphrase: 'secret-passphrase' });
  await s.call('LOCK', '/lock', s.lockBody('a'));
  await s.call('GET', '/state');
  await s.call('POST', '/state?ID=a', stateJson(1));
  const v = s.store.versions[0];
  assert.ok(isEncrypted(v.bytes));
  assert.equal(v.manifest.layers[0].mediaType, 'application/vnd.cnuss.actions-state.tfstate.v1.enc');
  assert.equal(v.manifest.annotations[`${PREFIX}.encrypted`], 'true');
  assert.equal((await s.call('GET', '/state')).text, stateJson(1));
  await s.close();
});

test('encrypted state without a passphrase fails to load', async () => {
  const store = fakeStore();
  await store.push({ bytes: encrypt(Buffer.from(stateJson(1)), 'p', 'o/r:root'), mediaType: 'x.enc', annotations: {}, tags: ['root'] });
  const s = await setup({ store });
  await assert.rejects(s.app.loadLatest(), /set the passphrase input/);
  await s.close();
});

test('DELETE /state is not supported', async () => {
  const s = await setup();
  assert.equal((await s.call('DELETE', '/state')).status, 405);
  await s.close();
});

test('a failed push is retried, and gives up with a 502', async () => {
  const s = await setup();
  await s.call('LOCK', '/lock', s.lockBody('a'));
  await s.call('GET', '/state');
  s.store.failPushes.push(Object.assign(new Error('503'), { retryable: true }));
  assert.equal((await s.call('POST', '/state?ID=a', stateJson(1))).status, 200);
  s.store.failPushes.push(Object.assign(new Error('403'), { retryable: false }));
  assert.equal((await s.call('POST', '/state?ID=a', stateJson(2))).status, 502);
  await s.close();
});

test('shutdown releases a held lock', async () => {
  const s = await setup();
  await s.call('LOCK', '/lock', s.lockBody('a'));
  assert.equal((await s.call('POST', '/shutdown')).status, 200);
  assert.deepEqual(s.lock.state.released, ['e1']);
  assert.equal(s.events.shutdown, 1);
  assert.equal(s.events.held.at(-1), null);
  await s.close();
});

test('a LOCK abandoned by its client leaves nothing held', async () => {
  let release;
  const lock = fakeLock();
  lock.acquire = ({ signal }) => new Promise((resolve) => {
    release = () => resolve({ ok: true, entryId: 'late', holderId: 'h' });
    signal.addEventListener('abort', () => setTimeout(release, 10));
  });
  const s = await setup({ lock });
  const req = nodeHttp.request(`${s.url}/lock`, {
    method: 'LOCK',
    headers: { Authorization: `Basic ${Buffer.from('actions-state:pw').toString('base64')}` },
  });
  req.on('error', () => {});
  req.end(s.lockBody('a'));
  await new Promise((r) => setTimeout(r, 50));
  req.destroy();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.app.held, null);
  assert.deepEqual(lock.state.released, ['late']);
  await s.close();
});

test('a second LOCK while one is waiting is refused', async () => {
  let finish;
  const lock = fakeLock();
  lock.acquire = () => new Promise((resolve) => { finish = () => resolve({ ok: true, entryId: 'e1', holderId: 'h1' }); });
  const s = await setup({ lock });
  const first = s.call('LOCK', '/lock', s.lockBody('a'));
  await new Promise((r) => setTimeout(r, 20));
  const second = await s.call('LOCK', '/lock', s.lockBody('b'));
  assert.equal(second.status, 423);
  assert.equal(JSON.parse(second.text).ID, 'a');
  finish();
  assert.equal((await first).status, 200);
  await s.close();
});

test('a failed release keeps the lock held and can be retried', async () => {
  const lock = fakeLock();
  const realRelease = lock.release;
  let failures = 1;
  lock.release = async (h) => {
    if (failures-- > 0) throw new Error('429');
    return realRelease(h);
  };
  const s = await setup({ lock });
  await s.call('LOCK', '/lock', s.lockBody('a'));
  assert.equal((await s.call('UNLOCK', '/lock', s.lockBody('a'))).status, 500);
  assert.equal(s.app.held.id, 'a');
  assert.equal((await s.call('UNLOCK', '/lock', s.lockBody('a'))).status, 200);
  assert.deepEqual(lock.state.released, ['e1']);
  assert.equal(s.app.held, null);
  await s.close();
});

test('shutdown after a failed UNLOCK still releases', async () => {
  const lock = fakeLock();
  const realRelease = lock.release;
  let failures = 1;
  lock.release = async (h) => {
    if (failures-- > 0) throw new Error('503');
    return realRelease(h);
  };
  const s = await setup({ lock });
  await s.call('LOCK', '/lock', s.lockBody('a'));
  assert.equal((await s.call('UNLOCK', '/lock', s.lockBody('a'))).status, 500);
  assert.equal((await s.call('POST', '/shutdown')).status, 200);
  assert.deepEqual(lock.state.released, ['e1']);
  assert.equal(s.events.held.at(-1), null);
  await s.close();
});

test('a malformed request target is a 400, not a crash', async () => {
  const s = await setup();
  const out = {};
  const res = {
    writableEnded: false, destroyed: false,
    writeHead(status) { out.status = status; },
    end() { this.writableEnded = true; },
  };
  await s.app.handle({ url: 'http://[', method: 'GET', headers: {}, on() {} }, res);
  assert.equal(out.status, 400);
  await s.close();
});

test('a LOCK pending at shutdown is not granted', async () => {
  let finish;
  const lock = fakeLock();
  lock.acquire = () => new Promise((resolve) => { finish = () => resolve({ ok: true, entryId: 'late', holderId: 'h' }); });
  const s = await setup({ lock });
  const first = s.call('LOCK', '/lock', s.lockBody('a'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await s.call('POST', '/shutdown')).status, 200);
  finish();
  assert.equal((await first).status, 423);
  assert.deepEqual(lock.state.released, ['late']);
  assert.equal(s.app.held, null);
  assert.equal((await s.call('LOCK', '/lock', s.lockBody('b'))).status, 423);
  await s.close();
});

test('loading refuses a tag that holds another state', async () => {
  const store = fakeStore();
  await store.push({ bytes: Buffer.from(stateJson(1)), mediaType: 'x', annotations: { [`${PREFIX}.name`]: 'other', [`${PREFIX}.serial`]: '1' }, tags: ['root'] });
  const s = await setup({ store });
  await assert.rejects(s.app.loadLatest(), /tag "root" holds state "other", not "root"; give one of them a different name/);
  await s.close();
});

test('saving refuses a tag that holds another state', async () => {
  const s = await setup();
  await s.call('LOCK', '/lock', s.lockBody('a'));
  await s.call('GET', '/state');
  await s.store.push({ bytes: Buffer.from(stateJson(3)), mediaType: 'x', annotations: { [`${PREFIX}.name`]: 'other', [`${PREFIX}.serial`]: '3' }, tags: ['root'] });
  const r = await s.call('POST', '/state?ID=a', stateJson(1));
  assert.equal(r.status, 409);
  assert.match(r.text, /tag "root" holds state "other", not "root"/);
  assert.equal(s.store.versions.length, 1);
  await s.close();
});

test('a version without a name annotation is accepted', async () => {
  const store = fakeStore();
  await store.push({ bytes: Buffer.from(stateJson(1)), mediaType: 'x', annotations: { [`${PREFIX}.serial`]: '1' }, tags: ['root'] });
  const s = await setup({ store });
  assert.equal((await s.app.loadLatest()).toString(), stateJson(1));
  await s.close();
});
