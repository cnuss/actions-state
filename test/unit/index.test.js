'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveConfig, jobPassword, claimRunfile, waitForServer } = require('../../index');

const baseEnv = {
  GITHUB_WORKSPACE: '/w', GITHUB_REPOSITORY: 'CNuss/Thing', GITHUB_REF: 'refs/heads/main', RUNNER_TEMP: '/tmp/rt',
  'INPUT_GITHUB-TOKEN': 'gh', 'INPUT_LOCK-TIMEOUT': '600', 'INPUT_REPLACE-BACKEND': 'false', 'INPUT_ALLOW-APPLY-FROM-ANY-REF': 'false',
};

test('resolveConfig derives the name, slug and image', () => {
  const cfg = resolveConfig({ ...baseEnv, 'INPUT_WORKING-DIRECTORY': 'infra/zone' });
  assert.equal(cfg.workingDirectory, '/w/infra/zone');
  assert.equal(cfg.name, 'infra/zone');
  assert.equal(cfg.slug, 'infra-zone');
  assert.equal(cfg.image, 'cnuss/thing/actions-state');
  assert.equal(cfg.lockTimeoutMs, 600_000);
  assert.equal(cfg.replaceBackend, false);
  assert.equal(cfg.allowAnyRef, false);
  assert.equal(cfg.runDir, '/tmp/rt/actions-state');
});

test('resolveConfig: the name input overrides the derived name', () => {
  const cfg = resolveConfig({ ...baseEnv, INPUT_NAME: 'shared' });
  assert.equal(cfg.name, 'shared');
  assert.equal(cfg.workingDirectory, '/w');
});

test('resolveConfig: booleans and lock-timeout 0', () => {
  const cfg = resolveConfig({ ...baseEnv, 'INPUT_LOCK-TIMEOUT': '0', 'INPUT_REPLACE-BACKEND': 'true', 'INPUT_ALLOW-APPLY-FROM-ANY-REF': 'true' });
  assert.equal(cfg.lockTimeoutMs, 0);
  assert.equal(cfg.replaceBackend, true);
  assert.equal(cfg.allowAnyRef, true);
});

test('resolveConfig refuses a non-numeric lock-timeout', () => {
  assert.throws(() => resolveConfig({ ...baseEnv, 'INPUT_LOCK-TIMEOUT': '10m' }), /whole number of seconds/);
});

test('jobPassword is created once per job and reused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-state-pw-'));
  const first = jobPassword(dir);
  assert.match(first, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(jobPassword(dir), first);
});

test('claimRunfile refuses a second use of one state name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-state-run-'));
  assert.equal(claimRunfile(dir, 'root', 'root'), path.join(dir, 'root.json'));
  assert.throws(() => claimRunfile(dir, 'root', 'root'), /already served in this job/);
});

test('waitForServer returns the runfile once it has a port, and surfaces startup errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-state-wait-'));
  const runfile = path.join(dir, 'root.json');
  fs.writeFileSync(runfile, '');
  setTimeout(() => fs.writeFileSync(runfile, JSON.stringify({ pid: 1, port: 4000, held: [] })), 150);
  assert.equal((await waitForServer(runfile, path.join(dir, 'log'), 2000)).port, 4000);
  fs.writeFileSync(runfile, JSON.stringify({ pid: 1, error: 'decryption failed: wrong passphrase or tampered state' }));
  await assert.rejects(waitForServer(runfile, path.join(dir, 'log'), 2000), /wrong passphrase/);
});

test('waitForServer times out with the server log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-state-wait-'));
  fs.writeFileSync(path.join(dir, 'log'), 'boom');
  await assert.rejects(waitForServer(path.join(dir, 'none.json'), path.join(dir, 'log'), 300), /did not start[\s\S]*boom/);
});
