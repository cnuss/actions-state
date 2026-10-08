'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

let debug = () => {};
function setDebug(fn) { debug = fn; }

// Query strings can carry SAS signatures and tokens; log without them.
function redactUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return `${u.origin}${u.pathname}`;
  } catch { return urlStr; }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const BLOB_TIMEOUT_MS = 300_000;

// One request, one fresh socket: keep-alive pins a client to one cache replica.
// timeoutMs bounds socket inactivity; 0 disables it.
function request(method, urlStr, headers = {}, body = null, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const data = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(body));
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: { Connection: 'close', ...headers },
      agent: false,
    };
    if (timeoutMs) opts.timeout = timeoutMs;
    if (data) opts.headers['Content-Length'] = data.length;
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        debug(`${method} ${res.statusCode} ${redactUrl(urlStr)}`);
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    if (data) req.write(data);
    req.end();
  });
}

function parseJson(text) {
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

function isThrottled(res) { return res.status === 429 || res.status >= 500; }

// Retry-After in seconds or as an HTTP date.
function retryAfterMs(headers, fallbackMs) {
  const v = headers && headers['retry-after'];
  if (!v) return fallbackMs;
  const secs = Number(v);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(v) - Date.now();
  return Math.min(Math.max(Number.isFinite(ms) ? ms : fallbackMs, 0), 60_000);
}

function cacheClient({ token, resultsUrl }) {
  if (!token || !resultsUrl) {
    throw new Error('ACTIONS_RUNTIME_TOKEN / ACTIONS_RESULTS_URL not present — is this running as an action in GitHub Actions?');
  }
  const base = `${resultsUrl.replace(/\/$/, '')}/twirp/github.actions.results.api.v1.CacheService`;
  return async (method, body) => {
    const res = await request('POST', `${base}/${method}`, {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }, JSON.stringify(body));
    return { status: res.status, headers: res.headers, json: parseJson(res.text), text: res.text };
  };
}

function restClient({ token, apiUrl = 'https://api.github.com' }) {
  const api = apiUrl.replace(/\/$/, '');
  return async (method, path, body) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'actions-state',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await request(method, `${api}${path}`, headers, body === undefined ? null : JSON.stringify(body));
    return { status: res.status, headers: res.headers, json: parseJson(res.text), text: res.text };
  };
}

// Signed cache-blob URLs.
const blobs = {
  async put(url, bytes) {
    const r = await request('PUT', url, { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/octet-stream' }, bytes, { timeoutMs: BLOB_TIMEOUT_MS });
    if (r.status < 200 || r.status >= 300) throw new Error(`blob upload failed: HTTP ${r.status}`);
  },
  async get(url) {
    const r = await request('GET', url, {}, null, { timeoutMs: BLOB_TIMEOUT_MS });
    return r.status === 200 ? r.buffer : null;
  },
};

module.exports = {
  DEFAULT_TIMEOUT_MS, BLOB_TIMEOUT_MS,
  request, parseJson, isThrottled, retryAfterMs, redactUrl, setDebug, cacheClient, restClient, blobs,
};
