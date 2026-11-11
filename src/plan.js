'use strict';

// Saved plans: finding them, reading their counts and secrets from
// `show -json`, and the Markdown for the pull request comment and step summary.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const COMMENT_LIMIT = 65536; // GitHub's cap on a comment body, in characters.
// Shorter sensitive values are not redacted: masking a common string such as
// "true" or a port number would garble the whole plan.
const MIN_MASK = 6;
const MAX_PLAN_BYTES = 256 * 1024 * 1024;

// Central directory entries of a zip, or null if `buf` is not one. ZIP64 is not read.
function zipEntries(buf) {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return null;
  let eocd = -1;
  for (let i = buf.length - 22, min = Math.max(0, buf.length - 65557); i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const entries = new Map();
  for (let n = 0, p = buf.readUInt32LE(eocd + 16); n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(p + 28);
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), {
      method: buf.readUInt16LE(p + 10), size: buf.readUInt32LE(p + 20), local: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

function zipRead(buf, entry) {
  const start = entry.local + 30 + buf.readUInt16LE(entry.local + 26) + buf.readUInt16LE(entry.local + 28);
  const data = buf.subarray(start, start + entry.size);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

// A saved Terraform or OpenTofu plan: a zip with a `tfplan` entry.
function readPlanFile(file) {
  const bytes = fs.readFileSync(file);
  const entries = zipEntries(bytes);
  if (!entries || !entries.has('tfplan')) return null;
  return { bytes, entries };
}

// Serial of the state the plan was made against, or null for a new state.
function priorSerial({ bytes, entries }) {
  const entry = entries.get('tfstate');
  if (!entry) return null;
  try {
    const serial = JSON.parse(zipRead(bytes, entry).toString('utf8')).serial;
    return Number.isInteger(serial) ? serial : null;
  } catch { return null; }
}

function hasZipMagic(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    return fs.readSync(fd, head, 0, 4, 0) === 4 && head.readUInt32LE(0) === 0x04034b50;
  } finally { fs.closeSync(fd); }
}

// The newest plan saved in `dir` (not its subdirectories) at or after `since` (ms).
function findPlanFile(dir, { since = 0 } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const found = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile() || st.mtimeMs < since || st.size > MAX_PLAN_BYTES || !hasZipMagic(file)) continue;
    const plan = readPlanFile(file);
    if (plan) found.push({ file, mtimeMs: st.mtimeMs, ...plan });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : 1));
  return found[0] || null;
}

const isNoOp = (actions) => !actions || actions.every((a) => a === 'no-op' || a === 'read');

// Terraform's "Plan:" counts: a replacement is one add and one destroy.
function changeCounts(plan) {
  const c = { import: 0, add: 0, change: 0, destroy: 0, replace: 0, forget: 0, outputs: 0 };
  for (const r of plan.resource_changes || []) {
    const actions = r.change?.actions || [];
    if (r.change?.importing) c.import += 1;
    if (actions.includes('create') && actions.includes('delete')) {
      c.replace += 1; c.add += 1; c.destroy += 1;
    } else if (actions.includes('create')) c.add += 1;
    else if (actions.includes('delete')) c.destroy += 1;
    else if (actions.includes('update')) c.change += 1;
    if (actions.includes('forget')) c.forget += 1;
  }
  for (const o of Object.values(plan.output_changes || {})) if (!isNoOp(o.actions)) c.outputs += 1;
  return c;
}

const hasChanges = (c) => c.import + c.add + c.change + c.destroy + c.forget + c.outputs > 0;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function headline(c) {
  if (!hasChanges(c)) return 'No changes.';
  const parts = [];
  if (c.import) parts.push(`${c.import} to import`);
  parts.push(`${c.add} to add`, `${c.change} to change`, `${c.destroy} to destroy`);
  if (c.forget) parts.push(`${c.forget} to forget`);
  let line = `Plan: ${parts.join(', ')}`;
  if (c.replace) line += ` (${plural(c.replace, 'replacement')})`;
  line += '.';
  if (c.outputs) line += ` ${plural(c.outputs, 'output')} to change.`;
  return line;
}

// Every value the plan marks sensitive, as strings to redact.
function sensitiveValues(plan) {
  const found = new Set();
  const add = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'object') { for (const x of Object.values(v)) add(x); return; }
    for (const line of String(v).split(/\r\n|\r|\n/)) if (line.length >= MIN_MASK) found.add(line);
  };
  const marked = (value, mark) => {
    if (mark === true) add(value);
    else if (mark && typeof mark === 'object' && value && typeof value === 'object') {
      for (const k of Object.keys(mark)) marked(value[k], mark[k]);
    }
  };
  const moduleValues = (m) => {
    if (!m) return;
    for (const r of m.resources || []) marked(r.values, r.sensitive_values);
    for (const child of m.child_modules || []) moduleValues(child);
  };
  for (const r of [...(plan.resource_changes || []), ...(plan.resource_drift || [])]) {
    marked(r.change?.before, r.change?.before_sensitive);
    marked(r.change?.after, r.change?.after_sensitive);
  }
  for (const o of Object.values(plan.output_changes || {})) {
    marked(o.before, o.before_sensitive);
    marked(o.after, o.after_sensitive);
  }
  for (const values of [plan.planned_values, plan.prior_state?.values]) {
    for (const o of Object.values(values?.outputs || {})) if (o.sensitive) add(o.value);
    moduleValues(values?.root_module);
  }
  const declared = plan.configuration?.root_module?.variables || {};
  for (const [name, v] of Object.entries(plan.variables || {})) if (declared[name]?.sensitive) add(v?.value);
  return [...found];
}

const html = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Replaces each secret of MIN_MASK characters or more, as written and as
// Markdown tables and HTML escape it.
function redact(text, secrets) {
  const variants = new Set();
  for (const s of secrets) {
    if (!s || s.length < MIN_MASK) continue;
    variants.add(s).add(html(s)).add(s.replace(/\|/g, '\\|'));
  }
  let out = text;
  for (const v of [...variants].sort((a, b) => b.length - a.length)) out = out.split(v).join('***');
  return out;
}

// tfplan2md's report under our h2: its title goes, other headings move down one.
function nestReport(md) {
  const out = [];
  let fence = null;
  let titled = false;
  for (const line of md.split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      out.push(line);
    } else if (f) {
      fence = f[1];
      out.push(line);
    } else if (!titled && /^# /.test(line)) {
      titled = true;
    } else out.push(/^#{1,5} /.test(line) ? `#${line}` : line);
  }
  return out.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
}

// `show -no-color` text with the action markers at the start of each line, so
// a diff fence colors them; `~` becomes `!`, which the diff lexer also colors.
function diffText(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  const start = lines.findIndex((l) => /^(Terraform|OpenTofu) will perform the following actions:|^Changes to Outputs:/.test(l));
  return lines.slice(Math.max(start, 0)).map((l) => {
    const m = /^(\s+)([-+~])(\s.*|)$/.exec(l);
    const moved = m ? `${m[2]}${m[1]}${m[3]}` : l;
    return moved.startsWith('~') ? `!${moved.slice(1)}` : moved;
  });
}

const fenceFor = (lines) => '`'.repeat(Math.max(3, 1 + Math.max(0, ...lines.flatMap((l) => (l.match(/`+/g) || []).map((r) => r.length)))));

function marker(name) {
  return `<!-- actions-state:plan:${encodeURIComponent(name).replace(/-/g, '%2D')} -->`;
}

// The comment body: marker, heading, counts, the plan and a footer naming the
// state serial and commit it was made against. The plan is the tfplan2md
// report when it fits, else its summary template, else the text diff, cut to fit.
function renderPlan({
  name, tool = 'terraform', plan, report = null, summaryReport = null, text = null,
  serial = null, sha = '', runUrl = '', serverUrl = 'https://github.com', repository = '', secrets = [], limit = COMMENT_LIMIT,
}) {
  const counts = changeCounts(plan);
  const changes = hasChanges(counts);
  const label = tool === 'tofu' ? 'OpenTofu' : 'Terraform';
  const head = [marker(name), `## ${label} plan · \`${name.replace(/`/g, "'")}\``, '', `**${headline(counts)}**`, ''];
  const foot = [];
  const facts = ['actions-state', serial === null ? 'new state' : `state serial ${serial}`];
  if (sha) facts.push(repository ? `commit [\`${sha.slice(0, 7)}\`](${serverUrl}/${repository}/commit/${sha})` : `commit \`${sha.slice(0, 7)}\``);
  if (runUrl) facts.push(`[workflow run](${runUrl})`);
  foot.push(`<sub>${facts.join(' · ')}</sub>`);
  const compose = (body) => `${[...head, ...body, ...foot].join('\n')}\n`;
  const seeRun = runUrl ? `; see the [workflow run](${runUrl})` : '; see the workflow run';
  const fits = (s) => s.length <= limit;

  let md = compose([]);
  if (changes && report) {
    md = compose([nestReport(redact(report, secrets)), '']);
    if (!fits(md) && summaryReport) {
      md = compose([nestReport(redact(summaryReport, secrets)), '', `_The full plan is too long for a comment${seeRun}._`, '']);
    }
  }
  if (changes && (!report || !fits(md)) && text !== null) {
    const lines = diffText(redact(text, secrets));
    const fence = fenceFor(lines);
    const wrap = (kept, cut) => compose([
      '<details><summary>Show plan</summary>', '', `${fence}diff`, ...kept, fence, '', '</details>', '',
      ...(cut ? [`_Cut off: GitHub limits a comment to ${COMMENT_LIMIT} characters${seeRun}._`, ''] : []),
    ]);
    md = wrap(lines, false);
    if (!fits(md)) {
      const room = limit - wrap([], true).length;
      const kept = [];
      for (let i = 0, used = 0; i < lines.length && used + lines[i].length + 1 <= room; used += lines[i].length + 1, i += 1) kept.push(lines[i]);
      md = wrap(kept, true);
    }
  }
  if (!fits(md)) md = compose([`_The plan is too long for a comment${seeRun}._`, '']);
  return { body: md, changes, counts, marker: marker(name) };
}

module.exports = {
  COMMENT_LIMIT, MIN_MASK,
  zipEntries, readPlanFile, priorSerial, findPlanFile, changeCounts, hasChanges, headline,
  sensitiveValues, redact, nestReport, diffText, marker, renderPlan,
};
