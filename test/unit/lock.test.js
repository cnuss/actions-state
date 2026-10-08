'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLock } = require('../../src/core/lock');
const { createFakeCache } = require('../fakes/cache');

function clock() {
  let t = 0;
  const hooks = [];
  const sleeps = [];
  return {
    now: () => t,
    sleeps,
    sleep: async (ms) => { sleeps.push(ms); t += ms; const hook = hooks.shift(); if (hook) await hook(); },
    onNextSleep: (fn) => hooks.push(fn),
  };
}

const identity = (jobId) => ({ run_id: '1', run_attempt: '1', job_id: jobId, job_name: `job ${jobId}`, job_url: '', ref: 'refs/heads/main' });

function makeLock(fake, c, jobId = 1, extra = {}) {
  return createLock({
    twirp: fake.twirp, rest: fake.rest, blobs: fake.blobs,
    repository: 'o/r', ref: 'refs/heads/main', slug: 'root', identity: identity(jobId),
    now: c.now, sleep: c.sleep, random: () => 0, ...extra,
  });
}

test('acquire on a free lock publishes the lock and its holder record', async () => {
  const fake = createFakeCache();
  const lock = makeLock(fake, clock());
  const got = await lock.acquire({ info: { ID: 'a' }, waitMs: 0 });
  assert.equal(got.ok, true);
  assert.deepEqual(fake.finalizedKeys(), ['actions-state/root', `actions-state/root/holder/${got.entryId}`]);
  const current = await lock.readCurrent();
  assert.equal(current.entryId, got.entryId);
  assert.equal(current.holder.lockInfo.ID, 'a');
  assert.equal(current.holder.identity.job_id, 1);
});

test('a held lock with waitMs 0 reports the holder at once', async () => {
  const fake = createFakeCache();
  const c = clock();
  await makeLock(fake, c, 1).acquire({ info: { ID: 'a', Who: 'first' }, waitMs: 0 });
  const got = await makeLock(fake, c, 2).acquire({ info: { ID: 'b' }, waitMs: 0 });
  assert.equal(got.ok, false);
  assert.equal(got.current.holder.lockInfo.Who, 'first');
  assert.deepEqual(c.sleeps, []);
});

test('a waiter gets the lock once the holder releases', async () => {
  const fake = createFakeCache();
  const c = clock();
  const a = makeLock(fake, c, 1);
  const b = makeLock(fake, c, 2);
  const first = await a.acquire({ info: { ID: 'a' }, waitMs: 0 });
  c.onNextSleep(() => a.release(first));
  const got = await b.acquire({ info: { ID: 'b' }, waitMs: 60_000 });
  assert.equal(got.ok, true);
  assert.equal((await b.readCurrent()).holder.lockInfo.ID, 'b');
});

test('release deletes the lock and its holder record', async () => {
  const fake = createFakeCache();
  const lock = makeLock(fake, clock());
  await lock.release(await lock.acquire({ info: { ID: 'a' }, waitMs: 0 }));
  assert.deepEqual(fake.finalizedKeys(), []);
  assert.equal(await lock.readCurrent(), null);
});

test('reclaims a lock whose holder job has completed', async () => {
  const fake = createFakeCache();
  const c = clock();
  await makeLock(fake, c, 7).acquire({ info: { ID: 'a' }, waitMs: 0 });
  fake.setJob(7, 'completed');
  const got = await makeLock(fake, c, 8, { timing: { reclaimIntervalMs: 5000 } }).acquire({ info: { ID: 'b' }, waitMs: 120_000 });
  assert.equal(got.ok, true);
});

test('does not reclaim while the holder job is running', async () => {
  const fake = createFakeCache();
  const c = clock();
  await makeLock(fake, c, 7).acquire({ info: { ID: 'a' }, waitMs: 0 });
  fake.setJob(7, 'in_progress');
  const got = await makeLock(fake, c, 8, { timing: { reclaimIntervalMs: 5000 } }).acquire({ info: { ID: 'b' }, waitMs: 30_000 });
  assert.equal(got.ok, false);
  assert.equal(got.current.holder.lockInfo.ID, 'a');
});

test('forceRelease releases only a matching lock ID', async () => {
  const fake = createFakeCache();
  const c = clock();
  await makeLock(fake, c, 1).acquire({ info: { ID: 'a' }, waitMs: 0 });
  const other = makeLock(fake, c, 2);
  assert.equal(await other.forceRelease('not-a'), false);
  assert.equal(await other.forceRelease('a'), true);
  assert.equal(await other.readCurrent(), null);
});

test('forceRelease with an empty ID releases any holder', async () => {
  const fake = createFakeCache();
  const c = clock();
  await makeLock(fake, c, 1).acquire({ info: { ID: 'a' }, waitMs: 0 });
  assert.equal(await makeLock(fake, c, 2).forceRelease(''), true);
  assert.deepEqual(fake.finalizedKeys(), ['actions-state/root/holder/1000']);
});

test('waitUntilFree: true when free, false when held past waitMs, true once released', async () => {
  const fake = createFakeCache();
  const c = clock();
  const a = makeLock(fake, c, 1);
  assert.equal(await a.waitUntilFree({ waitMs: 0 }), true);
  const held = await a.acquire({ info: { ID: 'a' }, waitMs: 0 });
  assert.equal(await a.waitUntilFree({ waitMs: 10_000 }), false);
  c.onNextSleep(() => a.release(held));
  assert.equal(await a.waitUntilFree({ waitMs: 10_000 }), true);
});

test('a throttled CreateCacheEntry waits out Retry-After', async () => {
  const fake = createFakeCache();
  const c = clock();
  fake.throttleNext('CreateCacheEntry', 1);
  const got = await makeLock(fake, c).acquire({ info: { ID: 'a' }, waitMs: 60_000 });
  assert.equal(got.ok, true);
  assert.equal(c.sleeps[0], 1000);
});

test('an aborted acquire gives up without taking the lock', async () => {
  const fake = createFakeCache();
  const c = clock();
  await makeLock(fake, c, 1).acquire({ info: { ID: 'a' }, waitMs: 0 });
  const abort = new AbortController();
  c.onNextSleep(() => abort.abort());
  const got = await makeLock(fake, c, 2).acquire({ info: { ID: 'b' }, waitMs: 60_000, signal: abort.signal });
  assert.deepEqual(got, { ok: false, aborted: true });
});

test('a failed holder publish still returns a releasable lock', async () => {
  const fake = createFakeCache();
  const lock = makeLock(fake, clock());
  fake.failPut(1, 1);
  const got = await lock.acquire({ info: { ID: 'a' }, waitMs: 0 });
  assert.equal(got.ok, true);
  assert.equal(got.holderId, '');
  assert.deepEqual(fake.finalizedKeys(), ['actions-state/root']);
  await lock.release(got);
  assert.deepEqual(fake.finalizedKeys(), []);
  assert.equal(await lock.readCurrent(), null);
});

test('a failed lock publish throws without leaving the lock held', async () => {
  const fake = createFakeCache();
  const lock = makeLock(fake, clock());
  fake.failPut(1);
  await assert.rejects(lock.acquire({ info: { ID: 'a' }, waitMs: 0 }), /blob upload failed/);
  assert.deepEqual(fake.finalizedKeys(), []);
  assert.equal(await lock.readCurrent(), null);
});

test('REST failures while waiting end as not acquired, not an exception', async () => {
  const fake = createFakeCache();
  const c = clock();
  await makeLock(fake, c, 1).acquire({ info: { ID: 'a' }, waitMs: 0 });
  fake.failList(1000, 500);
  const got = await makeLock(fake, c, 2, { timing: { reclaimIntervalMs: 5000 } }).acquire({ info: { ID: 'b' }, waitMs: 30_000 });
  assert.deepEqual(got, { ok: false, current: null });
});

test('a network error publishing the holder record still returns a releasable lock', async () => {
  const fake = createFakeCache();
  const twirp = async (method, body) => {
    if (method === 'CreateCacheEntry' && body.key.includes('/holder/')) throw new Error('socket hang up');
    return fake.twirp(method, body);
  };
  const lock = makeLock(fake, clock(), 1, { twirp });
  const got = await lock.acquire({ info: { ID: 'a' }, waitMs: 0 });
  assert.equal(got.ok, true);
  assert.equal(got.holderId, '');
  await lock.release(got);
  assert.deepEqual(fake.finalizedKeys(), []);
  assert.equal(await lock.readCurrent(), null);
});

test('lock-timeout 0 still reclaims a lock whose holder job has completed', async () => {
  const fake = createFakeCache();
  const c = clock();
  await makeLock(fake, c, 7).acquire({ info: { ID: 'a' }, waitMs: 0 });
  fake.setJob(7, 'completed');
  const got = await makeLock(fake, c, 8).acquire({ info: { ID: 'b' }, waitMs: 0 });
  assert.equal(got.ok, true);
  assert.equal((await makeLock(fake, c, 8).readCurrent()).holder.lockInfo.ID, 'b');
});

test('aborting during a long real sleep wakes acquire and waitUntilFree at once', async () => {
  const fake = createFakeCache();
  const timing = { pollDelayMs: 5000, pollJitterMs: 0 };
  await makeLock(fake, clock(), 1).acquire({ info: { ID: 'a' }, waitMs: 0 });
  const real = createLock({
    twirp: fake.twirp, rest: fake.rest, blobs: fake.blobs,
    repository: 'o/r', ref: 'refs/heads/main', slug: 'root', identity: identity(2), random: () => 0, timing,
  });

  const abort = new AbortController();
  setTimeout(() => abort.abort(), 50);
  let started = Date.now();
  assert.deepEqual(await real.acquire({ info: { ID: 'b' }, waitMs: 60_000, signal: abort.signal }), { ok: false, aborted: true });
  assert.ok(Date.now() - started < 1000, `acquire took ${Date.now() - started} ms`);

  const abort2 = new AbortController();
  setTimeout(() => abort2.abort(), 50);
  started = Date.now();
  assert.equal(await real.waitUntilFree({ waitMs: 60_000, signal: abort2.signal }), false);
  assert.ok(Date.now() - started < 1000, `waitUntilFree took ${Date.now() - started} ms`);
});
