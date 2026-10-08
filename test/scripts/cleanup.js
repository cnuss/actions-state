'use strict';

// Usage: node test/scripts/cleanup.js <tag prefix>
// Deletes this repo's state package versions whose tags start with the prefix.

const { restClient } = require('../../src/core/http');
const { repoInfo } = require('../../src/core/github');
const { imageName } = require('../../src/core/names');

async function main() {
  const prefix = process.argv[2];
  const repository = process.env.GITHUB_REPOSITORY;
  const owner = repository.split('/')[0];
  const rest = restClient({ token: process.env.GH_TOKEN });
  const { ownerType } = await repoInfo(rest, repository);
  const scope = ownerType === 'Organization' ? `orgs/${owner}` : `users/${owner}`;
  const pkg = encodeURIComponent(imageName(repository).slice(owner.length + 1));
  let deleted = 0;
  for (let page = 1; ; page += 1) {
    const r = await rest('GET', `/${scope}/packages/container/${pkg}/versions?per_page=100&page=${page}`);
    if (r.status === 404) break;
    if (r.status !== 200) throw new Error(`listing versions: HTTP ${r.status}: ${r.text}`);
    const versions = Array.isArray(r.json) ? r.json : [];
    for (const v of versions) {
      const tags = (v.metadata && v.metadata.container && v.metadata.container.tags) || [];
      if (tags.some((t) => t.startsWith(prefix))) {
        const d = await rest('DELETE', `/${scope}/packages/container/${pkg}/versions/${v.id}`);
        if (d.status === 204) deleted += 1;
        else console.log(`could not delete version ${v.id}: HTTP ${d.status}`);
      }
    }
    if (versions.length < 100) break;
  }
  console.log(`deleted ${deleted} versions tagged ${prefix}*`);
}

main().catch((err) => { console.error(`::error::${err.message}`); process.exit(1); });
