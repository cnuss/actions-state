'use strict';

const path = require('path');
const crypto = require('crypto');

// Leaves room for ".v<serial>" inside OCI's 128-character tag limit.
const MAX_SLUG = 100;

// A root module's state name: its path relative to the workspace.
function deriveName(workingDirectory, workspace) {
  const rel = path.relative(workspace, path.resolve(workspace, workingDirectory || '.'));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`working-directory "${workingDirectory}" is outside the workspace`);
  }
  return rel === '' ? 'root' : rel.split(path.sep).join('/');
}

function tagSlug(name) {
  let slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  if (!slug) throw new Error(`state name "${name}" has no usable characters`);
  if (slug.length > MAX_SLUG) {
    const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 10);
    slug = `${slug.slice(0, MAX_SLUG - 11)}-${hash}`;
  }
  return slug;
}

function imageName(repository) { return `${repository.toLowerCase()}/actions-state`; }
function lockKey(slug) { return `actions-state/${slug}`; }
function holderKey(slug, entryId) { return `actions-state/${slug}/holder/${entryId}`; }

module.exports = { deriveName, tagSlug, imageName, lockKey, holderKey };
