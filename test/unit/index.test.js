'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { resolveConfig, jobPassword, claimRunfile, waitForServer, preflightActions, preflightPackages, needsWritePreflight, post, runOutputs, runScript, scriptEnv } = require('../../index');

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

function restAnswering(status) {
  const calls = [];
  const rest = async (method, p) => { calls.push(`${method} ${p}`); return { status, headers: {}, json: {}, text: '' }; };
  return { rest, calls };
}

test('preflightActions deletes a random missing key and passes on 404, 200 and 204', async () => {
  for (const status of [404, 200, 204]) {
    const { rest, calls } = restAnswering(status);
    const warnings = [];
    await preflightActions(rest, 'o/r', (m) => warnings.push(m));
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^DELETE \/repos\/o\/r\/actions\/caches\?key=actions-state-preflight-[0-9a-f]{16}$/);
    assert.deepEqual(warnings, []);
  }
});

test('preflightActions fails on 403 with the permission to add', async () => {
  await assert.rejects(preflightActions(restAnswering(403).rest, 'o/r', () => {}), /needs "permissions: actions: write" for state locks/);
});

test('preflightActions warns and continues on other statuses and network errors', async () => {
  const warnings = [];
  await preflightActions(restAnswering(500).rest, 'o/r', (m) => warnings.push(m));
  await preflightActions(async () => { throw new Error('ECONNRESET'); }, 'o/r', (m) => warnings.push(m));
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /HTTP 500/);
  assert.match(warnings[1], /ECONNRESET/);
});

test('preflightPackages passes, fails on a refused push, and warns on anything else', async () => {
  const warnings = [];
  await preflightPackages({ canPush: async () => true }, (m) => warnings.push(m));
  await assert.rejects(preflightPackages({ canPush: async () => false }, () => {}), /needs "permissions: packages: write" to save state/);
  await preflightPackages({ canPush: async () => { throw new Error('HTTP 502'); } }, (m) => warnings.push(m));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /HTTP 502/);
});

test('post finishes every cleanup step when the fallback deletes fail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-state-post-'));
  const runDir = path.join(dir, 'run');
  const workDir = path.join(dir, 'work');
  fs.mkdirSync(runDir);
  fs.mkdirSync(workDir);
  const runfile = path.join(runDir, 'root.json');
  fs.writeFileSync(runfile, JSON.stringify({ held: ['11', '12'] }));
  fs.writeFileSync(path.join(workDir, 'actions_state_override.tf'), 'terraform {}\n');
  fs.writeFileSync(path.join(runDir, 'root.log'), 'server says hi');
  const printed = [];
  await post({
    env: {
      STATE_runfile: runfile, STATE_working_directory: workDir, STATE_log_file: path.join(runDir, 'root.log'),
      GITHUB_API_URL: 'http://127.0.0.1:1', GITHUB_REPOSITORY: 'o/r', 'INPUT_GITHUB-TOKEN': 'gh',
    },
    print: (m) => printed.push(m),
  });
  const out = printed.join('\n');
  assert.match(out, /deleting lock entry 11 failed/);
  assert.match(out, /deleting lock entry 12 failed/);
  assert.match(out, /server says hi/);
  assert.equal(fs.existsSync(runfile), false);
  assert.equal(fs.existsSync(path.join(workDir, 'actions_state_override.tf')), false);
});

test('write-permission preflights run only where the job may save', () => {
  assert.equal(needsWritePreflight({ isDefaultRef: true, allowAnyRef: false }), true);
  assert.equal(needsWritePreflight({ isDefaultRef: false, allowAnyRef: true }), true);
  assert.equal(needsWritePreflight({ isDefaultRef: false, allowAnyRef: false }), false);
});

function readCommandFile(file) {
  const result = {};
  const re = /^(.+?)<<(ghadelimiter_[0-9a-f]+)\n([\s\S]*?)\n\2$/gm;
  for (const m of fs.readFileSync(file, 'utf8').matchAll(re)) result[m[1]] = m[3];
  return result;
}

async function stateServer(state, password) {
  const server = http.createServer((req, res) => {
    const auth = `Basic ${Buffer.from(`actions-state:${password}`).toString('base64')}`;
    if (req.headers.authorization !== auth) { res.statusCode = 401; return res.end(); }
    if (req.method !== 'GET' || req.url !== '/state') { res.statusCode = 404; return res.end(); }
    if (!state) { res.statusCode = 404; return res.end('no state yet'); }
    res.end(JSON.stringify(state));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

function outputsEnv(dir, extra = {}) {
  const output = path.join(dir, 'output');
  fs.writeFileSync(output, '');
  return { ...baseEnv, RUNNER_TEMP: dir, GITHUB_OUTPUT: output, 'INPUT_WORKING-DIRECTORY': 'infra', ...extra };
}

test('runOutputs sets step outputs from the served state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-out-'));
  const state = { version: 4, outputs: { url: { value: 'https://x' }, tags: { value: { a: { b: { c: [1, 'two'] } } } }, pw: { value: 's3cr3t', sensitive: true } } };
  const server = await stateServer(state, 'pw1');
  try {
    fs.mkdirSync(path.join(dir, 'actions-state'));
    fs.writeFileSync(path.join(dir, 'actions-state', 'password'), 'pw1');
    fs.writeFileSync(path.join(dir, 'actions-state', 'infra.json'), JSON.stringify({ port: server.address().port }));
    const env = outputsEnv(dir);
    const printed = [];
    await runOutputs({ env, print: (m) => printed.push(m) });
    assert.deepEqual(readCommandFile(env.GITHUB_OUTPUT), {
      url: 'https://x', tags: '{"a":{"b":{"c":[1,"two"]}}}', json: '{"url":"https://x","tags":{"a":{"b":{"c":[1,"two"]}}}}', sensitive: '["pw"]',
    });
    assert.ok(!printed.join('\n').includes('s3cr3t'));

    const env2 = outputsEnv(dir, { 'INPUT_INCLUDE-SENSITIVE': 'true' });
    const printed2 = [];
    await runOutputs({ env: env2, print: (m) => printed2.push(m) });
    assert.equal(readCommandFile(env2.GITHUB_OUTPUT).pw, 's3cr3t');
    assert.ok(printed2.includes('::add-mask::s3cr3t'));
  } finally {
    server.close();
  }
});

test('runOutputs with no state yet sets empty outputs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-out-'));
  const server = await stateServer(null, 'pw1');
  try {
    fs.mkdirSync(path.join(dir, 'actions-state'));
    fs.writeFileSync(path.join(dir, 'actions-state', 'password'), 'pw1');
    fs.writeFileSync(path.join(dir, 'actions-state', 'infra.json'), JSON.stringify({ port: server.address().port }));
    const env = outputsEnv(dir);
    await runOutputs({ env, print: () => {} });
    assert.deepEqual(readCommandFile(env.GITHUB_OUTPUT), { json: '{}', sensitive: '[]' });
  } finally {
    server.close();
  }
});

test('runOutputs fails when the state is not served in this job', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-out-'));
  await assert.rejects(runOutputs({ env: outputsEnv(dir), print: () => {} }), /state "infra" is not served in this job/);
});

test('scriptEnv passes the step env with the backend password and without action inputs', () => {
  const env = scriptEnv({ PATH: '/bin', CLOUDFLARE_API_TOKEN: 'cf', INPUT_PASSPHRASE: 'pp', 'INPUT_GITHUB-TOKEN': 'gh', INPUT_RUN: 'x' }, 'pw1');
  assert.deepEqual(env, { PATH: '/bin', CLOUDFLARE_API_TOKEN: 'cf', TF_HTTP_PASSWORD: 'pw1' });
});

test('runScript runs bash in the directory with the env and returns the exit code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-run-'));
  const code = await runScript('pwd > out\necho "$GREETING" >> out', { cwd: dir, env: { ...process.env, GREETING: 'hi' }, scriptDir: dir });
  assert.equal(code, 0);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'out'), 'utf8').split('\n'), [fs.realpathSync(dir), 'hi', '']);
});

test('runScript stops at the first failing command, pipelines included', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-run-'));
  assert.equal(await runScript('false\ntouch after-false', { cwd: dir, env: process.env, scriptDir: dir }), 1);
  assert.equal(fs.existsSync(path.join(dir, 'after-false')), false);
  assert.equal(await runScript('false | true\ntouch after-pipe', { cwd: dir, env: process.env, scriptDir: dir }), 1);
  assert.equal(fs.existsSync(path.join(dir, 'after-pipe')), false);
  assert.equal(await runScript('exit 7', { cwd: dir, env: process.env, scriptDir: dir }), 7);
});
