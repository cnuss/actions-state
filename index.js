'use strict';

// main checks the configuration, starts the state server and points Terraform
// at it; post stops the server and removes the override file. main and post are
// the same file: main saves STATE_post so the post run knows which it is.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { deriveName, tagSlug, imageName } = require('./src/core/names');
const { aadFor } = require('./src/core/crypto');
const { request, restClient } = require('./src/core/http');
const { createStore } = require('./src/core/store');
const { repoInfo, packageVisibility, findSelfJob } = require('./src/core/github');
const { getAdapter } = require('./src/adapters');

const REGISTRY = 'https://ghcr.io';
const START_TIMEOUT_MS = 10_000;
// Longer than the server's 10 s wait for requests still in flight.
const SHUTDOWN_TIMEOUT_MS = 30_000;

function log(msg) { process.stdout.write(`${msg}\n`); }
const warn = (msg) => log(`::warning::${msg}`);

function appendCommandFile(file, name, value) {
  if (!file) return;
  const delimiter = `ghadelimiter_${crypto.randomBytes(16).toString('hex')}`;
  fs.appendFileSync(file, `${name}<<${delimiter}\n${value ?? ''}\n${delimiter}\n`);
}
const setOutput = (name, value) => appendCommandFile(process.env.GITHUB_OUTPUT, name, value);
const saveState = (name, value) => appendCommandFile(process.env.GITHUB_STATE, name, value);
const exportVariable = (name, value) => appendCommandFile(process.env.GITHUB_ENV, name, value);

function input(env, name) { return (env[`INPUT_${name.toUpperCase()}`] || '').trim(); }

function resolveConfig(env) {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const dirInput = input(env, 'working-directory') || '.';
  const name = input(env, 'name') || deriveName(dirInput, workspace);
  const lockTimeout = input(env, 'lock-timeout') || '600';
  if (!/^\d+$/.test(lockTimeout)) throw new Error(`lock-timeout must be a whole number of seconds, got "${lockTimeout}"`);
  return {
    workingDirectory: path.resolve(workspace, dirInput),
    name,
    slug: tagSlug(name),
    repository: env.GITHUB_REPOSITORY,
    image: imageName(env.GITHUB_REPOSITORY),
    ref: env.GITHUB_REF,
    passphrase: input(env, 'passphrase'),
    lockTimeoutMs: Number(lockTimeout) * 1000,
    replaceBackend: input(env, 'replace-backend') === 'true',
    allowAnyRef: input(env, 'allow-apply-from-any-ref') === 'true',
    token: input(env, 'github-token'),
    runDir: path.join(env.RUNNER_TEMP || os.tmpdir(), 'actions-state'),
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    serverUrl: env.GITHUB_SERVER_URL || 'https://github.com',
  };
}

// One password per job: the first use of the action creates it, later uses
// reuse it, because TF_HTTP_PASSWORD is job-wide.
function jobPassword(runDir) {
  const file = path.join(runDir, 'password');
  try { return fs.readFileSync(file, 'utf8'); } catch { /* first use in this job */ }
  const password = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(file, password, { mode: 0o600 });
  return password;
}

function claimRunfile(runDir, slug, name) {
  const file = path.join(runDir, `${slug}.json`);
  try {
    fs.writeFileSync(file, '', { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error(`state "${name}" is already served in this job; give the second use a different name`);
    throw err;
  }
  return file;
}

async function waitForServer(runfile, logFile, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let run = null;
    try { run = JSON.parse(fs.readFileSync(runfile, 'utf8')); } catch { /* not written yet */ }
    if (run && run.error) throw new Error(run.error);
    if (run && run.port) return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  const serverLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no server log)';
  throw new Error(`state server did not start within ${timeoutMs / 1000}s:\n${serverLog}`);
}

// Deleting a key that cannot exist needs actions: write and changes nothing.
async function preflightActions(rest, repository, onWarning = warn) {
  const key = `actions-state-preflight-${crypto.randomBytes(8).toString('hex')}`;
  let r;
  try {
    r = await rest('DELETE', `/repos/${repository}/actions/caches?key=${encodeURIComponent(key)}`);
  } catch (err) {
    onWarning(`could not check for the actions: write permission: ${err.message}`);
    return;
  }
  if (r.status === 404 || r.status === 200 || r.status === 204) return;
  if (r.status === 403) throw new Error('the job needs "permissions: actions: write" for state locks');
  onWarning(`could not check for the actions: write permission: HTTP ${r.status}`);
}

// Plan-only jobs never save or take a real lock, so they need neither permission.
function needsWritePreflight({ isDefaultRef, allowAnyRef }) {
  return Boolean(isDefaultRef || allowAnyRef);
}

async function preflightPackages(store, onWarning = warn) {
  let ok;
  try {
    ok = await store.canPush();
  } catch (err) {
    onWarning(`could not check for the packages: write permission: ${err.message}`);
    return;
  }
  if (!ok) throw new Error('the job needs "permissions: packages: write" to save state');
}

function basicAuth(password) {
  return { Authorization: `Basic ${Buffer.from(`actions-state:${password}`).toString('base64')}` };
}

async function main() {
  saveState('post', 'true');
  const env = process.env;
  const cfg = resolveConfig(env);
  if (!cfg.token) throw new Error('input `github-token` is required');
  const adapter = getAdapter('terraform');
  adapter.check(cfg.workingDirectory, { replaceBackend: cfg.replaceBackend });

  const rest = restClient({ token: cfg.token, apiUrl: cfg.apiUrl });
  const repo = await repoInfo(rest, cfg.repository);
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const isDefaultRef = cfg.ref === defaultRef;
  if (!cfg.passphrase) {
    if (repo.visibility === 'public') {
      throw new Error(`${cfg.repository} is public, so its state package would be readable by anyone: set the passphrase input from a secret to encrypt state`);
    }
    const owner = cfg.repository.split('/')[0];
    const visibility = await packageVisibility(rest, { ownerType: repo.ownerType, owner, packageName: cfg.image.slice(owner.length + 1) });
    if (visibility === 'public') throw new Error(`ghcr.io/${cfg.image} is public: set the passphrase input from a secret to encrypt state`);
  }
  const job = await findSelfJob(rest, env);
  if (needsWritePreflight({ isDefaultRef, allowAnyRef: cfg.allowAnyRef })) {
    await preflightActions(rest, cfg.repository);
    await preflightPackages(createStore({ registry: REGISTRY, image: cfg.image, token: cfg.token }));
  }

  fs.mkdirSync(cfg.runDir, { recursive: true });
  const runfile = claimRunfile(cfg.runDir, cfg.slug, cfg.name);
  const logFile = path.join(cfg.runDir, `${cfg.slug}.log`);
  saveState('runfile', runfile);
  saveState('log_file', logFile);
  saveState('working_directory', cfg.workingDirectory);
  const password = jobPassword(cfg.runDir);
  log(`::add-mask::${password}`);

  const config = {
    runfile, apiUrl: cfg.apiUrl, registry: REGISTRY, repository: cfg.repository, ref: cfg.ref,
    slug: cfg.slug, name: cfg.name, image: cfg.image, adapter: adapter.name,
    identity: { run_id: env.GITHUB_RUN_ID, run_attempt: env.GITHUB_RUN_ATTEMPT, job_id: job.id, job_name: job.name, job_url: job.url, ref: cfg.ref },
    isDefaultRef, allowAnyRef: cfg.allowAnyRef, lockTimeoutMs: cfg.lockTimeoutMs, aad: aadFor(cfg.repository, cfg.name),
    meta: { runId: env.GITHUB_RUN_ID, sha: env.GITHUB_SHA, ref: cfg.ref, defaultRef, source: `${cfg.serverUrl}/${cfg.repository}` },
  };
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'src', 'server.js')], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...env, ACTIONS_STATE_CONFIG: JSON.stringify(config), ACTIONS_STATE_PASSWORD: password, ACTIONS_STATE_PASSPHRASE: cfg.passphrase, ACTIONS_STATE_TOKEN: cfg.token },
  });
  child.unref();
  fs.closeSync(out);

  const run = await waitForServer(runfile, logFile);
  const endpoint = `http://127.0.0.1:${run.port}`;
  const health = await request('GET', `${endpoint}/health`, basicAuth(password), null, { timeoutMs: 15_000 });
  if (health.status !== 200) throw new Error(`state server health check failed: HTTP ${health.status}`);

  adapter.wire(cfg.workingDirectory, { endpoint });
  exportVariable('TF_HTTP_PASSWORD', password);
  setOutput('state-name', cfg.name);
  setOutput('image', `ghcr.io/${cfg.image}`);
  setOutput('address', `${endpoint}/state`);
  const mode = isDefaultRef ? 'read/write' : cfg.allowAnyRef ? 'read/write (allow-apply-from-any-ref)' : 'plan only';
  log(`[actions-state] serving "${cfg.name}" from ghcr.io/${cfg.image}:${cfg.slug} (${mode}) at ${endpoint}`);
}

// Every step runs even when an earlier one fails.
async function post({ env = process.env, print = log } = {}) {
  const attempt = async (what, fn) => {
    try { await fn(); } catch (err) { print(`::warning::[actions-state] ${what} failed: ${err.message}`); }
  };
  const runfile = env.STATE_runfile;

  if (runfile && fs.existsSync(runfile)) {
    let run = {};
    try { run = JSON.parse(fs.readFileSync(runfile, 'utf8') || '{}'); } catch { /* server never wrote it */ }
    let password = '';
    try { password = fs.readFileSync(path.join(path.dirname(runfile), 'password'), 'utf8'); } catch { /* main failed early */ }

    let stopped = false;
    if (run.port && password) {
      try {
        stopped = (await request('POST', `http://127.0.0.1:${run.port}/shutdown`, basicAuth(password), null, { timeoutMs: SHUTDOWN_TIMEOUT_MS })).status === 200;
      } catch { /* server already gone */ }
    }
    if (!stopped) {
      const rest = restClient({ token: input(env, 'github-token'), apiUrl: env.GITHUB_API_URL || 'https://api.github.com' });
      for (const id of run.held || []) {
        await attempt(`deleting lock entry ${id}`, async () => {
          const r = await rest('DELETE', `/repos/${env.GITHUB_REPOSITORY}/actions/caches/${id}`);
          print(`[actions-state] deleted lock entry ${id}: HTTP ${r.status}`);
        });
      }
      if (run.pid) {
        await attempt(`stopping server process ${run.pid}`, () => {
          try { process.kill(run.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
        });
      }
    }
    await attempt('removing the runfile', () => fs.rmSync(runfile, { force: true }));
  }

  if (env.STATE_working_directory) {
    await attempt('removing the backend override', () => getAdapter('terraform').unwire(env.STATE_working_directory));
  }

  const logFile = env.STATE_log_file;
  await attempt('printing the server log', () => {
    if (!logFile || !fs.existsSync(logFile)) return;
    print('::group::actions-state server log');
    print(fs.readFileSync(logFile, 'utf8'));
    print('::endgroup::');
  });
}

module.exports = { resolveConfig, jobPassword, claimRunfile, waitForServer, preflightActions, preflightPackages, needsWritePreflight, post };

if (require.main === module) {
  const run = process.env.STATE_post === 'true' ? post : main;
  run().catch((err) => {
    log(`::error::${err.message}`);
    process.exitCode = 1;
  });
}
