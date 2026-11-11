'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const tools = require('../../src/plan-tools');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'as-tools-'));
function script(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return file;
}

test('findTools prefers the real binaries behind setup wrappers and skips duplicates', () => {
  const a = tmp();
  const b = tmp();
  script(a, 'terraform', 'exit 0');
  script(a, 'terraform-bin', 'exit 0');
  script(b, 'tofu', 'exit 0');
  fs.symlinkSync(path.join(a, 'terraform-bin'), path.join(b, 'terraform'));
  fs.writeFileSync(path.join(b, 'tofu-bin'), 'not executable', { mode: 0o644 });
  assert.deepEqual(tools.findTools(a).map((t) => [path.basename(t.file), t.kind]), [['terraform-bin', 'terraform'], ['terraform', 'terraform']]);
  // b's terraform links to a's terraform-bin, and shadows a's wrapper.
  const found = tools.findTools([b, a].join(path.delimiter));
  assert.deepEqual(found.map((t) => [path.basename(t.file), t.kind]), [['terraform-bin', 'terraform'], ['tofu', 'tofu']]);
});

test('showPlan uses the first tool that reads the plan, and says why each failed', async () => {
  const dir = tmp();
  const terraform = { file: script(dir, 'terraform', 'echo "Error: plan file was created by OpenTofu" >&2; exit 1'), kind: 'terraform' };
  const tofu = { file: script(dir, 'tofu', '[ "$1 $2 $3" = "show -json p.tfplan" ] && [ "$(pwd)" = "$WANT" ] && echo \'{"format_version":"1.2"}\''), kind: 'tofu' };
  const env = { PATH: process.env.PATH, WANT: fs.realpathSync(dir) };
  const r = await tools.showPlan('p.tfplan', { cwd: dir, env, tools: [terraform, tofu] });
  assert.equal(r.tool, tofu);
  assert.deepEqual(r.plan, { format_version: '1.2' });
  await assert.rejects(tools.showPlan('p.tfplan', { cwd: dir, env, tools: [terraform] }), /could not read the plan: .*terraform: Error: plan file was created by OpenTofu/);
  await assert.rejects(tools.showPlan('p.tfplan', { cwd: dir, env: { PATH: '' } }), /neither terraform nor tofu is on PATH/);
});

test('platformKey names the tfplan2md builds there are', () => {
  assert.equal(tools.platformKey('linux', 'x64'), 'linux-x64');
  assert.equal(tools.platformKey('linux', 'arm64'), 'linux-arm64');
  assert.equal(tools.platformKey('darwin', 'arm64'), 'macos-arm64');
  assert.equal(tools.platformKey('darwin', 'x64'), null);
  assert.equal(tools.platformKey('win32', 'x64'), null);
});

test('download follows redirects over https only', async () => {
  const calls = [];
  const get = async (method, url) => {
    calls.push(url);
    if (url === 'https://github.com/a') return { status: 302, headers: { location: 'https://objects.example/b?sig=1' } };
    if (url === 'https://objects.example/b?sig=1') return { status: 200, headers: {}, buffer: Buffer.from('ok') };
    return { status: 302, headers: { location: 'http://plain.example/c' } };
  };
  assert.equal((await tools.download('https://github.com/a', { get })).toString(), 'ok');
  await assert.rejects(tools.download('https://github.com/x', { get }), /refusing a non-https download: http:\/\/plain\.example\/c/);
  assert.deepEqual(calls, ['https://github.com/a', 'https://objects.example/b?sig=1', 'https://github.com/x']);
});

function fakeRelease() {
  const dir = tmp();
  script(dir, 'tfplan2md', 'echo fake');
  const archive = path.join(dir, 'release.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', dir, 'tfplan2md']);
  return fs.readFileSync(archive);
}

test('installTfplan2md checks the SHA-256, installs into the cache and reuses it', async (t) => {
  const bytes = fakeRelease();
  const saved = tools.TFPLAN2MD.sha256['linux-x64'];
  t.after(() => { tools.TFPLAN2MD.sha256['linux-x64'] = saved; });
  tools.TFPLAN2MD.sha256['linux-x64'] = crypto.createHash('sha256').update(bytes).digest('hex');
  const urls = [];
  const get = async (method, url) => { urls.push(url); return { status: 200, headers: {}, buffer: bytes }; };
  const cacheDir = tmp();
  const bin = await tools.installTfplan2md({ cacheDir, platform: 'linux', arch: 'x64', get });
  assert.equal(bin, path.join(cacheDir, 'tfplan2md', tools.TFPLAN2MD.version, 'linux-x64', 'tfplan2md'));
  assert.equal(execFileSync(bin).toString(), 'fake\n');
  assert.deepEqual(urls, [`https://github.com/oocx/tfplan2md/releases/download/v${tools.TFPLAN2MD.version}/tfplan2md_${tools.TFPLAN2MD.version}_linux-x64.tar.gz`]);
  assert.equal(await tools.installTfplan2md({ cacheDir, platform: 'linux', arch: 'x64', get }), bin);
  assert.equal(urls.length, 1);
  assert.deepEqual(fs.readdirSync(cacheDir), ['tfplan2md']);
});

test('installTfplan2md refuses a download whose SHA-256 differs, and platforms without a build', async () => {
  const cacheDir = tmp();
  const get = async () => ({ status: 200, headers: {}, buffer: Buffer.from('tampered') });
  await assert.rejects(tools.installTfplan2md({ cacheDir, platform: 'linux', arch: 'x64', get }), /has SHA-256 [0-9a-f]{64}, expected 31e086e1/);
  assert.equal(fs.existsSync(path.join(cacheDir, 'tfplan2md')), false);
  await assert.rejects(tools.installTfplan2md({ cacheDir, platform: 'win32', arch: 'x64', get }), /no tfplan2md build for win32-x64/);
});

test('tfplan2md renders for GitHub from a private file it then removes', async () => {
  const dir = tmp();
  const bin = script(dir, 'tfplan2md', [
    'file="${@: -1}"',
    'echo "args: ${*:1:$#-1}"',
    'stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file"',
    'cat "$file"',
  ].join('\n'));
  const out = await tools.tfplan2md(bin, { a: 1 }, { tmpDir: dir });
  assert.equal(out, 'args: --render-target github --hide-metadata --hide-unchanged-outputs\n600\n{"a":1}');
  const summary = await tools.tfplan2md(bin, { a: 1 }, { tmpDir: dir, template: 'summary' });
  assert.match(summary, /^args: .* --template summary\n/);
  assert.deepEqual(fs.readdirSync(dir), ['tfplan2md']);
  await assert.rejects(tools.tfplan2md(script(dir, 'bad', 'echo nope >&2; exit 3'), {}, { tmpDir: dir }), /tfplan2md exited with 3: nope/);
});
