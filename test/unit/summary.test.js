'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderSummary } = require('../../src/summary');

const out = (value, sensitive = false) => ({ value, sensitive });

test('renderSummary renders nothing without outputs', () => {
  assert.equal(renderSummary({}, { name: 'root' }), '');
});

test('renderSummary renders scalars as one line and lists as compact JSON', () => {
  const md = renderSummary({ url: out('https://x'), count: out(3), on: out(true), subnets: out([{ cidr: '10.0.0.0/24' }]) }, { name: 'root' });
  assert.equal(md, [
    '### Terraform outputs (`root`)', '',
    '#### `url`', '', '`https://x`', '',
    '#### `count`', '', '`3`', '',
    '#### `on`', '', '`true`', '',
    '#### `subnets`', '', '`[{"cidr":"10.0.0.0/24"}]`', '', '',
  ].join('\n'));
});

test('renderSummary renders a map as a key and value table', () => {
  const md = renderSummary({ settings: out({ ssl: 'strict', ttl: 300, tags: { a: [1] } }) }, { name: 'root' });
  assert.ok(md.includes([
    '#### `settings`', '',
    '| Key | Value |', '| --- | --- |',
    '| `ssl` | `strict` |', '| `ttl` | `300` |', '| `tags` | `{"a":[1]}` |', '',
  ].join('\n')));
});

test('renderSummary never renders a sensitive value', () => {
  const md = renderSummary({ api_token: out('s3cr3t-token', true), creds: out({ key: 's3cr3t-key' }, true) }, { name: 'root' });
  assert.ok(!md.includes('s3cr3t'));
  assert.ok(md.includes('#### `api_token`\n\n_Sensitive; not shown._\n'));
  assert.ok(md.includes('#### `creds`\n\n_Sensitive; not shown._\n'));
});

test('renderSummary escapes pipes in table cells and fences backticks', () => {
  const md = renderSummary({ m: out({ 'a|b': 'x | `y`', tick: '`' }), s: out('a ``b`` c') }, { name: 'root' });
  assert.ok(md.includes('| `a\\|b` | `` x \\| `y` `` |'));
  assert.ok(md.includes('| `` ` `` |'));
  assert.ok(md.includes('#### `s`\n\n```a ``b`` c```\n'));
});

test('renderSummary keeps multi-line values from breaking the layout', () => {
  const md = renderSummary({ m: out({ k: 'one\ntwo' }), s: out('one\n```\ntwo') }, { name: 'root' });
  assert.ok(md.includes('| `k` | `"one\\ntwo"` |'));
  assert.ok(md.includes('#### `s`\n\n````\none\n```\ntwo\n````\n'));
});

test('renderSummary marks empty strings', () => {
  assert.ok(renderSummary({ e: out('') }, { name: 'root' }).includes('#### `e`\n\n_empty_\n'));
});

test('renderSummary shortens long values', () => {
  const md = renderSummary({ big: out('x'.repeat(5000)) }, { name: 'root' });
  assert.ok(md.includes(`\`${'x'.repeat(2048)}\` _(2952 more characters)_`));
});

test('renderSummary truncates at whole lines to fit the limit', () => {
  const settings = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`setting_${i}`, `value_${i}`]));
  const full = renderSummary({ settings: out(settings) }, { name: 'root' });
  const md = renderSummary({ settings: out(settings) }, { name: 'root', limit: 4096 });
  assert.ok(Buffer.byteLength(md) <= 4096);
  assert.ok(md.endsWith('\n\n_Truncated: GitHub limits a step summary to 1 MiB; every output is in the `json` output._\n'));
  assert.ok(full.startsWith(md.slice(0, md.lastIndexOf('\n\n_Truncated'))));
  assert.match(md, /\| `setting_\d+` \| `value_\d+` \|\n\n_Truncated/);
});

test('renderSummary renders nothing when not even the notice fits', () => {
  assert.equal(renderSummary({ a: out('x') }, { name: 'root', limit: 20 }), '');
});
