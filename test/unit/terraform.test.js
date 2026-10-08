'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getAdapter } = require('../../src/adapters');

const tf = getAdapter('terraform');

function tmpdir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-state-tf-'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

test('no backend declared', () => {
  assert.deepEqual(tf.findBackends(tmpdir({ 'main.tf': 'resource "terraform_data" "x" {}\n' })), []);
});

test('detects backend and cloud blocks', () => {
  const dir = tmpdir({
    'a.tf': 'terraform {\n  backend "s3" {\n    bucket = "b"\n  }\n}\n',
    'b.tf': 'terraform {\n  cloud {\n    organization = "o"\n  }\n}\n',
  });
  assert.deepEqual(tf.findBackends(dir), [{ file: 'a.tf', type: 's3' }, { file: 'b.tf', type: 'cloud' }]);
});

test('ignores commented-out backends', () => {
  const src = '# backend "s3" {}\nterraform {\n  // backend "gcs" {}\n  /* backend "azurerm" {} */\n  required_version = ">= 1.4"\n}\n';
  assert.deepEqual(tf.findBackends(tmpdir({ 'main.tf': src })), []);
});

test('a # inside a string is not a comment', () => {
  const src = 'terraform {\n  required_version = "#1"\n  backend "local" {}\n}\n';
  assert.deepEqual(tf.findBackends(tmpdir({ 'main.tf': src })), [{ file: 'main.tf', type: 'local' }]);
});

test('only terraform blocks count', () => {
  assert.deepEqual(tf.findBackends(tmpdir({ 'main.tf': 'resource "x" "y" {\n  backend "s3" {}\n}\n' })), []);
});

test('reads .tf.json and .tofu files', () => {
  const dir = tmpdir({
    'main.tf.json': JSON.stringify({ terraform: [{ backend: [{ s3: {} }] }] }),
    'x.tofu': 'terraform {\n  backend "http" {}\n}\n',
  });
  assert.deepEqual(tf.findBackends(dir), [{ file: 'main.tf.json', type: 's3' }, { file: 'x.tofu', type: 'http' }]);
});

test('the override file this action writes is not counted', () => {
  const dir = tmpdir({ [tf.OVERRIDE_FILE]: tf.overrideHcl('http://127.0.0.1:1') });
  assert.deepEqual(tf.findBackends(dir), []);
});

test('check refuses a declared backend unless replace-backend', () => {
  const dir = tmpdir({ 'a.tf': 'terraform {\n  backend "s3" {}\n}\n' });
  assert.throws(() => tf.check(dir, {}), /already declares a backend: s3 \(a\.tf\).*replace-backend: true/);
  assert.doesNotThrow(() => tf.check(dir, { replaceBackend: true }));
});

test('check refuses a missing directory', () => {
  assert.throws(() => tf.check('/nonexistent/actions-state', {}), /does not exist/);
});

test('wire writes the override and excludes it from git; unwire removes it', () => {
  const repo = tmpdir({ '.git/info/.keep': '', 'infra/main.tf': '' });
  const dir = path.join(repo, 'infra');
  assert.deepEqual(tf.wire(dir, { endpoint: 'http://127.0.0.1:5000' }), {});
  const hcl = fs.readFileSync(path.join(dir, tf.OVERRIDE_FILE), 'utf8');
  assert.match(hcl, /backend "http"/);
  assert.match(hcl, /address\s+= "http:\/\/127\.0\.0\.1:5000\/state"/);
  assert.match(hcl, /lock_address\s+= "http:\/\/127\.0\.0\.1:5000\/lock"/);
  assert.match(hcl, /unlock_address\s+= "http:\/\/127\.0\.0\.1:5000\/lock"/);
  assert.match(hcl, /username\s+= "actions-state"/);
  tf.wire(dir, { endpoint: 'http://127.0.0.1:5000' });
  assert.equal(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8'), '/infra/actions_state_override.tf\n');
  tf.unwire(dir);
  assert.equal(fs.existsSync(path.join(dir, tf.OVERRIDE_FILE)), false);
});

test('wire works outside git and when .git is a file', () => {
  assert.doesNotThrow(() => tf.wire(tmpdir({ 'main.tf': '' }), { endpoint: 'http://127.0.0.1:1' }));
  assert.doesNotThrow(() => tf.wire(tmpdir({ '.git': 'gitdir: /elsewhere\n', 'main.tf': '' }), { endpoint: 'http://127.0.0.1:1' }));
});

test('stateMeta reads serial and lineage', () => {
  assert.deepEqual(tf.stateMeta(Buffer.from('{"version":4,"serial":12,"lineage":"abc"}')), { serial: 12, lineage: 'abc' });
});

test('stateMeta defaults missing fields', () => {
  assert.deepEqual(tf.stateMeta(Buffer.from('{"version":4}')), { serial: 0, lineage: '' });
});

test('stateMeta throws on non-JSON', () => {
  assert.throws(() => tf.stateMeta(Buffer.from('not json')));
});

test('stateMeta throws on JSON that is not a state object', () => {
  for (const body of ['{}', '[]', '123', '"x"', 'true', 'null', '{"version":"4"}']) {
    assert.throws(() => tf.stateMeta(Buffer.from(body)), /not a state file/, body);
  }
});
