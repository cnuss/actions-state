'use strict';

// In-memory stand-in for the Actions cache service, its signed blob URLs, and
// the REST endpoints lock.js uses.
function createFakeCache({ repository = 'o/r', ref = 'refs/heads/main' } = {}) {
  let nextId = 1000;
  let currentRef = ref;
  const entries = new Map();
  const jobs = new Map();
  const throttle = {};
  const k = (key, version) => `${key}\u0000${version}`;
  const byId = (id) => [...entries.values()].find((e) => String(e.id) === String(id));
  const reply = (status, json, headers = {}) => ({ status, headers, json, text: JSON.stringify(json) });

  async function twirp(method, body) {
    if (throttle[method] > 0) {
      throttle[method] -= 1;
      return reply(429, { code: 'resource_exhausted' }, { 'retry-after': '1' });
    }
    if (method === 'CreateCacheEntry') {
      if (entries.has(k(body.key, body.version))) return reply(409, { code: 'already_exists' });
      const id = nextId++;
      entries.set(k(body.key, body.version), {
        id, key: body.key, version: body.version, ref: currentRef, bytes: null, finalized: false, created_at: new Date().toISOString(),
      });
      return reply(200, { ok: true, signed_upload_url: `fake://upload/${id}` });
    }
    if (method === 'FinalizeCacheEntryUpload') {
      const e = entries.get(k(body.key, body.version));
      if (!e || !e.bytes || e.bytes.length !== body.size_bytes) return reply(404, { code: 'not_found' });
      e.finalized = true;
      return reply(200, { ok: true, entry_id: String(e.id) });
    }
    if (method === 'GetCacheEntryDownloadURL') {
      const e = entries.get(k(body.key, body.version));
      return reply(200, e && e.finalized ? { ok: true, signed_download_url: `fake://download/${e.id}` } : { ok: false });
    }
    throw new Error(`fake cache: unknown method ${method}`);
  }

  const blobs = {
    async put(url, bytes) {
      const e = byId(url.split('/').pop());
      if (!e) throw new Error('fake cache: upload without a reservation');
      e.bytes = Buffer.from(bytes);
    },
    async get(url) {
      const e = byId(url.split('/').pop());
      return e && e.finalized ? e.bytes : null;
    },
  };

  async function rest(method, path) {
    const [p, q = ''] = path.split('?');
    const params = new URLSearchParams(q);
    let m;
    if (method === 'GET' && p === `/repos/${repository}/actions/caches`) {
      const prefix = params.get('key') || '';
      const wantRef = params.get('ref');
      const list = [...entries.values()]
        .filter((e) => e.finalized && e.key.startsWith(prefix) && (!wantRef || e.ref === wantRef))
        .sort((a, b) => b.id - a.id)
        .map((e) => ({ id: e.id, key: e.key, version: e.version, ref: e.ref, created_at: e.created_at }));
      return reply(200, { total_count: list.length, actions_caches: list });
    }
    if (method === 'DELETE' && (m = p.match(/^\/repos\/[^/]+\/[^/]+\/actions\/caches\/(\d+)$/))) {
      const e = byId(m[1]);
      if (!e) return reply(404, {});
      entries.delete(k(e.key, e.version));
      return { status: 204, headers: {}, json: {}, text: '' };
    }
    if (method === 'GET' && (m = p.match(/^\/repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)$/))) {
      const status = jobs.get(Number(m[1]));
      return status ? reply(200, { id: Number(m[1]), status }) : reply(404, {});
    }
    throw new Error(`fake rest: unhandled ${method} ${path}`);
  }

  return {
    twirp,
    rest,
    blobs,
    setJob(id, status) { jobs.set(id, status); },
    throttleNext(method, n) { throttle[method] = n; },
    setRef(r) { currentRef = r; },
    finalizedKeys() { return [...entries.values()].filter((e) => e.finalized).map((e) => e.key).sort(); },
  };
}

module.exports = { createFakeCache };
