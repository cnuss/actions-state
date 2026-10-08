'use strict';

// Cache-entry mutex, from cnuss/actions-mutex. CreateCacheEntry is an atomic
// reservation on key+version and a REST delete frees it. Waiters poll with the
// cheaper read and race CreateCacheEntry only when the lock looks free.

const crypto = require('crypto');
const http = require('./http');
const { lockKey, holderKey } = require('./names');

const ENVELOPE = 'actions-state-lock-v1';
const DEFAULT_TIMING = {
  pollDelayMs: 2000,
  pollJitterMs: 1000,
  // A stale replica can keep showing a released lock; race anyway this often.
  createFallbackMs: 15_000,
  maxPollDelayMs: 30_000,
  // Each check costs two REST calls; GITHUB_TOKEN gets 1,000 per hour per repository.
  reclaimIntervalMs: 60_000,
  holderPublishAttempts: 4,
};
const THROTTLE_FALLBACK_MS = 3000;

function versionFor(key) {
  return crypto.createHash('sha256').update(`${ENVELOPE}:${key}`).digest('hex');
}

function createLock({
  twirp, rest, repository, ref, slug, identity,
  blobs = http.blobs,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  timing = {},
  log = () => {},
}) {
  const t = { ...DEFAULT_TIMING, ...timing };
  const key = lockKey(slug);
  const version = versionFor(key);

  async function publish(k, uploadUrl, record) {
    const bytes = Buffer.from(JSON.stringify(record), 'utf8');
    await blobs.put(uploadUrl, bytes);
    const fin = await twirp('FinalizeCacheEntryUpload', { key: k, version: versionFor(k), size_bytes: bytes.length });
    if (fin.json.ok !== true) throw new Error(`FinalizeCacheEntryUpload not ok: ${fin.text}`);
    const id = String(fin.json.entry_id ?? fin.json.entryId ?? '');
    if (!id) throw new Error(`FinalizeCacheEntryUpload returned no entry_id: ${fin.text}`);
    return id;
  }

  async function readEntry(k) {
    const dl = await twirp('GetCacheEntryDownloadURL', { key: k, version: versionFor(k), restore_keys: [] });
    const url = dl.json.ok === true && (dl.json.signed_download_url || dl.json.signedDownloadUrl);
    if (!url) return null;
    const bytes = await blobs.get(url);
    if (!bytes) return null;
    const body = http.parseJson(bytes.toString('utf8'));
    return body.v === ENVELOPE ? body : null;
  }

  // 204 and 404 both leave the entry gone.
  async function deleteEntry(id) {
    const r = await rest('DELETE', `/repos/${repository}/actions/caches/${id}`);
    if (r.status === 204 || r.status === 404) return;
    throw new Error(`deleting cache entry ${id}: HTTP ${r.status}: ${r.text}`);
  }

  // The holder record is what makes an abandoned lock reclaimable, so it is
  // worth waiting out a throttled window for. Never throws: the lock is
  // already held, and an exception here would leak it.
  async function publishHolder(entryId, record) {
    const k = holderKey(slug, entryId);
    let why;
    try {
      for (let i = 1; i <= t.holderPublishAttempts; i += 1) {
        const create = await twirp('CreateCacheEntry', { key: k, version: versionFor(k) });
        const url = create.json.signed_upload_url || create.json.signedUploadUrl;
        if (url) return await publish(k, url, record);
        why = create.text;
        if (!http.isThrottled(create)) break;
        await sleep(http.retryAfterMs(create.headers, THROTTLE_FALLBACK_MS) + random() * t.pollJitterMs);
      }
    } catch (err) {
      why = err.message;
    }
    try {
      log(`could not publish holder record ${k}; if this job dies holding the lock it must be deleted by hand: ${why}`);
    } catch { /* logging must not leak the lock either */ }
    return '';
  }

  // The finalized lock entry and its holder record; null when the lock is free
  // (or reserved but not yet finalized).
  async function readCurrent({ ref: r = ref } = {}) {
    const q = `key=${encodeURIComponent(key)}&ref=${encodeURIComponent(r)}&sort=created_at&direction=desc&per_page=100`;
    const list = await rest('GET', `/repos/${repository}/actions/caches?${q}`);
    if (list.status !== 200) throw new Error(`listing cache entries: HTTP ${list.status}: ${list.text}`);
    const entry = (list.json.actions_caches || []).find((c) => c.key === key && c.version === version);
    if (!entry) return null;
    return { entryId: String(entry.id), holder: await readEntry(holderKey(slug, entry.id)) };
  }

  // Never reclaims a lock whose holder it cannot identify.
  async function reclaimIfAbandoned() {
    try {
      const current = await readCurrent();
      const who = current && current.holder && current.holder.identity;
      if (!who || !who.job_id) return false;
      const job = await rest('GET', `/repos/${repository}/actions/jobs/${who.job_id}`);
      if (job.status !== 200 || job.json.status !== 'completed') return false;
      log(`holder "${who.job_name}" (run ${who.run_id}) ended without releasing; reclaiming`);
      await deleteEntry(current.entryId);
      return true;
    } catch (err) {
      log(`reclaim check failed: ${err.message}`);
      return false;
    }
  }

  async function acquire({ info, waitMs, signal }) {
    const start = now();
    let lastCreate = -Infinity;
    let lastReclaim = start;
    let reclaimChecked = false;
    let looksFree = true;
    let delay = t.pollDelayMs;

    for (;;) {
      if (signal && signal.aborted) return { ok: false, aborted: true };
      let res;
      if (looksFree || now() - lastCreate >= t.createFallbackMs) {
        lastCreate = now();
        res = await twirp('CreateCacheEntry', { key, version });
        const url = res.json.signed_upload_url || res.json.signedUploadUrl;
        if (url) {
          const record = { v: ENVELOPE, identity, lockInfo: info, acquired_at: new Date(now()).toISOString() };
          let entryId;
          try { entryId = await publish(key, url, record); } catch (err) {
            // An unfinalized reservation blocks the key for the cache's reservation timeout.
            try { await deleteEntry(await publish(key, url, record)); } catch (cleanup) { log(`could not clear lock reservation ${key}: ${cleanup.message}`); }
            throw err;
          }
          const holderId = await publishHolder(entryId, record);
          return { ok: true, entryId, holderId };
        }
        if (!http.isThrottled(res) && res.json.code !== 'already_exists') {
          throw new Error(`unexpected CreateCacheEntry response (status ${res.status}): ${res.text}`);
        }
        looksFree = false;
      } else {
        res = await twirp('GetCacheEntryDownloadURL', { key, version, restore_keys: [] });
        if (!http.isThrottled(res)) {
          looksFree = res.json.ok !== true;
          if (looksFree) continue;
        }
      }

      const throttled = http.isThrottled(res);
      delay = throttled ? Math.min(delay * 2, t.maxPollDelayMs) : Math.max(delay * 0.9, t.pollDelayMs);
      if (now() - lastReclaim >= t.reclaimIntervalMs) {
        lastReclaim = now();
        reclaimChecked = true;
        if (await reclaimIfAbandoned()) { looksFree = true; continue; }
      }
      if (now() - start >= waitMs) {
        // A wait shorter than reclaimIntervalMs still gets one check.
        if (!reclaimChecked) {
          reclaimChecked = true;
          if (await reclaimIfAbandoned()) { looksFree = true; continue; }
        }
        try { return { ok: false, current: await readCurrent() }; } catch (err) {
          log(`could not read the current holder: ${err.message}`);
          return { ok: false, current: null };
        }
      }
      // After a 429, spread waiters across the next window.
      await sleep(throttled
        ? http.retryAfterMs(res.headers, THROTTLE_FALLBACK_MS) + random() * delay
        : delay + random() * t.pollJitterMs);
    }
  }

  async function release({ entryId, holderId }) {
    await deleteEntry(entryId);
    if (holderId) {
      try { await deleteEntry(holderId); } catch (err) { log(`leaving holder record ${holderId}: ${err.message}`); }
    }
  }

  // An empty lockId (what terraform force-unlock sends) releases any holder.
  async function forceRelease(lockId) {
    const current = await readCurrent();
    if (!current) return false;
    const heldId = current.holder && current.holder.lockInfo && current.holder.lockInfo.ID;
    if (lockId && heldId !== lockId) return false;
    await deleteEntry(current.entryId);
    return true;
  }

  // For refs that may only plan. Reads from other refs fall back to the
  // default branch's cache scope, so this sees the default branch's lock.
  async function waitUntilFree({ waitMs, signal }) {
    const start = now();
    for (;;) {
      if (signal && signal.aborted) return false;
      const res = await twirp('GetCacheEntryDownloadURL', { key, version, restore_keys: [] });
      if (!http.isThrottled(res) && res.json.ok !== true) return true;
      if (now() - start >= waitMs) return false;
      await sleep(http.isThrottled(res)
        ? http.retryAfterMs(res.headers, THROTTLE_FALLBACK_MS)
        : t.pollDelayMs + random() * t.pollJitterMs);
    }
  }

  return { key, version, acquire, release, readCurrent, forceRelease, waitUntilFree };
}

module.exports = { createLock, versionFor, ENVELOPE };
