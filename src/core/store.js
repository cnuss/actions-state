'use strict';

// State versions as OCI artifacts in a registry (GHCR in production).

const crypto = require('crypto');
const { URL } = require('url');
const http = require('./http');

const ARTIFACT_TYPE = 'application/vnd.cnuss.actions-state.v1';
const MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const EMPTY_CONFIG = Buffer.from('{}');
const EMPTY = {
  mediaType: 'application/vnd.oci.empty.v1+json',
  digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  size: 2,
};
const PREFIX = 'io.github.cnuss.actions-state';

function digestOf(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function annotationsFor({ name, serial, lineage, encrypted, runId, sha, ref, previous, source, created = new Date().toISOString() }) {
  return {
    [`${PREFIX}.name`]: name,
    [`${PREFIX}.serial`]: String(serial),
    [`${PREFIX}.lineage`]: lineage || '',
    [`${PREFIX}.encrypted`]: String(Boolean(encrypted)),
    [`${PREFIX}.run-id`]: String(runId || ''),
    [`${PREFIX}.sha`]: sha || '',
    [`${PREFIX}.ref`]: ref || '',
    [`${PREFIX}.previous`]: previous || '',
    'org.opencontainers.image.source': source,
    'org.opencontainers.image.created': created,
  };
}

function serialOf(manifest) {
  const raw = manifest && manifest.annotations && manifest.annotations[`${PREFIX}.serial`];
  const v = Number(raw);
  return raw !== undefined && Number.isFinite(v) ? v : null;
}

function buildManifest({ layerDigest, layerSize, mediaType, annotations }) {
  return {
    schemaVersion: 2,
    mediaType: MANIFEST_TYPE,
    artifactType: ARTIFACT_TYPE,
    config: EMPTY,
    layers: [{ mediaType, digest: layerDigest, size: layerSize }],
    annotations,
  };
}

// Network failures, 429 and 5xx are worth retrying; other statuses are not.
function storeError(message, res) {
  const err = new Error(message);
  err.retryable = !res || res.status === 429 || res.status >= 500;
  return err;
}

function createStore({ registry = 'https://ghcr.io', image, token, request = http.request }) {
  const base = registry.replace(/\/$/, '');
  const service = new URL(base).host;
  let bearer = null;

  async function exchange() {
    const scope = `repository:${image}:pull,push`;
    let res;
    try {
      res = await request('GET', `${base}/token?scope=${encodeURIComponent(scope)}&service=${encodeURIComponent(service)}`, {
        Authorization: `Basic ${Buffer.from(`actions-state:${token}`).toString('base64')}`,
      });
    } catch (err) { throw storeError(`registry token: ${err.message}`, null); }
    if (res.status !== 200) throw storeError(`registry token: HTTP ${res.status}: ${res.text}`, res);
    const t = http.parseJson(res.text).token;
    if (!t) throw storeError('registry token: no token in the response', res);
    return t;
  }

  async function send(method, path, headers = {}, body = null, opts) {
    const url = path.startsWith('http') ? path : `${base}${path}`;
    const once = async () => {
      if (!bearer) bearer = await exchange();
      try { return await request(method, url, { Authorization: `Bearer ${bearer}`, ...headers }, body, opts); }
      catch (err) { throw storeError(`${method} ${path}: ${err.message}`, null); }
    };
    let res = await once();
    if (res.status === 401) { bearer = null; res = await once(); }
    return res;
  }

  async function resolve(tag) {
    const res = await send('GET', `/v2/${image}/manifests/${tag}`, { Accept: MANIFEST_TYPE });
    if (res.status === 404) return null;
    if (res.status !== 200) throw storeError(`reading manifest ${tag}: HTTP ${res.status}: ${res.text}`, res);
    return { digest: res.headers['docker-content-digest'] || digestOf(res.buffer), manifest: http.parseJson(res.text) };
  }

  async function pull(resolved) {
    const layer = resolved.manifest.layers && resolved.manifest.layers[0];
    if (!layer) throw storeError(`manifest ${resolved.digest} has no layer`, { status: 400 });
    const blobOpts = { timeoutMs: http.BLOB_TIMEOUT_MS };
    let res = await send('GET', `/v2/${image}/blobs/${layer.digest}`, {}, null, blobOpts);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      try { res = await request('GET', new URL(res.headers.location, base).toString(), {}, null, blobOpts); }
      catch (err) { throw storeError(`downloading layer: ${err.message}`, null); }
    }
    if (res.status !== 200) throw storeError(`downloading layer ${layer.digest}: HTTP ${res.status}`, res);
    if (digestOf(res.buffer) !== layer.digest) throw storeError(`layer ${layer.digest} failed its digest check`, { status: 400 });
    return { bytes: res.buffer, mediaType: layer.mediaType, annotations: resolved.manifest.annotations || {} };
  }

  async function uploadBlob(bytes) {
    const digest = digestOf(bytes);
    const head = await send('HEAD', `/v2/${image}/blobs/${digest}`);
    if (head.status === 200) return digest;
    const start = await send('POST', `/v2/${image}/blobs/uploads/`);
    if (start.status !== 202 || !start.headers.location) throw storeError(`starting upload: HTTP ${start.status}: ${start.text}`, start);
    const location = new URL(start.headers.location, base).toString();
    const sep = location.includes('?') ? '&' : '?';
    const put = await send('PUT', `${location}${sep}digest=${encodeURIComponent(digest)}`, { 'Content-Type': 'application/octet-stream' }, bytes, { timeoutMs: http.BLOB_TIMEOUT_MS });
    if (put.status !== 201) throw storeError(`uploading blob: HTTP ${put.status}: ${put.text}`, put);
    return digest;
  }

  // Uploads one version and points every tag at it; returns the manifest digest.
  async function push({ bytes, mediaType, annotations, tags }) {
    await uploadBlob(EMPTY_CONFIG);
    const layerDigest = await uploadBlob(bytes);
    const manifest = Buffer.from(JSON.stringify(buildManifest({ layerDigest, layerSize: bytes.length, mediaType, annotations })));
    for (const tag of tags) {
      const res = await send('PUT', `/v2/${image}/manifests/${tag}`, { 'Content-Type': MANIFEST_TYPE }, manifest);
      if (res.status !== 201) throw storeError(`tagging ${tag}: HTTP ${res.status}: ${res.text}`, res);
    }
    return digestOf(manifest);
  }

  async function listTags() {
    const res = await send('GET', `/v2/${image}/tags/list?n=1000`);
    if (res.status === 404) return [];
    if (res.status !== 200) throw storeError(`listing tags: HTTP ${res.status}: ${res.text}`, res);
    return http.parseJson(res.text).tags || [];
  }

  return { image, resolve, pull, push, listTags };
}

module.exports = {
  createStore, annotationsFor, serialOf, buildManifest, digestOf,
  ARTIFACT_TYPE, MANIFEST_TYPE, EMPTY, PREFIX,
};
