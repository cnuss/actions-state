'use strict';

// Usage: node test/scripts/inspect.js <state name> [--min-serial N] [--expect-encrypted] [--wait SECONDS]
// Reads the state's newest GHCR version and checks it; prints a JSON summary.

const { createStore, serialOf } = require('../../src/core/store');
const { isEncrypted } = require('../../src/core/crypto');
const { imageName, tagSlug } = require('../../src/core/names');

async function main() {
  const [name, ...args] = process.argv.slice(2);
  const flag = (f) => { const i = args.indexOf(f); return i === -1 ? null : (args[i + 1] ?? true); };
  const slug = tagSlug(name);
  const store = createStore({ image: imageName(process.env.GITHUB_REPOSITORY), token: process.env.GH_TOKEN });

  const deadline = Date.now() + Number(flag('--wait') || 0) * 1000;
  let resolved = await store.resolve(slug);
  while (!resolved && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    resolved = await store.resolve(slug);
  }
  if (!resolved) throw new Error(`no version tagged ${slug}`);

  const pulled = await store.pull(resolved);
  const tags = (await store.listTags()).filter((t) => t === slug || t.startsWith(`${slug}.v`)).sort();
  const summary = { name, digest: resolved.digest, serial: serialOf(resolved.manifest), encrypted: isEncrypted(pulled.bytes), layer: pulled.mediaType, tags };
  console.log(JSON.stringify(summary, null, 2));

  const minSerial = flag('--min-serial');
  if (minSerial !== null && !(summary.serial >= Number(minSerial))) throw new Error(`serial ${summary.serial} < ${minSerial}`);
  if (flag('--expect-encrypted') && !summary.encrypted) throw new Error('layer is not encrypted');
  if (!tags.includes(`${slug}.v${summary.serial}`)) throw new Error(`missing tag ${slug}.v${summary.serial}`);
}

main().catch((err) => { console.error(`::error::${err.message}`); process.exit(1); });
