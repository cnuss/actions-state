'use strict';

// Usage: node test/scripts/plan-comment.js <state name>
// Prints this pull request's plan comment for the state; fails if there is
// none, or more than one: later plans must edit the first comment.

const { restClient } = require('../../src/core/http');
const { pullRequestOf } = require('../../src/core/github');
const { marker } = require('../../src/plan');

async function main() {
  const name = process.argv[2];
  const pr = pullRequestOf(process.env);
  if (!pr) throw new Error('not a pull request run');
  const rest = restClient({ token: process.env.GH_TOKEN });
  const repository = process.env.GITHUB_REPOSITORY;
  const found = [];
  for (let page = 1; ; page += 1) {
    const r = await rest('GET', `/repos/${repository}/issues/${pr.number}/comments?per_page=100&page=${page}`);
    if (r.status !== 200) throw new Error(`listing comments: HTTP ${r.status}: ${r.text}`);
    found.push(...r.json.filter((c) => c.body.startsWith(marker(name))));
    if (r.json.length < 100) break;
  }
  if (!found.length) throw new Error(`#${pr.number} has no plan comment for "${name}"`);
  if (found.length > 1) throw new Error(`#${pr.number} has ${found.length} plan comments for "${name}": ${found.map((c) => c.id).join(', ')}`);
  console.error(`comment ${found[0].id}, created ${found[0].created_at}, updated ${found[0].updated_at}`);
  process.stdout.write(found[0].body);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
