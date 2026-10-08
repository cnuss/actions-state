'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, annotationsFor, serialOf, digestOf, EMPTY, ARTIFACT_TYPE, PREFIX } = require('../../src/core/store');
const { startFakeRegistry } = require('../fakes/registry');

const LAYER = 'application/vnd.cnuss.actions-state.tfstate.v1';
const annotations = (serial) => annotationsFor({
  name: 'root', serial, lineage: 'L', encrypted: false, runId: '9', sha: 'abc',
  ref: 'refs/heads/main', previous: '', source: 'https://github.com/o/r', created: '2026-10-08T00:00:00Z',
});

test('resolve is null when the tag does not exist', async (t) => {
  const reg = await startFakeRegistry();
  t.after(() => reg.close());
  const store = createStore({ registry: reg.url, image: 'o/r/actions-state', token: 'gh' });
  assert.equal(await store.resolve('root'), null);
});

test('push, resolve and pull round-trip one version', async (t) => {
  const reg = await startFakeRegistry();
  t.after(() => reg.close());
  const store = createStore({ registry: reg.url, image: 'o/r/actions-state', token: 'gh' });
  const digest = await store.push({ bytes: Buffer.from('{"serial":3}'), mediaType: LAYER, annotations: annotations(3), tags: ['root.v3', 'root'] });
  const resolved = await store.resolve('root');
  assert.equal(resolved.digest, digest);
  assert.equal(resolved.manifest.artifactType, ARTIFACT_TYPE);
  assert.deepEqual(resolved.manifest.config, EMPTY);
  assert.equal(resolved.manifest.layers[0].mediaType, LAYER);
  assert.equal(serialOf(resolved.manifest), 3);
  assert.equal(resolved.manifest.annotations[`${PREFIX}.ref`], 'refs/heads/main');
  const pulled = await store.pull(resolved);
  assert.equal(pulled.bytes.toString(), '{"serial":3}');
  assert.deepEqual((await store.listTags()).sort(), ['root', 'root.v3']);
  assert.deepEqual(reg.scopes, ['repository:o/r/actions-state:pull,push']);
});

test('blobs already in the registry are not uploaded again', async (t) => {
  const reg = await startFakeRegistry();
  t.after(() => reg.close());
  const store = createStore({ registry: reg.url, image: 'o/r/actions-state', token: 'gh' });
  const version = { bytes: Buffer.from('{"serial":1}'), mediaType: LAYER, annotations: annotations(1), tags: ['root'] };
  await store.push(version);
  const uploadsBefore = reg.requests.filter((r) => r.startsWith('POST ')).length;
  await store.push({ ...version, tags: ['root.v1'] });
  assert.equal(reg.requests.filter((r) => r.startsWith('POST ')).length, uploadsBefore);
  assert.equal(uploadsBefore, 2);
});

test('the empty config descriptor has the well-known digest', () => {
  assert.equal(digestOf(Buffer.from('{}')), EMPTY.digest);
});

test('server errors are retryable and client errors are not', async () => {
  const reply = (status) => async () => ({ status, headers: {}, text: '', buffer: Buffer.alloc(0) });
  const busy = createStore({ registry: 'http://r', image: 'o/r/actions-state', token: 'gh', request: reply(503) });
  await assert.rejects(busy.resolve('root'), (err) => err.retryable === true);
  const denied = createStore({ registry: 'http://r', image: 'o/r/actions-state', token: 'gh', request: reply(403) });
  await assert.rejects(denied.resolve('root'), (err) => err.retryable === false);
});

test('serialOf is null without the annotation', () => {
  assert.equal(serialOf({ annotations: {} }), null);
});
