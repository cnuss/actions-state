'use strict';

// Markdown for the step summary. Sensitive values are never rendered.

const LIMIT = 1024 * 1024; // GitHub's cap on one step's summary, in bytes.
const MAX_VALUE = 2048; // Characters shown per value.
const NOTICE = '_Truncated: GitHub limits a step summary to 1 MiB; every output is in the `json` output._';

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
const multiline = (s) => /[\r\n]/.test(s);
const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v) ?? 'null');
const oneLine = (v) => (typeof v === 'string' && multiline(v) ? JSON.stringify(v) : text(v));

function clip(s) {
  if (s.length <= MAX_VALUE) return { shown: s, more: '' };
  return { shown: s.slice(0, MAX_VALUE), more: ` _(${s.length - MAX_VALUE} more characters)_` };
}

// A code span whose fence outlasts any backtick run inside it.
function span(s, { table = false } = {}) {
  if (s === '') return '_empty_';
  const { shown, more } = clip(s);
  const longest = Math.max(0, ...(shown.match(/`+/g) || []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^[ `]|[ `]$/.test(shown) ? ' ' : '';
  // Backslashes stay as they are: code spans are literal, and GFM unescapes only `\|` in table cells.
  const body = table ? shown.replace(/\|/g, '\\|') : shown;
  return `${fence}${pad}${body}${pad}${fence}${more}`;
}

function block(s) {
  const { shown, more } = clip(s);
  const longest = Math.max(0, ...(shown.match(/`+/g) || []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [fence, ...shown.split(/\r?\n|\r/), fence, ...(more ? [more.trim()] : [])];
}

function section(name, { value, sensitive }) {
  const lines = [`#### ${span(oneLine(name))}`, ''];
  if (sensitive) lines.push('_Sensitive; not shown._');
  else if (isMap(value)) {
    lines.push('| Key | Value |', '| --- | --- |');
    for (const [k, v] of Object.entries(value)) lines.push(`| ${span(oneLine(k), { table: true })} | ${span(oneLine(v), { table: true })} |`);
  } else if (typeof value === 'string' && multiline(value)) lines.push(...block(value));
  else lines.push(span(text(value)));
  lines.push('');
  return lines;
}

// Lines are dropped from the end to fit `limit` bytes, then a notice is added.
function renderSummary(outputs, { name, limit = LIMIT } = {}) {
  const names = Object.keys(outputs);
  if (!names.length) return '';
  const lines = [`### Terraform outputs (${span(oneLine(name))})`, '', ...names.flatMap((n) => section(n, outputs[n]))];
  const full = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(full) <= limit) return full;
  let budget = limit - Buffer.byteLength(`\n${NOTICE}\n`);
  const kept = [];
  for (const line of lines) {
    budget -= Buffer.byteLength(line) + 1;
    if (budget < 0) break;
    kept.push(line);
  }
  if (!kept.length) return '';
  while (kept.at(-1) === '') kept.pop();
  return `${kept.join('\n')}\n\n${NOTICE}\n`;
}

module.exports = { renderSummary, LIMIT };
