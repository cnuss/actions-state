'use strict';

// Markdown for the step summary. Sensitive values are never rendered. Every
// other value is written as it is, so the runner can still mask it: an entry
// that cannot sit in a table row unchanged goes below the table instead, and
// a value too long to show is left out whole.

const LIMIT = 1024 * 1024; // GitHub's cap on one step's summary, in bytes.
const MAX_VALUE = 2048; // Longer values are left out.
const NOTICE = '_Truncated: GitHub limits a step summary to 1 MiB; every output is in the `json` output._';

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
const isScalar = (v) => v === null || typeof v !== 'object';
const isLeaf = (map) => !Object.values(map).some(isMap);
const multiline = (s) => /[\r\n]/.test(s);
const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
const html = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Strings as they are, lists of scalars joined with commas, anything else JSON.
function text(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length && v.every(isScalar)) return v.map(text).join(', ');
  return JSON.stringify(v) ?? 'null';
}

// A code span whose fence outlasts any backtick run inside it.
function span(s) {
  if (s === '') return '_empty_';
  if (s.length > MAX_VALUE) return `_left out: ${s.length} characters; see the \`json\` output_`;
  const longest = Math.max(0, ...(s.match(/`+/g) || []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^[ `]|[ `]$/.test(s) ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

function standalone(s) {
  if (!multiline(s) || s.length > MAX_VALUE) return [span(s), ''];
  const longest = Math.max(0, ...(s.match(/`+/g) || []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [fence, ...s.split(/\r\n|\r|\n/), fence, ''];
}

const name = (k) => span(multiline(k) ? JSON.stringify(k) : k);
const fitsCell = (s) => s.length > MAX_VALUE || !/[|\r\n]/.test(s);
const heading = (level, k) => `${'#'.repeat(Math.min(level, 6))} ${name(k)}`;

function details(k, note, body) {
  return [`<details><summary><code>${html(multiline(k) ? JSON.stringify(k) : k)}</code>${note}</summary>`, '', ...body, '</details>', ''];
}

// Scalars as a table first, then each nested map: a map of scalars collapsed
// under <details>, a deeper one under its own heading.
function mapLines(map, level) {
  const rows = [];
  const rest = [];
  for (const [k, v] of Object.entries(map).sort(byKey)) {
    if (isMap(v)) {
      rest.push(isLeaf(v)
        ? details(k, ` (${Object.keys(v).length})`, mapLines(v, level + 1))
        : [heading(level, k), '', ...mapLines(v, level + 1)]);
      continue;
    }
    const s = text(v);
    if (!/[|\r\n]/.test(k) && fitsCell(s)) rows.push(`| ${name(k)} | ${span(s)} |`);
    else rest.push(details(k, '', standalone(s)));
  }
  const lines = rows.length ? ['| Key | Value |', '| --- | --- |', ...rows, ''] : [];
  for (const r of rest) lines.push(...r);
  return lines;
}

function section(k, { value, sensitive }) {
  const lines = [`### ${name(k)}`, ''];
  if (sensitive) lines.push('_Sensitive; not shown._', '');
  else if (isMap(value)) lines.push(...mapLines(value, 4));
  else lines.push(...standalone(text(value)));
  return lines;
}

// Lines are dropped from the end to fit `limit` bytes; open <details> are
// closed and a notice is added.
// Opens at h2: summaries of all steps share one page, so a lower level would
// read as part of the previous step's section.
function renderSummary(outputs, { name: stateName, image, limit = LIMIT } = {}) {
  const names = Object.keys(outputs);
  if (!names.length) return '';
  const lines = [`## Terraform outputs · ${name(stateName)}`, ''];
  if (image) lines.push(`<sub>actions-state · <code>${html(image)}</code></sub>`, '');
  lines.push(...names.flatMap((n) => section(n, outputs[n])));
  const full = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(full) <= limit) return full;
  const reserve = Buffer.byteLength(`\n${NOTICE}\n`);
  const close = Buffer.byteLength('\n</details>\n');
  const kept = [];
  let size = 0;
  let open = 0;
  for (const line of lines) {
    const next = open + (line.startsWith('<details>') ? 1 : 0) - (line === '</details>' ? 1 : 0);
    const cost = Buffer.byteLength(line) + 1;
    if (size + cost + next * close + reserve > limit) break;
    kept.push(line);
    size += cost;
    open = next;
  }
  if (!kept.length) return '';
  while (kept.at(-1) === '') kept.pop();
  for (; open > 0; open--) kept.push('', '</details>');
  return `${kept.join('\n')}\n\n${NOTICE}\n`;
}

module.exports = { renderSummary, LIMIT };
