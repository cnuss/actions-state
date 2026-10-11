'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderSummary } = require('../../src/summary');

const out = (value, sensitive = false) => ({ value, sensitive });

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

test('renderSummary renders a map of scalars as a table sorted by key', () => {
  const md = renderSummary({ settings: out({ ttl: 300, ssl: 'strict', ids: ['a', 'b'] }) }, { name: 'root' });
  assert.ok(md.includes([
    '### `settings`', '',
    '| Key | Value |', '| --- | --- |',
    '| `ids` | `a, b` |', '| `ssl` | `strict` |', '| `ttl` | `300` |', '', '',
  ].join('\n')));
});

test('renderSummary nests maps: headings for maps of maps, <details> for maps of scalars', () => {
  const md = renderSummary({ zones: out(zones) }, { name: 'root' });
  assert.equal(md, [
    '## Terraform outputs · `root`', '',
    '### `zones`', '',
    '#### `site`', '',
    '| Key | Value |', '| --- | --- |',
    '| `account_id` | `acct-s` |', '| `zone_id` | `zone-s` |', '',
    '<details><summary><code>settings</code> (3)</summary>', '',
    '| Key | Value |', '| --- | --- |',
    '| `0rtt` | `off` |',
    '| `security_header` | `{"strict_transport_security":{"enabled":false,"max_age":0}}` |',
    '| `ssl` | `full` |', '',
    '</details>', '',
    '#### `tunnels`', '',
    '| Key | Value |', '| --- | --- |',
    '| `account_id` | `acct-t` |', '| `zone_id` | `zone-t` |', '',
    '<details><summary><code>settings</code> (3)</summary>', '',
    '| Key | Value |', '| --- | --- |',
    '| `browser_cache_ttl` | `0` |', '| `min_tls_version` | `1.0` |', '| `websockets` | `on` |', '',
    '</details>', '', '',
  ].join('\n'));
});

test('renderSummary caps headings at level 6', () => {
  const md = renderSummary({ deep: out({ a: { b: { c: { d: { e: { f: 'x' } } } } } }) }, { name: 'root' });
  assert.ok(md.includes('\n#### `a`\n\n##### `b`\n\n###### `c`\n\n###### `d`\n\n<details><summary><code>e</code> (1)</summary>\n'));
});

test('renderSummary opens at h2 and names the package when given', () => {
  const md = renderSummary({ url: out('https://x') }, { name: 'root', image: 'ghcr.io/o/r/actions-state:root' });
  assert.ok(md.startsWith('## Terraform outputs · `root`\n\n<sub>actions-state · <code>ghcr.io/o/r/actions-state:root</code></sub>\n\n### `url`\n'));
});

test('renderSummary writes every value verbatim so the runner can mask it', () => {
  const values = ['zone-t', 'acct-t', 'zone-s', '{"strict_transport_security":{"enabled":false,"max_age":0}}',
    'a|b', 'line one\nline two', 'x\\y "q"'];
  const md = renderSummary({ zones: out(zones), pipe: out({ k: 'a|b' }), multi: out({ k: 'line one\nline two' }), raw: out('x\\y "q"') }, { name: 'root' });
  for (const v of values) assert.ok(md.includes(v), v);
});

test('renderSummary never renders a sensitive value', () => {
  const md = renderSummary({ api_token: out('s3cr3t-token', true), creds: out({ key: 's3cr3t-key' }, true) }, { name: 'root' });
  assert.ok(!md.includes('s3cr3t'));
  assert.ok(md.includes('### `api_token`\n\n_Sensitive; not shown._\n'));
  assert.ok(md.includes('### `creds`\n\n_Sensitive; not shown._\n'));
});

test('renderSummary moves values with pipes or line breaks below the table, unchanged', () => {
  const md = renderSummary({ m: out({ ok: 'fine', pipe: 'x | y', multi: 'one\n```\ntwo' }) }, { name: 'root' });
  assert.ok(md.includes('| Key | Value |\n| --- | --- |\n| `ok` | `fine` |\n\n'));
  assert.ok(md.includes('<details><summary><code>multi</code></summary>\n\n````\none\n```\ntwo\n````\n\n</details>\n'));
  assert.ok(md.includes('<details><summary><code>pipe</code></summary>\n\n`x | y`\n\n</details>\n'));
});

test('renderSummary moves keys with pipes below the table and escapes HTML in summaries', () => {
  const md = renderSummary({ m: out({ 'a|b': 'v', n: { '<k>&': { z: 1 } } }) }, { name: 'root' });
  assert.ok(md.includes('<details><summary><code>a|b</code></summary>\n\n`v`\n\n</details>\n'));
  assert.ok(md.includes('<summary><code>&lt;k&gt;&amp;</code> (1)</summary>'));
});

test('renderSummary fences backticks', () => {
  const md = renderSummary({ m: out({ tick: '`', s: 'x `y`' }), s: out('a ``b`` c') }, { name: 'root' });
  assert.ok(md.includes('| `tick` | `` ` `` |'));
  assert.ok(md.includes('| `s` | `` x `y` `` |'));
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
  assert.ok(md.includes('| `big` | _left out: 3000 characters; see the `json` output_ |'));
});

test('renderSummary truncates at whole lines to fit the limit', () => {
  const settings = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`setting_${String(i).padStart(3, '0')}`, `value_${i}`]));
  const full = renderSummary({ settings: out(settings) }, { name: 'root' });
  const md = renderSummary({ settings: out(settings) }, { name: 'root', limit: 4096 });
  assert.ok(Buffer.byteLength(md) <= 4096);
  assert.ok(md.endsWith('\n\n_Truncated: GitHub limits a step summary to 1 MiB; every output is in the `json` output._\n'));
  assert.ok(full.startsWith(md.slice(0, md.lastIndexOf('\n\n_Truncated'))));
  assert.match(md, /\| `setting_\d+` \| `value_\d+` \|\n\n_Truncated/);
});

test('renderSummary closes <details> it cuts into', () => {
  const settings = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`s${String(i).padStart(3, '0')}`, 'v']));
  for (const limit of [300, 1000, 4096]) {
    const md = renderSummary({ zones: out({ site: { zone_id: 'z', settings } }) }, { name: 'root', limit });
    assert.ok(Buffer.byteLength(md) <= limit, String(limit));
    assert.equal(md.split('<details>').length, md.split('</details>').length, String(limit));
    assert.ok(md.endsWith('</details>\n\n_Truncated: GitHub limits a step summary to 1 MiB; every output is in the `json` output._\n'), String(limit));
  }
});

test('renderSummary renders nothing when not even the notice fits', () => {
  assert.equal(renderSummary({ a: out('x') }, { name: 'root', limit: 20 }), '');
});
