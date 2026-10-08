'use strict';

// Terraform and OpenTofu: both read *_override.tf and share the http backend.

const fs = require('fs');
const path = require('path');

const OVERRIDE_FILE = 'actions_state_override.tf';
const LAYER_MEDIA_TYPE = 'application/vnd.cnuss.actions-state.tfstate.v1';
const SOURCE = /\.(tf|tofu)(\.json)?$/;

// Removes comments and keeps strings, so a commented-out backend is not detected.
function stripComments(src) {
  let out = '';
  let inString = false;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === '"') inString = false;
      i += 1;
    } else if (c === '"') {
      inString = true; out += c; i += 1;
    } else if (c === '#' || (c === '/' && next === '/')) {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
    } else {
      out += c; i += 1;
    }
  }
  return out;
}

// Bodies of top-level `terraform { ... }` blocks.
function terraformBlocks(src) {
  const bodies = [];
  const re = /(^|\n)\s*terraform\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let inString = false;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i += 1) {
      const c = src[i];
      if (inString) {
        if (c === '\\') i += 1;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
    }
    bodies.push(src.slice(re.lastIndex, i - 1));
    re.lastIndex = i;
  }
  return bodies;
}

function backendsIn(file, text) {
  if (file.endsWith('.json')) {
    const doc = JSON.parse(text);
    return [].concat(doc.terraform || []).flatMap((block) => [
      ...[].concat(block.backend || []).flatMap((b) => Object.keys(b)),
      ...(block.cloud ? ['cloud'] : []),
    ]);
  }
  return terraformBlocks(stripComments(text)).flatMap((body) => {
    const found = [...body.matchAll(/\bbackend\s+"([^"]+)"\s*\{/g)].map((x) => x[1]);
    if (/(^|\s)cloud\s*\{/.test(body)) found.push('cloud');
    return found;
  });
}

function findBackends(dir) {
  return fs.readdirSync(dir)
    .filter((f) => SOURCE.test(f) && f !== OVERRIDE_FILE)
    .sort()
    .flatMap((f) => backendsIn(f, fs.readFileSync(path.join(dir, f), 'utf8')).map((type) => ({ file: f, type })));
}

function check(dir, { replaceBackend = false } = {}) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`working-directory ${dir} does not exist`);
  const found = findBackends(dir);
  if (found.length && !replaceBackend) {
    const list = found.map((b) => `${b.type} (${b.file})`).join(', ');
    throw new Error(`${dir} already declares a backend: ${list}. Remove it, or set replace-backend: true to override it.`);
  }
  return found;
}

function overrideHcl(endpoint) {
  return [
    '# Written by cnuss/actions-state and removed when the job ends.',
    'terraform {',
    '  backend "http" {',
    `    address        = "${endpoint}/state"`,
    `    lock_address   = "${endpoint}/lock"`,
    `    unlock_address = "${endpoint}/lock"`,
    '    lock_method    = "LOCK"',
    '    unlock_method  = "UNLOCK"',
    '    update_method  = "POST"',
    '    username       = "actions-state"',
    '  }',
    '}',
    '',
  ].join('\n');
}

function gitRoot(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

// Worktrees and submodules (.git as a file) are skipped.
function excludeFromGit(file) {
  const root = gitRoot(path.dirname(file));
  if (!root || !fs.statSync(path.join(root, '.git')).isDirectory()) return;
  const excludePath = path.join(root, '.git', 'info', 'exclude');
  const line = `/${path.relative(root, file).split(path.sep).join('/')}`;
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  if (existing.split('\n').includes(line)) return;
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  fs.appendFileSync(excludePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`);
}

// Addresses go in the file, not TF_HTTP_ADDRESS: env vars apply to the whole
// job, and a job may serve several states.
function wire(dir, { endpoint }) {
  const file = path.join(dir, OVERRIDE_FILE);
  fs.writeFileSync(file, overrideHcl(endpoint));
  excludeFromGit(file);
  return {};
}

function unwire(dir) {
  fs.rmSync(path.join(dir, OVERRIDE_FILE), { force: true });
}

function stateMeta(bytes) {
  const doc = JSON.parse(bytes.toString('utf8'));
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || !Number.isInteger(doc.version)) {
    throw new Error('not a state file: expected an object with an integer "version"');
  }
  return {
    serial: Number.isInteger(doc.serial) ? doc.serial : 0,
    lineage: typeof doc.lineage === 'string' ? doc.lineage : '',
  };
}

module.exports = {
  name: 'terraform', OVERRIDE_FILE, LAYER_MEDIA_TYPE,
  stripComments, findBackends, check, overrideHcl, wire, unwire, stateMeta,
};
