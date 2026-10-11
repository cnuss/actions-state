'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderSummary } = require('../../src/summary');

const out = (value, sensitive = false) => ({ value, sensitive });
const row = (key, ...value) => ['<tr>', `<td><code>${key}</code></td>`, '<td>', '', ...value, '', '</td>', '</tr>'];
const head = ['<table>', '<tr><th>Key</th><th>Value</th></tr>'];

const zones = {
  tunnels: {
    zone_id: 'zone-t', account_id: 'acct-t',
    settings: { websockets: 'on', browser_cache_ttl: '0', min_tls_version: '1.0' },
  },
  site: {
    zone_id: 'zone-s', account_id: 'acct-s',
    settings: { ssl: 'full', '0rtt': 'off', security_header: '{"strict_transport_security":{"enabled":false,"max_age":0}}' },
  },
};

test('renderSummary renders nothing without outputs', () => {
  assert.equal(renderSummary({}, { name: 'root' }), '');
});

test('renderSummary renders scalars as one line, lists of scalars joined and other lists as JSON', () => {
  const md = renderSummary({ url: out('https://x'), count: out(3), on: out(true), zones: out(['a', 'b']), subnets: out([{ cidr: '10.0.0.0/24' }]) }, { name: 'root' });
  assert.equal(md, [
    '## Terraform outputs · `root`', '',
    '### `url`', '', '`https://x`', '',
    '### `count`', '', '`3`', '',
    '### `on`', '', '`true`', '',
    '### `zones`', '', '`a, b`', '',
    '### `subnets`', '', '`[{"cidr":"10.0.0.0/24"}]`', '', '',
  ].join('\n'));
});

test('renderSummary opens at h2 and names the package when given', () => {
  const md = renderSummary({ url: out('https://x') }, { name: 'root', image: 'ghcr.io/o/r/actions-state:root' });
  assert.ok(md.startsWith('## Terraform outputs · `root`\n\n<sub>actions-state · <code>ghcr.io/o/r/actions-state:root</code></sub>\n\n### `url`\n'));
});

test('renderSummary renders a map as an HTML table sorted by key, values as Markdown in the cells', () => {
  const md = renderSummary({ settings: out({ ttl: 300, ssl: 'strict', ids: ['a', 'b'] }) }, { name: 'root' });
  assert.ok(md.includes([
    '### `settings`', '', ...head,
    ...row('ids', '`a, b`'), ...row('ssl', '`strict`'), ...row('ttl', '`300`'),
    '</table>', '', '',
  ].join('\n')));
});

test('renderSummary heads each entry of a map of maps and nests deeper maps in their row', () => {
  const md = renderSummary({ zones: out(zones) }, { name: 'root' });
  assert.equal(md, [
    '## Terraform outputs · `root`', '',
    '### `zones`', '',
    '#### `site`', '', ...head,
    ...row('account_id', '`acct-s`'),
    '<tr>', '<td><code>settings</code></td>', '<td>', ...head,
    ...row('0rtt', '`off`'),
    ...row('security_header', '`{"strict_transport_security":{"enabled":false,"max_age":0}}`'),
    ...row('ssl', '`full`'),
    '</table>', '</td>', '</tr>',
    ...row('zone_id', '`zone-s`'),
    '</table>', '',
    '#### `tunnels`', '', ...head,
    ...row('account_id', '`acct-t`'),
    '<tr>', '<td><code>settings</code></td>', '<td>', ...head,
    ...row('browser_cache_ttl', '`0`'), ...row('min_tls_version', '`1.0`'), ...row('websockets', '`on`'),
    '</table>', '</td>', '</tr>',
    ...row('zone_id', '`zone-t`'),
    '</table>', '', '',
  ].join('\n'));
});

test('renderSummary nests maps at any depth and keeps a mixed map in one table', () => {
  const md = renderSummary({ m: out({ a: 1, b: { c: { d: 'x' } } }) }, { name: 'root' });
  assert.ok(md.includes('### `m`\n\n<table>\n'));
  assert.ok(!md.includes('####'));
  assert.ok(md.includes(['<td><code>b</code></td>', '<td>', ...head, '<tr>', '<td><code>c</code></td>', '<td>', ...head, ...row('d', '`x`')].join('\n')));
  assert.equal(md.split('<table>').length, md.split('</table>').length);
  assert.equal(md.split('<table>').length - 1, 3);
});

test('renderSummary writes every value verbatim so the runner can mask it', () => {
  const values = ['zone-t', 'acct-t', 'zone-s', '{"strict_transport_security":{"enabled":false,"max_age":0}}',
    'a|b', 'x<y>&amp;z', 'line one\nline two', 'x\\y "q"'];
  const md = renderSummary({
    zones: out(zones), pipe: out({ k: 'a|b' }), angle: out({ k: 'x<y>&amp;z' }), multi: out({ k: 'line one\nline two' }), raw: out('x\\y "q"'),
  }, { name: 'root' });
  for (const v of values) assert.ok(md.includes(v), v);
});

test('renderSummary never renders a sensitive value', () => {
  const md = renderSummary({ api_token: out('s3cr3t-token', true), creds: out({ key: 's3cr3t-key' }, true) }, { name: 'root' });
  assert.ok(!md.includes('s3cr3t'));
  assert.ok(md.includes('### `api_token`\n\n_Sensitive; not shown._\n'));
  assert.ok(md.includes('### `creds`\n\n_Sensitive; not shown._\n'));
});

test('renderSummary fences multi-line values inside their cell', () => {
  const md = renderSummary({ m: out({ multi: 'one\n```\ntwo' }) }, { name: 'root' });
  assert.ok(md.includes(row('multi', '````', 'one', '```', 'two', '````').join('\n')));
});

test('renderSummary escapes HTML in keys only', () => {
  const md = renderSummary({ m: out({ '<k>&': 'v' }) }, { name: 'root' });
  assert.ok(md.includes('<td><code>&lt;k&gt;&amp;</code></td>'));
});

test('renderSummary fences backticks', () => {
  const md = renderSummary({ m: out({ tick: '`', s: 'x `y`' }), s: out('a ``b`` c') }, { name: 'root' });
  assert.ok(md.includes(row('tick', '`` ` ``').join('\n')));
  assert.ok(md.includes(row('s', '`` x `y` ``').join('\n')));
  assert.ok(md.includes('### `s`\n\n```a ``b`` c```\n'));
});

test('renderSummary fences multi-line scalars', () => {
  assert.ok(renderSummary({ s: out('one\n```\ntwo') }, { name: 'root' }).includes('### `s`\n\n````\none\n```\ntwo\n````\n'));
});

test('renderSummary marks empty strings', () => {
  assert.ok(renderSummary({ e: out('') }, { name: 'root' }).includes('### `e`\n\n_empty_\n'));
});

test('renderSummary leaves out long values whole', () => {
  const md = renderSummary({ big: out('x'.repeat(5000)), m: out({ big: 'y'.repeat(3000) }) }, { name: 'root' });
  assert.ok(!md.includes('xxxx'));
  assert.ok(!md.includes('yyyy'));
  assert.ok(md.includes('### `big`\n\n_left out: 5000 characters; see the `json` output_\n'));
  assert.ok(md.includes(row('big', '_left out: 3000 characters; see the `json` output_').join('\n')));
});

test('renderSummary truncates at whole lines and closes the tags it cuts into', () => {
  const settings = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`s${String(i).padStart(3, '0')}`, `value_${i}`]));
  const value = { site: { zone_id: 'z', settings } };
  const full = renderSummary({ zones: out(value) }, { name: 'root' });
  for (let limit = 300; limit < 6000; limit += 37) {
    const md = renderSummary({ zones: out(value) }, { name: 'root', limit });
    assert.ok(Buffer.byteLength(md) <= limit, String(limit));
    assert.ok(md.endsWith('\n\n_Truncated: GitHub limits a step summary to 1 MiB; every output is in the `json` output._\n'), String(limit));
    for (const tag of ['table', 'tr', 'td']) {
      assert.equal(md.split(`<${tag}>`).length, md.split(`</${tag}>`).length, `${tag} at ${limit}`);
    }
    const body = md.slice(0, md.lastIndexOf('\n\n_Truncated'));
    assert.ok(full.startsWith(body.replace(/(\n+<\/(td|tr|table)>)+$/, '')), String(limit));
  }
});

test('renderSummary renders nothing when not even the notice fits', () => {
  assert.equal(renderSummary({ a: out('x') }, { name: 'root', limit: 20 }), '');
});
