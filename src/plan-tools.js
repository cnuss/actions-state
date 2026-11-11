'use strict';

// The programs a plan is rendered with: terraform or tofu for `show`, and a
// pinned tfplan2md release, checked against its SHA-256 before it runs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { request, BLOB_TIMEOUT_MS } = require('./core/http');

const TFPLAN2MD = {
  version: '1.48.0',
  sha256: {
    'linux-x64': '31e086e167dc5978fc1a40c752dfd7df1df5fdc8708fd9e2a4c56dd603660139',
    'linux-arm64': 'd5f5a481eeb49bff3255a0c1ec3fb512f40d999924702589b2003d5acca06d4b',
    'macos-arm64': '29d7ad6ad92884b1ebb4162517f8bfc3e2aed909db48a0f6f1495731fabb20db',
  },
};
const MAX_OUTPUT = 512 * 1024 * 1024;
const RUN_TIMEOUT_MS = 5 * 60_000;

// The setup-terraform and setup-opentofu wrappers print more than the tool
// does, so the real binaries they keep beside them come first.
const TOOLS = [['terraform-bin', 'terraform'], ['terraform', 'terraform'], ['tofu-bin', 'tofu'], ['tofu', 'tofu']];

function which(name, pathVar = process.env.PATH || '') {
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch { /* not here */ }
  }
  return null;
}

// Every terraform or tofu on PATH, in TOOLS order, one per kind of binary file.
function findTools(pathVar) {
  const seen = new Set();
  const found = [];
  for (const [bin, kind] of TOOLS) {
    const file = which(bin, pathVar);
    if (!file) continue;
    let real = file;
    try { real = fs.realpathSync(file); } catch { /* keep the path */ }
    if (seen.has(real)) continue;
    seen.add(real);
    found.push({ file, kind });
  }
  return found;
}

function run(file, args, { cwd, env, timeoutMs = RUN_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, maxBuffer: MAX_OUTPUT, timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr: stderr || (err && !stdout ? err.message : '') });
    });
  });
}

// `show -json` with the first tool that can read the plan: terraform fails
// on a plan tofu wrote, and the other way round.
async function showPlan(planFile, { cwd, env, tools = findTools(env.PATH) }) {
  if (!tools.length) throw new Error('neither terraform nor tofu is on PATH');
  const errors = [];
  for (const tool of tools) {
    const r = await run(tool.file, ['show', '-json', planFile], { cwd, env });
    if (r.code === 0) {
      try { return { tool, plan: JSON.parse(r.stdout) }; } catch (err) { errors.push(`${tool.file}: ${err.message}`); continue; }
    }
    errors.push(`${tool.file}: ${(r.stderr || '').trim().split('\n').pop() || `exit ${r.code}`}`);
  }
  throw new Error(`could not read the plan: ${errors.join('; ')}`);
}

async function showText(tool, planFile, { cwd, env }) {
  const r = await run(tool.file, ['show', '-no-color', planFile], { cwd, env });
  if (r.code !== 0) throw new Error(`${tool.file} show: ${(r.stderr || '').trim() || `exit ${r.code}`}`);
  return r.stdout;
}

function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) return `linux-${arch}`;
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64';
  return null;
}

// Release assets redirect to a signed download URL.
async function download(url, { get = request, hops = 5 } = {}) {
  for (let i = 0, next = url; i <= hops; i += 1) {
    if (!next.startsWith('https://')) throw new Error(`refusing a non-https download: ${next}`);
    const r = await get('GET', next, { 'User-Agent': 'actions-state' }, null, { timeoutMs: BLOB_TIMEOUT_MS });
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      next = new URL(r.headers.location, next).toString();
      continue;
    }
    if (r.status !== 200) throw new Error(`downloading ${url}: HTTP ${r.status}`);
    return r.buffer;
  }
  throw new Error(`downloading ${url}: too many redirects`);
}

// The tfplan2md binary, from `cacheDir` when an earlier job left it there.
async function installTfplan2md({ cacheDir, platform, arch, get, extract = untar } = {}) {
  const key = platformKey(platform, arch);
  if (!key) throw new Error(`no tfplan2md build for ${platform || process.platform}-${arch || process.arch}`);
  const dir = path.join(cacheDir, 'tfplan2md', TFPLAN2MD.version, key);
  const bin = path.join(dir, 'tfplan2md');
  if (fs.existsSync(bin)) return bin;
  const asset = `tfplan2md_${TFPLAN2MD.version}_${key}.tar.gz`;
  const bytes = await download(`https://github.com/oocx/tfplan2md/releases/download/v${TFPLAN2MD.version}/${asset}`, { get });
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== TFPLAN2MD.sha256[key]) throw new Error(`${asset} has SHA-256 ${digest}, expected ${TFPLAN2MD.sha256[key]}`);
  const tmp = fs.mkdtempSync(path.join(cacheDir, '.tfplan2md-'));
  try {
    const archive = path.join(tmp, asset);
    fs.writeFileSync(archive, bytes);
    await extract(archive, tmp);
    const extracted = path.join(tmp, 'tfplan2md');
    if (!fs.existsSync(extracted)) throw new Error(`${asset} has no tfplan2md binary`);
    fs.chmodSync(extracted, 0o755);
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(extracted, bin);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return bin;
}

async function untar(archive, dir) {
  const r = await run('tar', ['-xzf', archive, '-C', dir]);
  if (r.code !== 0) throw new Error(`extracting ${path.basename(archive)}: ${r.stderr.trim()}`);
}

// Markdown for a `show -json` document. The JSON holds secrets, so its file
// is private to the user and removed at once. Drift is shown only for
// resources the plan changes, as Terraform's own plan output does.
async function tfplan2md(bin, plan, { tmpDir = os.tmpdir(), template } = {}) {
  const file = path.join(tmpDir, `plan-${crypto.randomBytes(8).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify(plan), { mode: 0o600 });
  try {
    const args = ['--render-target', 'github', '--hide-metadata', '--hide-unchanged-outputs', '--drift', 'relevant'];
    if (template) args.push('--template', template);
    const r = await run(bin, [...args, file], { env: { PATH: process.env.PATH || '', HOME: os.tmpdir() } });
    if (r.code !== 0) throw new Error(`tfplan2md exited with ${r.code}: ${(r.stderr || '').trim()}`);
    return r.stdout;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

module.exports = { TFPLAN2MD, which, findTools, run, showPlan, showText, platformKey, download, installTfplan2md, tfplan2md };
