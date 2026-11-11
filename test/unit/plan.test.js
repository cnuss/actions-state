'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  COMMENT_LIMIT, zipEntries, readPlanFile, priorSerial, findPlanFile, changeCounts, headline,
  sensitiveValues, redact, nestReport, diffText, marker, renderPlan,
} = require('../../src/plan');
const { zip, planZip } = require('../fakes/zip');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'as-plan-'));

test('readPlanFile reads saved plans and priorSerial the serial they were made against', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'p'), planZip(41));
  fs.writeFileSync(path.join(dir, 'new'), planZip());
  fs.writeFileSync(path.join(dir, 'other.zip'), zip({ 'a.txt': 'a' }));
  fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "x" "y" {}');
  assert.equal(priorSerial(readPlanFile(path.join(dir, 'p'))), 41);
  assert.equal(priorSerial(readPlanFile(path.join(dir, 'new'))), null);
  assert.equal(readPlanFile(path.join(dir, 'other.zip')), null);
  assert.equal(readPlanFile(path.join(dir, 'main.tf')), null);
  assert.equal(zipEntries(Buffer.from('PK\x03\x04 but truncated')), null);
});

test('findPlanFile takes the newest plan saved since the given time, not in subdirectories', () => {
  const dir = tmp();
  const at = (name, bytes, secs) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    fs.utimesSync(file, secs, secs);
  };
  at('old.tfplan', planZip(1), 1000);
  at('a.tfplan', planZip(2), 2000);
  at('b.tfplan', planZip(3), 3000);
  at('sub/c.tfplan', planZip(4), 4000);
  at('notes.zip', zip({ x: 'y' }), 5000);
  assert.equal(path.basename(findPlanFile(dir).file), 'b.tfplan');
  assert.equal(findPlanFile(dir, { since: 3_000_001 }), null);
  assert.equal(findPlanFile(path.join(dir, 'missing')), null);
});

const rc = (address, actions, extra = {}) => ({ address, change: { actions, ...extra } });

test('changeCounts counts like Terraform: a replacement is an add and a destroy', () => {
  const plan = {
    resource_changes: [
      rc('a', ['create']), rc('b', ['delete', 'create']), rc('c', ['create', 'delete']), rc('d', ['update']),
      rc('e', ['delete']), rc('f', ['no-op'], { importing: { id: 'x' } }), rc('g', ['forget']), rc('h', ['read']), rc('i', ['no-op']),
    ],
    output_changes: { x: { actions: ['update'] }, y: { actions: ['no-op'] } },
  };
  assert.deepEqual(changeCounts(plan), { import: 1, add: 3, change: 1, destroy: 3, replace: 2, forget: 1, outputs: 1 });
  assert.equal(headline(changeCounts(plan)), 'Plan: 1 to import, 3 to add, 1 to change, 3 to destroy, 1 to forget (2 replacements). 1 output to change.');
  assert.equal(headline(changeCounts({ resource_changes: [rc('a', ['update'])] })), 'Plan: 0 to add, 1 to change, 0 to destroy.');
  assert.equal(headline(changeCounts({ resource_changes: [rc('i', ['no-op']), rc('h', ['read'])] })), 'No changes.');
  assert.equal(headline(changeCounts({})), 'No changes.');
});

test('sensitiveValues collects every value the plan marks sensitive, not short ones', () => {
  const plan = {
    resource_changes: [{
      address: 'x',
      change: {
        actions: ['update'],
        before: { password: 'hunter22', nested: { key: 'pem-line-1\npem-line-2', port: 5432 }, list: ['open', 'closed-secret'], plain: 'visible' },
        before_sensitive: { password: true, nested: { key: true, port: true }, list: [false, true] },
        after: { password: 'n3w-password' },
        after_sensitive: { password: true },
      },
    }],
    output_changes: { token: { actions: ['update'], before: 'old-token', after: 'new-token', before_sensitive: true, after_sensitive: true } },
    planned_values: { outputs: { db: { sensitive: true, value: { url: 'postgres://u:p@h' } }, open: { sensitive: false, value: 'public-value' } } },
    prior_state: { values: { root_module: { child_modules: [{ resources: [{ values: { secret: 'state-secret' }, sensitive_values: { secret: true } }] }] } } },
    configuration: { root_module: { variables: { pw: { sensitive: true }, region: {} } } },
    variables: { pw: { value: 'var-secret' }, region: { value: 'us-east-1' } },
  };
  assert.deepEqual(sensitiveValues(plan).sort(), [
    'closed-secret', 'hunter22', 'n3w-password', 'new-token', 'old-token', 'pem-line-1', 'pem-line-2', 'postgres://u:p@h', 'state-secret', 'var-secret',
  ]);
});

test('redact replaces secrets as written, HTML-escaped and table-escaped, longest first', () => {
  assert.equal(redact('a hunter22 b hunter2222', ['hunter22', 'hunter2222']), 'a *** b ***');
  assert.equal(redact('<td>p&amp;ss&lt;1</td> | ab\\|cdef |', ['p&ss<1', 'ab|cdef']), '<td>***</td> | *** |');
  // A row as tfplan2md 1.48.0 writes it.
  assert.equal(redact('| input.a | `p\\|pe\\\\back<lt>&amp;amp` | `x` |', ['p|pe\\back<lt>&amp']), '| input.a | `***` | `x` |');
  assert.equal(redact('keep t short', ['', null, 't', 'short']), 'keep t short');
});

test('nestReport drops the title and moves headings down one, but not inside code fences', () => {
  const md = '# Terraform Plan Report\n\n## Summary\n\n```hcl\n# a comment\n```\n\n### 📦 Module: root\n\n###### deep\n';
  assert.equal(nestReport(md), '### Summary\n\n```hcl\n# a comment\n```\n\n#### 📦 Module: root\n\n###### deep');
});

test('diffText starts at the actions and moves markers to the line start', () => {
  const text = [
    'Terraform used the selected providers to generate the following execution',
    'plan. Resource actions are indicated with the following symbols:',
    '  ~ update in-place',
    '',
    'Terraform will perform the following actions:',
    '',
    '  # a will be updated in-place',
    '  ~ resource "x" "a" {',
    '      + added   = "1"',
    '      - removed = "2" -> null',
    '        id      = "keep"',
    '    }',
    '-/+ resource "x" "b" {',
    '',
  ].join('\n');
  assert.deepEqual(diffText(text), [
    'Terraform will perform the following actions:',
    '',
    '  # a will be updated in-place',
    '!   resource "x" "a" {',
    '+       added   = "1"',
    '-       removed = "2" -> null',
    '        id      = "keep"',
    '    }',
    '-/+ resource "x" "b" {',
  ]);
  assert.deepEqual(diffText('Changes to Outputs:\n  + url = "x"\n'), ['Changes to Outputs:', '+   url = "x"']);
});

test('marker keeps the name out of HTML comment syntax', () => {
  assert.equal(marker('infra/dns--x'), '<!-- actions-state:plan:infra%2Fdns%2D%2Dx -->');
});

const changed = { resource_changes: [rc('x.a', ['update'])] };
const base = { name: 'infra/dns', plan: changed, serial: 41, sha: 'abc1234def', runUrl: 'https://github.com/o/r/actions/runs/9/job/3', repository: 'o/r' };

test('renderPlan puts the tfplan2md report under a heading with the counts and a footer', () => {
  const { body, changes } = renderPlan({ ...base, report: '# Terraform Plan Report\n\n## Summary\n\nrows with hunter22\n', secrets: ['hunter22'] });
  assert.equal(changes, true);
  assert.equal(body, [
    '<!-- actions-state:plan:infra%2Fdns -->',
    '## Terraform plan · `infra/dns`',
    '',
    '**Plan: 0 to add, 1 to change, 0 to destroy.**',
    '',
    '### Summary',
    '',
    'rows with ***',
    '',
    '<sub>actions-state · state serial 41 · commit [`abc1234`](https://github.com/o/r/commit/abc1234def) · [workflow run](https://github.com/o/r/actions/runs/9/job/3)</sub>',
    '',
  ].join('\n'));
});

test('renderPlan says No changes without a report, and names a new state and OpenTofu', () => {
  const { body, changes } = renderPlan({ name: 'root', tool: 'tofu', plan: { resource_changes: [] }, report: 'ignored', serial: null });
  assert.equal(changes, false);
  assert.equal(body, '<!-- actions-state:plan:root -->\n## OpenTofu plan · `root`\n\n**No changes.**\n\n<sub>actions-state · new state</sub>\n');
});

test('renderPlan falls back to the summary template, then to the text diff, when the report is too long', () => {
  const report = `# T\n\n${'x'.repeat(COMMENT_LIMIT)}\n`;
  const summary = renderPlan({ ...base, report, summaryReport: '# T\n\n## Summary\n\n| a | 1 |\n' }).body;
  assert.match(summary, /### Summary\n\n\| a \| 1 \|\n\n_The full plan is too long for a comment; see the \[workflow run\]\(https:/);
  const text = renderPlan({ ...base, report, summaryReport: report, text: 'Terraform will perform the following actions:\n  ~ resource "x" "a" {}\n' }).body;
  assert.match(text, /<details><summary>Show plan<\/summary>\n\n```diff\nTerraform will perform the following actions:\n!   resource "x" "a" \{\}\n```\n\n<\/details>\n/);
});

test('renderPlan without a report shows the text diff, cut to fit the limit', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `  + line ${i} ${'y'.repeat(20)}`);
  const { body } = renderPlan({ ...base, text: `Terraform will perform the following actions:\n${lines.join('\n')}\n`, secrets: ['line 4999'] });
  assert.ok(body.length <= COMMENT_LIMIT);
  assert.match(body, /\+   line 0 y+\n/);
  assert.ok(!body.includes('line 4999'));
  assert.match(body, /```\n\n<\/details>\n\n_Cut off: GitHub limits a comment to 65536 characters; see the \[workflow run\]/);
  assert.ok(body.endsWith('</sub>\n'));
});

test('renderPlan fences text that holds backticks with a longer fence', () => {
  const { body } = renderPlan({ ...base, text: 'Terraform will perform the following actions:\n  + x = "```"\n' });
  assert.match(body, /````diff\n[^]*\n````\n/);
});
