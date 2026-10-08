'use strict';

// Usage: node test/scripts/push-direct.js <state name>
// Pushes a copy of the newest version with serial + 100, bypassing the lock,
// to simulate a writer the server did not see.

const { createStore, serialOf, annotationsFor } = require('../../src/core/store');
const { encrypt, decrypt, isEncrypted, aadFor } = require('../../src/core/crypto');
const { imageName, tagSlug } = require('../../src/core/names');

async function main() {
  const name = process.argv[2];
  const repository = process.env.GITHUB_REPOSITORY;
  const passphrase = process.env.PASSPHRASE;
  const slug = tagSlug(name);
  const store = createStore({ image: imageName(repository), token: process.env.GH_TOKEN });
  const resolved = await store.resolve(slug);
  if (!resolved) throw new Error(`no version tagged ${slug}`);
  const pulled = await store.pull(resolved);
  const plain = isEncrypted(pulled.bytes) ? decrypt(pulled.bytes, passphrase, aadFor(repository, name)) : pulled.bytes;
  const doc = JSON.parse(plain.toString('utf8'));
  doc.serial = serialOf(resolved.manifest) + 100;
  const bytes = encrypt(Buffer.from(JSON.stringify(doc)), passphrase, aadFor(repository, name));
  await store.push({
    bytes,
    mediaType: pulled.mediaType,
    annotations: annotationsFor({ name, serial: doc.serial, lineage: doc.lineage, encrypted: true, runId: process.env.GITHUB_RUN_ID, sha: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF, previous: resolved.digest, source: `https://github.com/${repository}` }),
    tags: [`${slug}.v${doc.serial}`, slug],
  });
  console.log(`pushed ${slug} serial ${doc.serial} behind the lock's back`);
}

main().catch((err) => { console.error(`::error::${err.message}`); process.exit(1); });
