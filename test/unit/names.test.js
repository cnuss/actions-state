'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveName, tagSlug, imageName, lockKey, holderKey } = require('../../src/core/names');

test('deriveName: the workspace root is "root"', () => {
  assert.equal(deriveName('.', '/w'), 'root');
  assert.equal(deriveName('', '/w'), 'root');
});

test('deriveName: nested directories keep their path', () => {
  assert.equal(deriveName('infra/zone', '/w'), 'infra/zone');
  assert.equal(deriveName('./infra/zone/', '/w'), 'infra/zone');
  assert.equal(deriveName('/w/infra', '/w'), 'infra');
});

test('deriveName: refuses paths outside the workspace', () => {
  assert.throws(() => deriveName('../elsewhere', '/w'), /outside the workspace/);
});

test('deriveName: a directory named like ..foo is inside the workspace', () => {
  assert.equal(deriveName('..foo', '/w'), '..foo');
});

test('tagSlug: lowercases and replaces runs of unsafe characters', () => {
  assert.equal(tagSlug('infra/zone'), 'infra-zone');
  assert.equal(tagSlug('Infra Zone!!'), 'infra-zone-');
  assert.equal(tagSlug('root'), 'root');
});

test('tagSlug: trims leading dots and dashes', () => {
  assert.equal(tagSlug('..foo'), 'foo');
  assert.equal(tagSlug('/x'), 'x');
});

test('tagSlug: refuses names with no usable characters', () => {
  assert.throws(() => tagSlug('!!!'), /no usable characters/);
});

test('tagSlug: long names become 100 characters ending in a hash', () => {
  const slug = tagSlug('a'.repeat(150));
  assert.equal(slug.length, 100);
  assert.match(slug, /^a{89}-[0-9a-f]{10}$/);
  assert.notEqual(tagSlug('a'.repeat(150)), tagSlug('a'.repeat(151)));
});

test('image name and cache keys', () => {
  assert.equal(imageName('CNuss/Actions-State'), 'cnuss/actions-state/actions-state');
  assert.equal(lockKey('infra-zone'), 'actions-state/infra-zone');
  assert.equal(holderKey('infra-zone', 42), 'actions-state/infra-zone/holder/42');
});

test('tagSlug: refuses slugs shaped like another state\'s per-serial tag', () => {
  assert.throws(() => tagSlug('app.v2'), /per-serial tag.*different `name`/);
  assert.throws(() => tagSlug('App.V10'), /per-serial tag/);
  assert.equal(tagSlug('app.v2x'), 'app.v2x');
  assert.equal(tagSlug('app.v'), 'app.v');
});
