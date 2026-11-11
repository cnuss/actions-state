'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { planZip } = require('../fakes/zip');
const { reportPlan, appendSummary, pre, resolveConfig, jobPassword, claimRunfile, waitForServer, preflightActions, preflightPackages, needsWritePreflight, post, emitOutputs, writeSummary, fetchOutputs, runScript, scriptEnv, readStateOutputs, readOnlyRefusals } = require('../../index');

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

test('resolveConfig: include-sensitive is on unless it is false', () => {
  assert.equal(resolveConfig(baseEnv).includeSensitive, true);
  assert.equal(resolveConfig({ ...baseEnv, 'INPUT_INCLUDE-SENSITIVE': 'true' }).includeSensitive, true);
  assert.equal(resolveConfig({ ...baseEnv, 'INPUT_INCLUDE-SENSITIVE': 'false' }).includeSensitive, false);
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

function outputFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'as-out-')), 'output');
  fs.writeFileSync(file, '');
  return file;
}

const served = { version: 4, outputs: { url: { value: 'https://x' }, tags: { value: { a: { b: { c: [1, 'two'] } } } }, pw: { value: 's3cr3t', sensitive: true } } };

test('fetchOutputs reads the served state, and {} before the first save', async () => {
  const server = await stateServer(served, 'pw1');
  const empty = await stateServer(null, 'pw1');
  try {
    assert.deepEqual(await fetchOutputs(`http://127.0.0.1:${server.address().port}`, 'pw1'), {
      url: { value: 'https://x', sensitive: false }, tags: { value: { a: { b: { c: [1, 'two'] } } }, sensitive: false }, pw: { value: 's3cr3t', sensitive: true },
    });
    assert.deepEqual(await fetchOutputs(`http://127.0.0.1:${empty.address().port}`, 'pw1'), {});
    await assert.rejects(fetchOutputs(`http://127.0.0.1:${server.address().port}`, 'wrong'), /reading state failed: HTTP 401/);
  } finally {
    server.close();
    empty.close();
  }
});

test('emitOutputs with includeSensitive false leaves sensitive outputs out', () => {
  const file = outputFile();
  const printed = [];
  emitOutputs({ url: { value: 'https://x', sensitive: false }, tags: { value: { a: { b: [1] } }, sensitive: false }, pw: { value: 's3cr3t', sensitive: true } },
    { env: { GITHUB_OUTPUT: file }, print: (m) => printed.push(m), includeSensitive: false });
  assert.deepEqual(readCommandFile(file), { url: 'https://x', tags: '{"a":{"b":[1]}}', json: '{"url":"https://x","tags":{"a":{"b":[1]}}}', sensitive: '["pw"]' });
  assert.ok(!printed.join('\n').includes('s3cr3t'));
});

test('emitOutputs sets sensitive outputs by default, as-is and masked', () => {
  const file = outputFile();
  const printed = [];
  emitOutputs({ pw: { value: 's3cr3t', sensitive: true } }, { env: { GITHUB_OUTPUT: file }, print: (m) => printed.push(m) });
  assert.deepEqual(readCommandFile(file), { pw: 's3cr3t', json: '{"pw":"s3cr3t"}', sensitive: '["pw"]' });
  assert.equal(printed[0], '::add-mask::s3cr3t');
});

test('emitOutputs with no outputs sets empty json and sensitive', () => {
  const file = outputFile();
  emitOutputs({}, { env: { GITHUB_OUTPUT: file }, print: () => {} });
  assert.deepEqual(readCommandFile(file), { json: '{}', sensitive: '[]' });
});

test('resolveConfig turns the summary on by default', () => {
  assert.equal(resolveConfig(baseEnv).summary, true);
  assert.equal(resolveConfig({ ...baseEnv, INPUT_SUMMARY: 'false' }).summary, false);
});

test('writeSummary appends after what the step already wrote, without sensitive values', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'as-sum-')), 'summary.md');
  fs.writeFileSync(file, 'from the script\n');
  const printed = [];
  writeSummary({ url: { value: 'https://x', sensitive: false }, pw: { value: 's3cr3t', sensitive: true } },
    { env: { GITHUB_STEP_SUMMARY: file }, print: (m) => printed.push(m), name: 'root' });
  const md = fs.readFileSync(file, 'utf8');
  assert.ok(md.startsWith('from the script\n\n## Terraform outputs · `root`\n'));
  assert.ok(md.includes('`https://x`'));
  assert.ok(!md.includes('s3cr3t'));
  assert.deepEqual(printed, []);
});

test('writeSummary writes nothing without outputs', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'as-sum-')), 'summary.md');
  writeSummary({}, { env: { GITHUB_STEP_SUMMARY: file }, print: () => {}, name: 'root' });
  assert.equal(fs.existsSync(file), false);
});

test('writeSummary warns instead of throwing when it cannot write', () => {
  const printed = [];
  writeSummary({ url: { value: 'https://x', sensitive: false } },
    { env: { GITHUB_STEP_SUMMARY: fs.mkdtempSync(path.join(os.tmpdir(), 'as-sum-')) }, print: (m) => printed.push(m), name: 'root' });
  assert.equal(printed.length, 1);
  assert.match(printed[0], /^::warning::\[actions-state\] writing the step summary failed: /);
});

test('writeSummary warns when the step summary is already full', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'as-sum-')), 'summary.md');
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024));
  const printed = [];
  writeSummary({ url: { value: 'https://x', sensitive: false } }, { env: { GITHUB_STEP_SUMMARY: file }, print: (m) => printed.push(m), name: 'root' });
  assert.deepEqual(printed, ['::warning::[actions-state] writing the step summary failed: the step summary is full']);
  assert.equal(fs.statSync(file).size, 1024 * 1024);
});

test('scriptEnv passes the step env with the backend password and without action inputs', () => {
  const env = scriptEnv({ PATH: '/bin', CLOUDFLARE_API_TOKEN: 'cf', INPUT_PASSPHRASE: 'pp', 'INPUT_GITHUB-TOKEN': 'gh', INPUT_RUN: 'x' }, 'pw1');
  assert.deepEqual(env, { PATH: '/bin', CLOUDFLARE_API_TOKEN: 'cf', TF_HTTP_PASSWORD: 'pw1' });
});

test('scriptEnv adds the extra variables', () => {
  assert.deepEqual(scriptEnv({ PATH: '/bin' }, 'pw1', { TF_CLI_ARGS_plan: '-out=x' }), { PATH: '/bin', TF_HTTP_PASSWORD: 'pw1', TF_CLI_ARGS_plan: '-out=x' });
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

test('resolveConfig: repository names another repo whose state is read, not served', () => {
  const cfg = resolveConfig({ ...baseEnv, INPUT_REPOSITORY: 'CNuss/Infra', INPUT_NAME: 'terraform' });
  assert.equal(cfg.source, 'CNuss/Infra');
  assert.equal(cfg.readOnly, true);
  assert.equal(cfg.image, 'cnuss/infra/actions-state');
  assert.equal(cfg.aad, 'CNuss/Infra:terraform');
});

test('resolveConfig: repository naming this repo, in any case, serves as usual', () => {
  for (const env of [baseEnv, { ...baseEnv, INPUT_REPOSITORY: 'cnuss/thing' }]) {
    const cfg = resolveConfig(env);
    assert.equal(cfg.readOnly, false);
    assert.equal(cfg.image, 'cnuss/thing/actions-state');
    assert.equal(cfg.aad, 'CNuss/Thing:root');
  }
});

test('readStateOutputs reads the newest version of another repo\'s state, decrypting it', async (t) => {
  const { startFakeRegistry } = require('../fakes/registry');
  const { createStore, annotationsFor } = require('../../src/core/store');
  const box = require('../../src/core/crypto');
  const reg = await startFakeRegistry();
  t.after(() => reg.close());
  const image = 'o/infra/actions-state';
  const writer = createStore({ registry: reg.url, image, token: 'gh' });
  const state = (url) => Buffer.from(JSON.stringify({ version: 4, serial: 2, outputs: { url: { value: url, type: 'string' }, key: { value: 'k', sensitive: true } } }));
  const put = (name, bytes, tag = 'terraform') => writer.push({
    bytes, mediaType: 'application/vnd.cnuss.actions-state.tfstate.v1',
    annotations: annotationsFor({ name, serial: 2, source: 'https://github.com/o/infra' }), tags: [tag],
  });
  const reader = createStore({ registry: reg.url, image, token: 'gh', access: 'pull' });
  const read = (opts = {}) => readStateOutputs({ store: reader, slug: 'terraform', name: 'terraform', passphrase: '', aad: 'o/infra:terraform', ...opts });

  await assert.rejects(read(), /no state "terraform" at .*o\/infra\/actions-state:terraform/);

  await put('terraform', state('https://a'));
  assert.deepEqual(await read(), { url: { value: 'https://a', sensitive: false }, key: { value: 'k', sensitive: true } });
  assert.ok(reg.scopes.includes('repository:o/infra/actions-state:pull'));

  await put('terraform', box.encrypt(state('https://b'), 'pw', 'o/infra:terraform'));
  await assert.rejects(read(), /encrypted: set the passphrase input/);
  assert.equal((await read({ passphrase: 'pw' })).url.value, 'https://b');
  await assert.rejects(read({ passphrase: 'pw', aad: 'o/other:terraform' }), /decryption failed/);

  await put('other', state('https://c'));
  await assert.rejects(read(), /holds state "other", not "terraform"/);
});

test('readOnlyRefusals: run needs the state served from this repository', () => {
  assert.throws(() => readOnlyRefusals({ source: 'o/infra', run: 'terraform plan' }), /`run` needs the state served from this repository; o\/infra's state is only read/);
  assert.doesNotThrow(() => readOnlyRefusals({ source: 'o/infra', run: '' }));
});

// The REST calls pre makes before the lock: the repository and this job.
function preRest(fake, { defaultBranch = 'main', jobId = 7 } = {}) {
  return async (method, p) => {
    if (method === 'GET' && p === '/repos/o/r') return { status: 200, json: { visibility: 'private', default_branch: defaultBranch, owner: { type: 'User' } }, text: '' };
    if (method === 'GET' && p.startsWith('/repos/o/r/actions/runs/')) {
      return { status: 200, json: { jobs: [{ id: jobId, name: 'deploy', html_url: `https://github.com/o/r/actions/runs/1/job/${jobId}`, runner_name: 'r1', status: 'in_progress' }] }, text: '' };
    }
    return fake.rest(method, p);
  };
}

function preEnv(stateFile, overrides = {}) {
  return {
    GITHUB_WORKSPACE: '/w', GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1',
    RUNNER_NAME: 'r1', RUNNER_TEMP: fs.mkdtempSync(path.join(os.tmpdir(), 'as-pre-')), GITHUB_STATE: stateFile, 'INPUT_GITHUB-TOKEN': 'gh', 'INPUT_LOCK-TIMEOUT': '0', ...overrides,
  };
}

test('pre takes the state lock for the job and saves it for main and post', async () => {
  const { createFakeCache } = require('../fakes/cache');
  const { createLock } = require('../../src/core/lock');
  const fake = createFakeCache();
  const lockFor = ({ rest, identity, cfg }) => createLock({ twirp: fake.twirp, rest, blobs: fake.blobs, repository: 'o/r', ref: cfg.ref, slug: cfg.slug, identity, sleep: async () => {} });
  const stateFile = outputFile();
  const env = preEnv(stateFile);
  const held = await pre({ env, rest: preRest(fake), lockFor, print: () => {} });
  assert.equal(held.id, 'job-1-1-7');
  assert.deepEqual(JSON.parse(readCommandFile(stateFile).job_lock), held);
  const current = await lockFor({ rest: fake.rest, identity: {}, cfg: { ref: 'refs/heads/main', slug: 'root' } }).readCurrent();
  assert.equal(current.entryId, held.entryId);
  assert.equal(current.holder.lockInfo.Operation, 'OperationTypeJob');
  assert.equal(current.holder.identity.job_id, 7);

  // A second use of the same name in this job takes nothing (main refuses it) instead of waiting on itself.
  assert.equal(await pre({ env: { ...env, GITHUB_STATE: outputFile() }, rest: preRest(fake), lockFor, print: () => {} }), null);

  // A second job waits, and with lock-timeout 0 fails naming the holder.
  await assert.rejects(
    pre({ env: preEnv(outputFile(), { GITHUB_RUN_ID: '2' }), rest: preRest(fake, { jobId: 8 }), lockFor, print: () => {} }),
    /the lock on "root" is still held by deploy \(run 1\) after 0s/,
  );
});

test('pre takes no lock where the job may only plan, or only reads another repository', async () => {
  const { createFakeCache } = require('../fakes/cache');
  const fake = createFakeCache();
  const lockFor = () => { throw new Error('no lock expected'); };
  const stateFile = outputFile();
  assert.equal(await pre({ env: preEnv(stateFile, { GITHUB_REF: 'refs/pull/1/merge' }), rest: preRest(fake), lockFor, print: () => {} }), null);
  assert.equal(await pre({ env: preEnv(stateFile, { INPUT_REPOSITORY: 'o/infra' }), rest: preRest(fake), lockFor, print: () => {} }), null);
  assert.equal(readCommandFile(stateFile).job_lock, undefined);
});

test('post releases the job\'s lock, entry and holder record', async () => {
  const deleted = [];
  const api = http.createServer((req, res) => { deleted.push(`${req.method} ${req.url}`); res.statusCode = 204; res.end(); });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const printed = [];
  await post({
    env: {
      STATE_job_lock: JSON.stringify({ id: 'job-1-1-7', entryId: '21', holderId: '22' }),
      GITHUB_API_URL: `http://127.0.0.1:${api.address().port}`, GITHUB_REPOSITORY: 'o/r', 'INPUT_GITHUB-TOKEN': 'gh',
    },
    print: (m) => printed.push(m),
  });
  await new Promise((r) => api.close(r));
  assert.deepEqual(deleted, ['DELETE /repos/o/r/actions/caches/21', 'DELETE /repos/o/r/actions/caches/22']);
  assert.match(printed.join('\n'), /released the job's lock \(job-1-1-7\)/);
});

test('appendSummary warns when what it renders does not fit', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'as-sum-')), 'summary.md');
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024 - 3));
  const printed = [];
  appendSummary(() => 'too long', { env: { GITHUB_STEP_SUMMARY: file }, print: (m) => printed.push(m) });
  assert.deepEqual(printed, ['::warning::[actions-state] writing the step summary failed: the step summary is full']);
});

// A working directory with a saved plan, fake plan tools and a fake REST API.
function planSetup({ plan, event = null, report = '# Report\n\n## Summary\n\nrendered\n', installFails = false, routes = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-report-'));
  const workingDirectory = path.join(dir, 'work');
  const runDir = path.join(dir, 'run');
  fs.mkdirSync(workingDirectory);
  fs.mkdirSync(runDir);
  fs.writeFileSync(path.join(workingDirectory, 'actions_state.tfplan'), planZip(41));
  const summary = path.join(dir, 'summary.md');
  const eventFile = path.join(dir, 'event.json');
  if (event) fs.writeFileSync(eventFile, JSON.stringify(event));
  const calls = [];
  const tool = { file: '/bin/terraform', kind: 'terraform' };
  const tools = {
    showPlan: async (file, opts) => { calls.push(['showPlan', path.basename(file), opts.cwd, opts.env.TF_HTTP_PASSWORD, opts.env.INPUT_PASSPHRASE]); return { tool, plan }; },
    showText: async () => { calls.push(['showText']); return 'Terraform will perform the following actions:\n  ~ resource "x" "a" {}\n'; },
    installTfplan2md: async ({ cacheDir }) => { calls.push(['install', cacheDir]); if (installFails) throw new Error('no build'); return '/bin/tfplan2md'; },
    tfplan2md: async (bin, p, opts) => { calls.push(['tfplan2md', opts.template || 'default']); return report; },
  };
  const restCalls = [];
  const rest = async (method, p, body) => {
    restCalls.push({ call: `${method} ${p}`, body });
    const route = routes[`${method} ${p}`];
    const [status, json] = route || [404, {}];
    return { status, json, text: JSON.stringify(json) };
  };
  const env = {
    GITHUB_STEP_SUMMARY: summary, GITHUB_SHA: 'mergesha0000', GITHUB_RUN_ID: '9', RUNNER_TOOL_CACHE: path.join(dir, 'cache'),
    INPUT_PASSPHRASE: 'pp-secret', ...(event ? { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventFile } : { GITHUB_EVENT_NAME: 'push' }),
  };
  const cfg = {
    workingDirectory, runDir, name: 'infra', repository: 'o/r', serverUrl: 'https://github.com', summary: true, token: 'ghs_tokenvalue', passphrase: 'pp-secret',
  };
  return { cfg, env, tools, rest, calls, restCalls, summary, workingDirectory };
}

const changedPlan = {
  resource_changes: [{ address: 'x.a', change: { actions: ['update'], before: { pw: 'old-secret' }, before_sensitive: { pw: true }, after: {}, after_sensitive: {} } }],
};
const pr = { pull_request: { number: 5, head: { sha: 'headsha1234567' } } };

test('reportPlan renders the plan to the step summary and comments it on the pull request', async () => {
  const s = planSetup({
    plan: changedPlan, event: pr, report: '# Report\n\nrendered old-secret and ghs_tokenvalue\n',
    routes: {
      'GET /repos/o/r/issues/5/comments?per_page=100&page=1': [200, []],
      'POST /repos/o/r/issues/5/comments': [201, { html_url: 'https://github.com/o/r/pull/5#issuecomment-1' }],
    },
  });
  const printed = [];
  const r = await reportPlan({ cfg: s.cfg, env: s.env, password: 'pw', jobUrl: 'https://github.com/o/r/actions/runs/9/job/3', rest: s.rest, print: (m) => printed.push(m), tools: s.tools });
  assert.equal(r.changes, true);
  assert.equal(r.url, 'https://github.com/o/r/pull/5#issuecomment-1');
  assert.match(r.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(s.calls, [
    ['showPlan', 'actions_state.tfplan', s.workingDirectory, 'pw', undefined],
    ['install', s.env.RUNNER_TOOL_CACHE],
    ['tfplan2md', 'default'],
  ]);
  const body = s.restCalls.at(-1).body.body;
  assert.ok(body.startsWith('<!-- actions-state:plan:infra -->\n## Terraform plan · `infra`\n\n**Plan: 0 to add, 1 to change, 0 to destroy.**\n'));
  assert.match(body, /\nrendered \*\*\* and \*\*\*\n/);
  assert.match(body, /state serial 41 · commit \[`headsha`\]\(https:\/\/github\.com\/o\/r\/commit\/headsha1234567\) · \[workflow run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/9\/job\/3\)/);
  assert.equal(fs.readFileSync(s.summary, 'utf8'), body);
  assert.match(printed.join('\n'), /created the plan comment on #5: https:\/\/github\.com\/o\/r\/pull\/5#issuecomment-1/);
  assert.equal(await reportPlan({ cfg: s.cfg, env: s.env, password: 'pw', skipDigest: r.digest, rest: s.rest, print: () => {}, tools: s.tools }), null);
});

test('reportPlan shows the plan as text when tfplan2md cannot run, and only logs a token that may not comment', async () => {
  const s = planSetup({
    plan: changedPlan, event: pr, installFails: true,
    routes: { 'GET /repos/o/r/issues/5/comments?per_page=100&page=1': [200, []], 'POST /repos/o/r/issues/5/comments': [403, {}] },
  });
  const printed = [];
  const r = await reportPlan({ cfg: s.cfg, env: s.env, rest: s.rest, print: (m) => printed.push(m), tools: s.tools });
  assert.deepEqual(r && { changes: r.changes, url: r.url }, { changes: true, url: '' });
  assert.deepEqual(s.calls.map((c) => c[0]), ['showPlan', 'install', 'showText']);
  assert.match(fs.readFileSync(s.summary, 'utf8'), /```diff\nTerraform will perform the following actions:\n!   resource "x" "a" \{\}\n```/);
  const out = printed.join('\n');
  assert.match(out, /tfplan2md is not available, so the plan is shown as text: no build/);
  assert.match(out, /not commenting on #5: the token may not write pull request comments \(permissions: pull-requests: write\)/);
  assert.doesNotMatch(out, /::warning::/);
});

test('reportPlan adds no comment for a plan without changes but updates an earlier one', async () => {
  const noChanges = { resource_changes: [{ address: 'x.a', change: { actions: ['no-op'] } }] };
  const none = planSetup({ plan: noChanges, event: pr, routes: { 'GET /repos/o/r/issues/5/comments?per_page=100&page=1': [200, []] } });
  const printed = [];
  const r = await reportPlan({ cfg: none.cfg, env: none.env, rest: none.rest, print: (m) => printed.push(m), tools: none.tools });
  assert.equal(r.changes, false);
  assert.deepEqual(none.calls.map((c) => c[0]), ['showPlan']);
  assert.deepEqual(none.restCalls.map((c) => c.call), ['GET /repos/o/r/issues/5/comments?per_page=100&page=1']);
  assert.match(printed.join('\n'), /no changes, so no comment on #5/);

  const earlier = planSetup({
    plan: noChanges, event: pr,
    routes: {
      'GET /repos/o/r/issues/5/comments?per_page=100&page=1': [200, [{ id: 8, body: '<!-- actions-state:plan:infra -->\nold plan' }]],
      'PATCH /repos/o/r/issues/comments/8': [200, { html_url: 'u8' }],
    },
  });
  const updated = await reportPlan({ cfg: earlier.cfg, env: earlier.env, rest: earlier.rest, print: () => {}, tools: earlier.tools });
  assert.equal(updated.url, 'u8');
  assert.match(earlier.restCalls.at(-1).body.body, /\*\*No changes\.\*\*/);
});

test('reportPlan outside a pull request writes only the step summary, and nothing without a new plan', async () => {
  const s = planSetup({ plan: changedPlan, routes: {} });
  s.cfg.summary = true;
  const r = await reportPlan({ cfg: s.cfg, env: s.env, rest: s.rest, print: () => {}, tools: s.tools });
  assert.equal(r.url, '');
  assert.deepEqual(s.restCalls, []);
  assert.match(fs.readFileSync(s.summary, 'utf8'), /commit \[`mergesh`\]\(https:\/\/github\.com\/o\/r\/commit\/mergesha0000\) · \[workflow run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/9\)/);
  assert.equal(await reportPlan({ cfg: s.cfg, env: s.env, since: Date.now() + 60_000, rest: s.rest, print: () => {}, tools: s.tools }), null);
  s.cfg.summary = false;
  fs.rmSync(s.summary);
  await reportPlan({ cfg: s.cfg, env: s.env, rest: s.rest, print: () => {}, tools: s.tools });
  assert.equal(fs.existsSync(s.summary), false);
});

test('post reports a plan saved after main, before it stops the server, then removes it', async () => {
  const s = planSetup({ plan: changedPlan });
  const order = [];
  const server = http.createServer((req, res) => { order.push(`server ${req.url}`); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const runfile = path.join(s.cfg.runDir, 'infra.json');
  fs.writeFileSync(runfile, JSON.stringify({ port: server.address().port }));
  fs.writeFileSync(path.join(s.cfg.runDir, 'password'), 'pw');
  const tools = { ...s.tools, showPlan: async (...a) => { order.push('showPlan'); return s.tools.showPlan(...a); } };
  await post({
    env: {
      ...s.env, STATE_runfile: runfile, STATE_working_directory: s.workingDirectory, STATE_plan_since: '0',
      GITHUB_WORKSPACE: path.dirname(s.workingDirectory), 'INPUT_WORKING-DIRECTORY': 'work', GITHUB_REPOSITORY: 'o/r',
      'INPUT_GITHUB-TOKEN': 'gh', GITHUB_API_URL: 'http://127.0.0.1:1', RUNNER_TEMP: path.dirname(s.cfg.runDir),
    },
    print: () => {},
    tools,
  });
  await new Promise((r) => server.close(r));
  assert.deepEqual(order, ['showPlan', 'server /shutdown']);
  assert.match(fs.readFileSync(s.summary, 'utf8'), /^<!-- actions-state:plan:work -->\n/);
  assert.equal(fs.existsSync(path.join(s.workingDirectory, 'actions_state.tfplan')), false);
});
