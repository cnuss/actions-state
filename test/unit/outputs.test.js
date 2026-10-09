'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toStepOutputs } = require('../../src/outputs');

const outputs = {
  url: { value: 'https://x', sensitive: false },
  tags: { value: { a: 1, b: 'two' }, sensitive: false },
  count: { value: 3, sensitive: false },
  pw: { value: 'line1\nline2', sensitive: true },
};

test('toStepOutputs passes strings as-is and JSON-encodes other values', () => {
  const r = toStepOutputs(outputs);
  assert.deepEqual(r.entries, [['url', 'https://x'], ['tags', '{"a":1,"b":"two"}'], ['count', '3']]);
  assert.equal(r.json, '{"url":"https://x","tags":{"a":1,"b":"two"},"count":3}');
});

test('toStepOutputs leaves sensitive outputs out and lists their names', () => {
  const r = toStepOutputs(outputs);
  assert.deepEqual(r.sensitive, ['pw']);
  assert.deepEqual(r.masks, []);
  assert.ok(!r.json.includes('line1'));
});

test('toStepOutputs with includeSensitive passes them and masks every line', () => {
  const r = toStepOutputs(outputs, { includeSensitive: true });
  assert.deepEqual(r.entries.at(-1), ['pw', 'line1\nline2']);
  assert.deepEqual(r.sensitive, ['pw']);
  assert.deepEqual(r.masks, ['line1', 'line2']);
  assert.ok(r.json.includes('line1'));
});

test('toStepOutputs keeps outputs named like the action outputs only in json, and warns', () => {
  const names = ['json', 'sensitive', 'state-name', 'image', 'address'];
  const r = toStepOutputs(Object.fromEntries([...names, 'ok'].map((n) => [n, { value: n, sensitive: false }])));
  assert.deepEqual(r.entries, [['ok', 'ok']]);
  assert.deepEqual(Object.keys(JSON.parse(r.json)), [...names, 'ok']);
  assert.equal(r.warnings.length, names.length);
});

test('toStepOutputs with no outputs', () => {
  assert.deepEqual(toStepOutputs({}), { entries: [], json: '{}', sensitive: [], masks: [], warnings: [] });
});

test('toStepOutputs keeps nested maps and lists intact as JSON', () => {
  const nested = {
    envs: { value: { prod: { region: 'us-east-1', tags: { team: 'core' } }, dev: { region: 'us-west-2', tags: {} } }, sensitive: false },
    subnets: { value: [{ cidr: '10.0.0.0/24', zones: ['a', 'b'] }], sensitive: false },
    empty: { value: null, sensitive: false },
    flag: { value: true, sensitive: false },
  };
  const r = toStepOutputs(nested);
  const byName = Object.fromEntries(r.entries);
  assert.deepEqual(JSON.parse(byName.envs), nested.envs.value);
  assert.deepEqual(JSON.parse(byName.subnets), nested.subnets.value);
  assert.equal(byName.empty, 'null');
  assert.equal(byName.flag, 'true');
  assert.deepEqual(JSON.parse(r.json), Object.fromEntries(Object.entries(nested).map(([k, o]) => [k, o.value])));
});

test('toStepOutputs masks each line of a sensitive nested value', () => {
  const r = toStepOutputs({ creds: { value: { db: { user: 'u', pass: 'p@ss' } }, sensitive: true } }, { includeSensitive: true });
  assert.deepEqual(r.masks, ['{"db":{"user":"u","pass":"p@ss"}}']);
});
