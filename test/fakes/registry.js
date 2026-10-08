'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

// Minimal OCI distribution registry: token exchange, blob uploads, manifests
// by tag or digest, tag listing, and blob GETs that redirect as GHCR's do.
async function startFakeRegistry() {
  const blobs = new Map();
  const manifests = new Map();
  const uploads = new Map();
  const requests = [];
  const scopes = [];
  const sha = (b) => `sha256:${crypto.createHash('sha256').update(b).digest('hex')}`;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://registry');
      requests.push(`${req.method} ${url.pathname}`);
      const send = (status, data = '', headers = {}) => { res.writeHead(status, headers); res.end(data); };

      if (url.pathname === '/token') {
        if (!(req.headers.authorization || '').startsWith('Basic ')) return send(401);
        if (fake.denyToken) return send(403, JSON.stringify({ errors: [{ code: 'DENIED' }] }));
        scopes.push(url.searchParams.get('scope'));
        return send(200, JSON.stringify({ token: 'bearer-1' }), { 'Content-Type': 'application/json' });
      }
      if (url.pathname.startsWith('/_redirected/')) return send(200, blobs.get(url.pathname.slice('/_redirected/'.length)));
      if (req.headers.authorization !== 'Bearer bearer-1') return send(401);

      let m;
      if ((m = url.pathname.match(/^\/v2\/(.+)\/blobs\/uploads\/(.*)$/))) {
        if (req.method === 'POST') {
          if (fake.denyPush) return send(403, JSON.stringify({ errors: [{ code: 'DENIED' }] }));
          const id = crypto.randomUUID();
          uploads.set(id, m[1]);
          return send(202, '', { Location: `/v2/${m[1]}/blobs/uploads/${id}?state=x` });
        }
        if (req.method === 'DELETE') return send(uploads.delete(m[2]) ? 204 : 404);
        if (req.method === 'PUT') {
          const digest = url.searchParams.get('digest');
          if (!uploads.has(m[2]) || sha(body) !== digest) return send(400, 'DIGEST_INVALID');
          blobs.set(digest, body);
          return send(201, '', { 'Docker-Content-Digest': digest });
        }
      }
      if ((m = url.pathname.match(/^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]+)$/))) {
        if (!blobs.has(m[2])) return send(404);
        if (req.method === 'HEAD') return send(200);
        return send(307, '', { Location: `/_redirected/${m[2]}` });
      }
      if ((m = url.pathname.match(/^\/v2\/(.+)\/manifests\/(.+)$/))) {
        if (req.method === 'PUT') {
          const entry = { bytes: body, digest: sha(body), contentType: req.headers['content-type'] };
          manifests.set(`${m[1]}:${m[2]}`, entry);
          manifests.set(`${m[1]}:${entry.digest}`, entry);
          return send(201, '', { 'Docker-Content-Digest': entry.digest });
        }
        const entry = manifests.get(`${m[1]}:${m[2]}`);
        if (!entry) return send(404, JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
        return send(200, req.method === 'HEAD' ? '' : entry.bytes, { 'Content-Type': entry.contentType, 'Docker-Content-Digest': entry.digest });
      }
      if ((m = url.pathname.match(/^\/v2\/(.+)\/tags\/list$/))) {
        const prefix = `${m[1]}:`;
        const tags = [...manifests.keys()].filter((k) => k.startsWith(prefix) && !k.startsWith(`${prefix}sha256:`)).map((k) => k.slice(prefix.length));
        return send(200, JSON.stringify({ name: m[1], tags }), { 'Content-Type': 'application/json' });
      }
      return send(404);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // denyToken refuses the token exchange; denyPush refuses upload starts.
  const fake = {
    url: `http://127.0.0.1:${server.address().port}`,
    blobs, manifests, uploads, requests, scopes,
    denyToken: false,
    denyPush: false,
    close: () => new Promise((r) => server.close(r)),
  };
  return fake;
}

module.exports = { startFakeRegistry };
