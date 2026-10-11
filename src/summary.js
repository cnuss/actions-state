'use strict';

// Markdown for the step summary. Sensitive values are never rendered. Every
// other value is written as it is, so the runner can still mask it: values sit
// in Markdown code spans or fences inside HTML table cells, where nothing needs
// escaping, and a value too long to show is left out whole.

const LIMIT = 1024 * 1024; // GitHub's cap on one step's summary, in bytes.
const MAX_VALUE = 2048; // Longer values are left out.
const NOTICE = '_Truncated: GitHub limits a step summary to 1 MiB; every output is in the `json` output._';

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
const isScalar = (v) => v === null || typeof v !== 'object';
const multiline = (s) => /[\r\n]/.test(s);
const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
const html = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const oneLine = (k) => (multiline(k) ? JSON.stringify(k) : k);

// Strings as they are, lists of scalars joined with commas, anything else JSON.
function text(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length && v.every(isScalar)) return v.map(text).join(', ');
  return JSON.stringify(v) ?? 'null';
}

const fenceFor = (s, min) => '`'.repeat(Math.max(min, 1 + Math.max(0, ...(s.match(/`+/g) || []).map((r) => r.length))));

// A code span whose fence outlasts any backtick run inside it.
function span(s) {
  if (s === '') return '_empty_';
  if (s.length > MAX_VALUE) return `_left out: ${s.length} characters; see the \`json\` output_`;
  const fence = fenceFor(s, 1);
  const pad = /^[ `]|[ `]$/.test(s) ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

// A value as Markdown lines, ending with a blank line.
function valueLines(s) {
  if (!multiline(s) || s.length > MAX_VALUE) return [span(s), ''];
  const fence = fenceFor(s, 3);
  return [fence, ...s.split(/\r\n|\r|\n/), fence, ''];
}

// Lines are strings, or { text, open } and { text, close } for the HTML tags
// that truncation has to close.
const open = (tag) => ({ text: `<${tag}>`, open: tag });
const close = (tag) => ({ text: `</${tag}>`, close: tag });

// Sorted Key | Value rows. A map value is a table inside its cell; any other
// value is Markdown between blank lines, which GitHub renders inside HTML.
function table(map) {
  const lines = [open('table'), '<tr><th>Key</th><th>Value</th></tr>'];
  for (const [k, v] of Object.entries(map).sort(byKey)) {
    lines.push(open('tr'), `<td><code>${html(oneLine(k))}</code></td>`, open('td'));
    if (isMap(v)) lines.push(...table(v));
    else lines.push('', ...valueLines(text(v)));
    lines.push(close('td'), close('tr'));
  }
  lines.push(close('table'));
  return lines;
}

// A map of maps gets a heading per key, anything else one table.
function section(k, { value, sensitive }) {
  const lines = [`### ${span(oneLine(k))}`, ''];
  if (sensitive) lines.push('_Sensitive; not shown._', '');
  else if (isMap(value) && Object.values(value).every(isMap)) {
    for (const [key, v] of Object.entries(value).sort(byKey)) lines.push(`#### ${span(oneLine(key))}`, '', ...table(v), '');
  } else if (isMap(value)) lines.push(...table(value), '');
  else lines.push(...valueLines(text(value)));
  return lines;
}

const textOf = (line) => (typeof line === 'string' ? line : line.text);
const closers = (stack) => ['', ...[...stack].reverse().map((tag) => `</${tag}>`)];
const bytes = (lines) => lines.reduce((n, l) => n + Buffer.byteLength(textOf(l)) + 1, 0);

// Opens at h2: summaries of all steps share one page, so a lower level would
// read as part of the previous step's section. Lines are dropped from the end
// to fit `limit` bytes; open tags are closed and a notice is added.
function renderSummary(outputs, { name: stateName, image, limit = LIMIT } = {}) {
  const names = Object.keys(outputs);
  if (!names.length) return '';
  const lines = [`## Terraform outputs · ${span(oneLine(stateName))}`, ''];
  if (image) lines.push(`<sub>actions-state · <code>${html(image)}</code></sub>`, '');
  lines.push(...names.flatMap((n) => section(n, outputs[n])));
  const full = `${lines.map(textOf).join('\n')}\n`;
  if (Buffer.byteLength(full) <= limit) return full;
  const reserve = Buffer.byteLength(`\n${NOTICE}\n`);
  const kept = [];
  let stack = [];
  let size = 0;
  for (const line of lines) {
    const next = line.open ? [...stack, line.open] : line.close ? stack.slice(0, -1) : stack;
    const cost = Buffer.byteLength(textOf(line)) + 1;
    if (size + cost + bytes(closers(next)) + reserve > limit) break;
    kept.push(textOf(line));
    size += cost;
    stack = next;
  }
  if (!kept.length) return '';
  while (kept.at(-1) === '') kept.pop();
  if (stack.length) kept.push(...closers(stack));
  return `${kept.join('\n')}\n\n${NOTICE}\n`;
}

module.exports = { renderSummary, LIMIT };
