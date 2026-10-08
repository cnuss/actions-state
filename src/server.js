'use strict';

// Terraform HTTP-backend server. createApp() is the protocol; start() runs it
// as the detached process the action launches.

const crypto = require('crypto');
const { URL } = require('url');
const box = require('./core/crypto');
const { parseJson } = require('./core/http');
const { annotationsFor, serialOf, PREFIX } = require('./core/store');

// One try plus three retries.
const PUSH_ATTEMPTS = 4;
// How long /shutdown waits for requests still being handled.
const SHUTDOWN_DRAIN_MS = 10_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createApp({
  password, lock, store, adapter, slug, name, isDefaultRef, allowAnyRef, lockTimeoutMs,
  passphrase, aad, meta,
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onHeldChange = () => {},
  onShutdown = () => {},
  shutdownDrainMs = SHUTDOWN_DRAIN_MS,
}) {
  const writable = isDefaultRef || allowAnyRef;
  let held = null;     // { id, info, virtual, entryId, holderId }
  let locking = null;  // lock info of a LOCK still waiting
  let loaded = null;   // { digest, serial } of the version Terraform last read
  let cache = null;    // { digest, serial, bytes } with bytes decrypted
  let pendingAbort = null; // AbortController of the LOCK still waiting
  let closed = false;      // set by /shutdown; no lock is granted after it
  const inflight = new Map(); // req -> promise of its handler

  function authorized(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) return false;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
    const want = Buffer.from(password);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }

  function send(res, status, body = '', headers = {}) {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
    res.end(body);
  }
  const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });
  const holderInfo = (current) => (current && current.holder && current.holder.lockInfo) || {};

  // Terraform prints a LOCK 403 as "invalid auth"; a 423 with this body shows the reason.
  const refusal = (info, why) => ({
    ID: 'refused-by-actions-state', Operation: info.Operation || '', Who: 'cnuss/actions-state',
    Version: '', Created: new Date().toISOString(), Path: name, Info: why,
  });

  // Two names can share a tag slug; a version without the annotation is accepted.
  function foreignOwner(resolved) {
    const owner = resolved?.manifest?.annotations?.[`${PREFIX}.name`];
    if (owner == null || owner === name) return null;
    return `tag "${slug}" holds state "${owner}", not "${name}"; give one of them a different name`;
  }

  async function loadLatest() {
    const resolved = await store.resolve(slug);
    const foreign = foreignOwner(resolved);
    if (foreign) throw new Error(foreign);
    if (!resolved) {
      loaded = { digest: null, serial: null };
      return null;
    }
    if (!cache || cache.digest !== resolved.digest) {
      const pulled = await store.pull(resolved);
      let bytes = pulled.bytes;
      if (box.isEncrypted(bytes)) {
        if (!passphrase) throw new Error(`state "${name}" is encrypted: set the passphrase input`);
        bytes = box.decrypt(bytes, passphrase, aad);
      }
      cache = { digest: resolved.digest, serial: serialOf(resolved.manifest), bytes };
    }
    loaded = { digest: cache.digest, serial: cache.serial };
    return cache.bytes;
  }

  async function save(bytes) {
    const current = await store.resolve(slug);
    const foreign = foreignOwner(current);
    if (foreign) return [409, foreign];
    const currentDigest = current ? current.digest : null;
    if (!loaded || loaded.digest !== currentDigest) {
      const was = loaded && loaded.serial !== null ? loaded.serial : 'none';
      const now = current ? serialOf(current.manifest) : 'none';
      return [409, `state changed since it was loaded (loaded serial ${was}, current serial ${now}); re-run to plan against the current state`];
    }
    const { serial, lineage } = adapter.stateMeta(bytes);
    const version = {
      bytes: passphrase ? box.encrypt(bytes, passphrase, aad) : bytes,
      mediaType: passphrase ? `${adapter.LAYER_MEDIA_TYPE}.enc` : adapter.LAYER_MEDIA_TYPE,
      annotations: annotationsFor({
        name, serial, lineage, encrypted: Boolean(passphrase),
        runId: meta.runId, sha: meta.sha, ref: meta.ref, previous: currentDigest, source: meta.source,
      }),
      tags: [`${slug}.v${serial}`, slug],
    };
    for (let attempt = 1; ; attempt += 1) {
      try {
        const digest = await store.push(version);
        cache = { digest, serial, bytes };
        loaded = { digest, serial };
        log(`saved "${name}" serial ${serial} as ${digest}`);
        return [200, ''];
      } catch (err) {
        if (!err.retryable || attempt >= PUSH_ATTEMPTS) return [502, `saving state to the registry failed: ${err.message}`];
        log(`saving "${name}" failed (${err.message}); retrying`);
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }

  async function releaseHeld() {
    if (!held) return;
    const h = held;
    if (!h.virtual) await lock.release(h);
    if (held === h) {
      held = null;
      onHeldChange(null);
    }
    log(`unlocked "${name}" (${h.id})`);
  }

  async function lockState(res, body) {
    const info = parseJson(body.toString('utf8'));
    if (!info.ID) return send(res, 400, 'lock request has no ID');
    if (closed) return sendJson(res, 423, refusal(info, 'state server is shutting down'));
    if (held) return held.id === info.ID ? send(res, 200) : sendJson(res, 423, held.info);
    if (locking) return sendJson(res, 423, locking);
    if (!writable && info.Operation !== 'OperationTypePlan') {
      const why = `${meta.ref} may only plan; set allow-apply-from-any-ref: true to apply from it`;
      log(`refused ${info.Operation} lock: ${why}`);
      return sendJson(res, 423, refusal(info, why));
    }

    const abort = new AbortController();
    const shuttingDown = () => sendJson(res, 423, refusal(info, 'state server is shutting down'));
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    pendingAbort = abort;
    locking = info;
    try {
      if (!writable) {
        const free = await lock.waitUntilFree({ waitMs: lockTimeoutMs, signal: abort.signal });
        if (abort.signal.aborted) return closed ? shuttingDown() : undefined;
        if (!free) return sendJson(res, 423, holderInfo(await lock.readCurrent({ ref: meta.defaultRef })));
        held = { id: info.ID, info, virtual: true };
        log(`plan lock on "${name}" (${info.ID}), not shared with other refs`);
        return send(res, 200);
      }
      const got = await lock.acquire({ info, waitMs: lockTimeoutMs, signal: abort.signal });
      if (!got.ok) {
        if (got.aborted) return closed ? shuttingDown() : undefined;
        log(`lock on "${name}" still held after ${lockTimeoutMs / 1000}s`);
        return sendJson(res, 423, holderInfo(got.current));
      }
      held = { id: info.ID, info, virtual: false, entryId: got.entryId, holderId: got.holderId };
      onHeldChange(held);
      if (abort.signal.aborted || closed) {
        await releaseHeld();
        return closed ? shuttingDown() : undefined;
      }
      log(`locked "${name}" for ${info.Operation} (${info.ID})`);
      return send(res, 200);
    } finally {
      locking = null;
      if (pendingAbort === abort) pendingAbort = null;
    }
  }

  // An empty body is terraform force-unlock: it never saved the lock info.
  async function unlockState(res, body) {
    const info = parseJson(body.toString('utf8'));
    if (held && (!info.ID || info.ID === held.id)) {
      await releaseHeld();
      return send(res, 200);
    }
    if (!writable) return send(res, 403, `${meta.ref} may only plan; force-unlock from the default branch`);
    const current = await lock.readCurrent();
    if (!current) return send(res, 200);
    if (await lock.forceRelease(info.ID || '')) {
      log(`force-unlocked "${name}"`);
      return send(res, 200);
    }
    return sendJson(res, 409, holderInfo(current));
  }

  async function postState(res, id, body) {
    if (!writable) {
      log(`refused save from ${meta.ref}`);
      return send(res, 403, `only the default branch may save state; set allow-apply-from-any-ref: true to allow ${meta.ref}`);
    }
    if (!id) {
      log('refused save without a lock ID (-lock=false)');
      return send(res, 409, 'saving state requires the state lock; -lock=false is not supported');
    }
    if (!held || held.id !== id) {
      log(`refused save: lock ${id} is not held by this server`);
      return send(res, 409, `lock ${id} is not held by this server`);
    }
    try { adapter.stateMeta(body); } catch {
      log('refused save: body is not a state file');
      return send(res, 400, 'request body is not a state file');
    }
    const [status, text] = await save(body);
    if (status !== 200) log(`refused save: ${text}`);
    return send(res, status, text);
  }

  // Every handler but the caller's own, capped at shutdownDrainMs.
  async function drain(except) {
    const pending = [...inflight].filter(([r]) => r !== except).map(([, p]) => p);
    if (!pending.length) return;
    let timer;
    const cap = new Promise((r) => { timer = setTimeout(() => r(true), shutdownDrainMs); });
    const capped = await Promise.race([Promise.allSettled(pending).then(() => false), cap]);
    clearTimeout(timer);
    if (capped) log(`shutting down with requests still in flight after ${shutdownDrainMs / 1000}s`);
  }

  async function handle(req, res) {
    const work = dispatch(req, res);
    inflight.set(req, work);
    try { return await work; } finally { inflight.delete(req); }
  }

  async function dispatch(req, res) {
    let route = req.method;
    try {
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        return send(res, 400, 'malformed request target');
      }
      route = `${req.method} ${url.pathname}`;
      const body = await readBody(req);
      if (!authorized(req)) return send(res, 401, 'unauthorized', { 'WWW-Authenticate': 'Basic realm="actions-state"' });
      switch (route) {
        case 'GET /health':
          return send(res, 200, 'ok');
        case 'POST /shutdown':
          closed = true;
          if (pendingAbort) pendingAbort.abort();
          await drain(req);
          await releaseHeld();
          send(res, 200, 'bye');
          return onShutdown();
        case 'GET /state': {
          const bytes = await loadLatest();
          return bytes ? send(res, 200, bytes, { 'Content-Type': 'application/json' }) : send(res, 404, 'no state yet');
        }
        case 'POST /state':
          return await postState(res, url.searchParams.get('ID'), body);
        case 'DELETE /state':
          return send(res, 405, 'deleting state is not supported');
        case 'LOCK /lock':
          return await lockState(res, body);
        case 'UNLOCK /lock':
          return await unlockState(res, body);
        default:
          return send(res, 404, 'not found');
      }
    } catch (err) {
      log(`${route} failed: ${err.message}`);
      return send(res, 500, err.message);
    }
  }

  return { handle, loadLatest, releaseHeld, get held() { return held; } };
}

// Detached-process entry. Non-secret configuration arrives as
// ACTIONS_STATE_CONFIG; secrets arrive as their own variables.
async function start(env = process.env) {
  const fs = require('fs');
  const nodeHttp = require('http');
  const { cacheClient, restClient, setDebug } = require('./core/http');
  const { createLock } = require('./core/lock');
  const { createStore } = require('./core/store');
  const { getAdapter } = require('./adapters');

  const cfg = JSON.parse(env.ACTIONS_STATE_CONFIG);
  const log = (msg) => process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
  if (env.RUNNER_DEBUG === '1' || env.ACTIONS_STEP_DEBUG === 'true') setDebug(log);
  const writeRunfile = (data) => {
    const tmp = `${cfg.runfile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, ...data }));
    fs.renameSync(tmp, cfg.runfile);
  };

  const rest = restClient({ token: env.ACTIONS_STATE_TOKEN, apiUrl: cfg.apiUrl });
  const lock = createLock({
    twirp: cacheClient({ token: env.ACTIONS_RUNTIME_TOKEN, resultsUrl: env.ACTIONS_RESULTS_URL }),
    rest, repository: cfg.repository, ref: cfg.ref, slug: cfg.slug, identity: cfg.identity, log,
  });
  const store = createStore({ registry: cfg.registry, image: cfg.image, token: env.ACTIONS_STATE_TOKEN });

  let port = null;
  const server = nodeHttp.createServer();
  const app = createApp({
    password: env.ACTIONS_STATE_PASSWORD, lock, store, adapter: getAdapter(cfg.adapter),
    slug: cfg.slug, name: cfg.name, isDefaultRef: cfg.isDefaultRef, allowAnyRef: cfg.allowAnyRef,
    lockTimeoutMs: cfg.lockTimeoutMs, passphrase: env.ACTIONS_STATE_PASSPHRASE || '', aad: cfg.aad, meta: cfg.meta, log,
    onHeldChange: (h) => writeRunfile({ port, held: h && !h.virtual ? [h.entryId, h.holderId].filter(Boolean) : [] }),
    onShutdown: () => setTimeout(() => process.exit(0), 50),
  });
  server.on('request', (req, res) => { app.handle(req, res); });

  // Fail fast on a wrong passphrase, before Terraform runs.
  try {
    await app.loadLatest();
  } catch (err) {
    writeRunfile({ error: err.message });
    throw err;
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  writeRunfile({ port, held: [] });
  log(`serving "${cfg.name}" on 127.0.0.1:${port}`);
}

module.exports = { createApp, start };

if (require.main === module) {
  start().catch((err) => {
    process.stderr.write(`${err.stack || err}\n`);
    process.exit(1);
  });
}
