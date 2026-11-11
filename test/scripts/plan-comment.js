'use strict';

// Usage: node test/scripts/plan-comment.js <state name>
// Prints this pull request's plan comment for the state; fails if there is none.

const { restClient } = require('../../src/core/http');
const { pullRequestOf } = require('../../src/core/github');
const { marker } = require('../../src/plan');

async function main() {
  const name = process.argv[2];
  const pr = pullRequestOf(process.env);
  if (!pr) throw new Error('not a pull request run');
  const rest = restClient({ token: process.env.GH_TOKEN });
  const repository = process.env.GITHUB_REPOSITORY;
  for (let page = 1; ; page += 1) {
    const r = await rest('GET', `/repos/${repository}/issues/${pr.number}/comments?per_page=100&page=${page}`);
    if (r.status !== 200) throw new Error(`listing comments: HTTP ${r.status}: ${r.text}`);
    const found = r.json.find((c) => c.body.startsWith(marker(name)));
    if (found) {
      process.stdout.write(found.body);
      return;
    }
    if (r.json.length < 100) throw new Error(`#${pr.number} has no plan comment for "${name}"`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
