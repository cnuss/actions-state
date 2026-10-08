# actions-state Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GitHub Action that serves Terraform/OpenTofu HTTP-backend state from a local server, locking with Actions cache entries and storing versions as OCI artifacts in GHCR.

**Architecture:** A dependency-free Node 24 JavaScript action. The main step checks the configuration, starts `src/server.js` as a detached process, and writes a `_override.tf` that points Terraform's `http` backend at it; the post step shuts the server down. The server is a thin protocol layer over `src/core/` (cache lock, GHCR store, encryption), with tool wiring isolated in `src/adapters/`.

**Tech Stack:** Node 24 built-ins only (`http`, `https`, `crypto`, `fs`, `child_process`), `node:test` for unit tests, GitHub Actions workflows for integration tests, Terraform 1.16.5 and OpenTofu 1.13.1 in tests.

**Spec:** `docs/superpowers/specs/2026-10-08-actions-state-design.md`

## Global Constraints

- No npm dependencies, no `package.json` dependencies, no build step. Node 24 runtime (`runs.using: node24`).
- Every third-party action in workflows is pinned to a full commit SHA with a `# vX.Y.Z` comment. Pins used in this plan:
  - `actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3`
  - `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`
  - `github/codeql-action/init@8aad20d150bbac5944a9f9d289da16a4b0d87c1e # v4.36.2`
  - `github/codeql-action/analyze@8aad20d150bbac5944a9f9d289da16a4b0d87c1e # v4.36.2`
- Workflows may only use GitHub-owned actions and `cnuss/*` (the repo's Actions policy), so Terraform and OpenTofu are installed by `test/scripts/install-tool.sh`, not by third-party setup actions.
- Package: `ghcr.io/<owner>/<repo>/actions-state`. Tags: `<slug>` (newest) and `<slug>.v<serial>`.
- Cache keys: `actions-state/<slug>` (lock) and `actions-state/<slug>/holder/<entry id>` (holder record).
- Artifact type `application/vnd.cnuss.actions-state.v1`; layer `application/vnd.cnuss.actions-state.tfstate.v1`, plus `.enc` when encrypted; annotation prefix `io.github.cnuss.actions-state.`.
- Encryption: `ASTE1` | salt 16 | nonce 12 | AES-256-GCM ciphertext | tag 16; key = scrypt(passphrase, salt, N=2^15, r=8, p=1, 32 bytes); AAD `<owner>/<repo>:<state name>`.
- Inputs: `working-directory` (`.`), `name` (derived), `passphrase`, `lock-timeout` (`600`), `replace-backend` (`false`), `allow-apply-from-any-ref` (`false`), `github-token` (`${{ github.token }}`). Outputs: `state-name`, `image`, `address`.
- Override file name: `actions_state_override.tf`. Backend username: `actions-state`. Password env: `TF_HTTP_PASSWORD`.
- Comments state the constraint only; no backstory (user's global rule).
- Commits are signed (the machine's git config does this) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Deviations from the spec, found while planning

These come from reading Terraform's `internal/backend/remote-state/http/client.go`; they refine the spec's protocol table and are already reflected in the tasks:

1. `terraform force-unlock` sends `UNLOCK` with an **empty body** (the client only holds lock info for locks it took). An empty-body `UNLOCK` therefore force-releases whatever holds the lock. An `UNLOCK` whose body names a different ID than the holder still gets 409.
2. Terraform prints a `LOCK` 403 as "HTTP remote state endpoint invalid auth". Refusing an apply on a plan-only ref therefore answers **423** with a lock-info body whose `Info` explains the refusal, which Terraform prints in its normal lock-error block.
3. Terraform prints any failed `POST` as just `HTTP error: <code>`. The server logs every refusal with its reason, the post step prints the log, and integration tests assert against the log.
4. A cache-service outage is not answered with 503. The lock treats 5xx like throttling and backs off, so `LOCK` answers 423 once `lock-timeout` runs out; any other unexpected cache reply surfaces as 500. Terraform fails to acquire the lock either way.

## Review Focus

1. **Terraform is cancelled while its `LOCK` request is waiting.** The server must not end up holding a lock nobody uses. → Task 9 test "a LOCK abandoned by its client leaves nothing held".
2. **Two Terraform processes in one job hit the same state at once.** The second `LOCK` must be refused with the first's info, never granted twice. → Task 9 test "a second LOCK while one is waiting is refused".
3. **`terraform force-unlock` (empty-body `UNLOCK`) against another job's lock.** It must release that lock. → Task 5 test "forceRelease with an empty ID releases any holder" and Task 9 test "UNLOCK with an empty body force-releases another job's lock".
4. **The same state name used twice in one job.** The second use must fail clearly, not fight over the runfile. → Task 10 test "claimRunfile refuses a second use of one state name".
5. **A `POST` whose body is not state JSON, or state without a serial.** 400 for the former; serial 0 for the latter rather than a crash. → Task 8 test "stateMeta defaults missing fields" and Task 9 test "POST with a non-state body is a 400".

---

## File Structure

```
action.yml                         inputs/outputs; main + post
index.js                           main/post; resolveConfig, jobPassword, claimRunfile
src/server.js                      createApp (protocol) and start (detached process entry)
src/core/http.js                   request, cacheClient, restClient, blobs, retry helpers
src/core/names.js                  deriveName, tagSlug, imageName, lockKey, holderKey
src/core/crypto.js                 encrypt, decrypt, isEncrypted, aadFor
src/core/lock.js                   createLock (cache-entry mutex)
src/core/github.js                 repoInfo, packageVisibility, findSelfJob
src/core/store.js                  createStore (GHCR), annotationsFor, serialOf, buildManifest
src/adapters/index.js              getAdapter
src/adapters/terraform.js          findBackends, check, wire, unwire, stateMeta
test/unit/*.test.js                node:test suites, one per module
test/fakes/cache.js                in-memory cache service + REST endpoints
test/fakes/registry.js             local OCI registry
test/fixtures/data/main.tf         terraform_data fixture
test/fixtures/s3-backend/main.tf   fixture that declares a backend
test/scripts/install-tool.sh       checksum-verified terraform/tofu install
test/scripts/inspect.js            reads a state's GHCR version for assertions
test/scripts/push-direct.js        pushes a newer version bypassing the lock
test/scripts/cleanup.js            deletes a run's package versions
.github/workflows/test.yml         unit tests (required check)
.github/workflows/integration.yml  end-to-end tests
.github/workflows/codeql.yml       copied from actions-mutex
.github/workflows/release.yml      copied from actions-mutex
```

---

### Task 1: Spike (throwaway, in actions-test)

Answers the spec's four questions before any product code exists. Nothing here is kept in actions-state.

**Files:**
- Create: `~/cnuss/actions-test/.github/workflows/state-spike.yml`
- Create: `~/cnuss/actions-test/.github/actions/state-spike-detached/action.yml`
- Create: `~/cnuss/actions-test/.github/actions/state-spike-detached/index.js`

- [ ] **Step 1: Write the detached-server probe action**

`~/cnuss/actions-test/.github/actions/state-spike-detached/action.yml`:

```yaml
name: state-spike-detached
description: Starts a detached HTTP server in main and stops it in post.
runs:
  using: node24
  main: index.js
  post: index.js
  post-if: always()
```

`~/cnuss/actions-test/.github/actions/state-spike-detached/index.js`:

```js
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const portFile = path.join(process.env.RUNNER_TEMP, 'state-spike.port');

if (process.argv[2] === 'serve') {
  const server = http.createServer((req, res) => {
    if (req.url === '/shutdown') { res.end('bye'); setTimeout(() => process.exit(0), 50); return; }
    res.end(`alive pid=${process.pid}`);
  });
  server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
} else if (process.env.STATE_post === 'true') {
  const port = fs.readFileSync(portFile, 'utf8');
  http.get(`http://127.0.0.1:${port}/shutdown`, (res) => {
    res.resume();
    res.on('end', () => {
      setTimeout(() => {
        http.get(`http://127.0.0.1:${port}/`).on('error', () => console.log('post: server stopped')).on('response', () => {
          console.log('::error::post: server still answering after shutdown');
          process.exitCode = 1;
        });
      }, 500);
    });
  }).on('error', (err) => { console.log(`::error::post: could not reach server: ${err.message}`); process.exitCode = 1; });
} else {
  fs.appendFileSync(process.env.GITHUB_STATE, 'post=true\n');
  const child = spawn(process.execPath, [__filename, 'serve'], { detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + 5000;
  const wait = () => {
    if (fs.existsSync(portFile)) { console.log(`main: server on ${fs.readFileSync(portFile, 'utf8')}`); return; }
    if (Date.now() > deadline) { console.log('::error::main: server did not start'); process.exitCode = 1; return; }
    setTimeout(wait, 100);
  };
  wait();
}
```

- [ ] **Step 2: Write the spike workflow**

`~/cnuss/actions-test/.github/workflows/state-spike.yml`:

```yaml
name: actions-state spike

# Throwaway checks for the actions-state design: GHCR nested names and custom
# artifact types, package visibility through GITHUB_TOKEN, Terraform and
# OpenTofu waiting on a slow LOCK, and a detached server across steps.

on:
  workflow_dispatch:
  push:
    branches: [mutex-spike]
    paths:
      - .github/workflows/state-spike.yml
      - .github/actions/state-spike-detached/**

permissions:
  contents: read
  packages: write

jobs:
  ghcr:
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: ${{ github.token }}
    steps:
      - name: Push an OCI artifact to a nested name with a custom artifactType
        run: |
          set -euo pipefail
          image=$(echo "${GITHUB_REPOSITORY}/actions-state-spike" | tr 'A-Z' 'a-z')
          token=$(curl -fsS -u "x:${GH_TOKEN}" "https://ghcr.io/token?scope=repository:${image}:pull,push&service=ghcr.io" | jq -r .token)
          auth="Authorization: Bearer ${token}"
          upload() {
            local digest="sha256:$(sha256sum "$1" | cut -d' ' -f1)"
            local loc
            loc=$(curl -fsS -o /dev/null -D - -X POST -H "$auth" "https://ghcr.io/v2/${image}/blobs/uploads/" | awk 'tolower($1)=="location:"{print $2}' | tr -d '\r')
            case "$loc" in http*) ;; *) loc="https://ghcr.io${loc}" ;; esac
            local sep='?'; case "$loc" in *\?*) sep='&' ;; esac
            curl -fsS -X PUT -H "$auth" -H 'Content-Type: application/octet-stream' --data-binary @"$1" "${loc}${sep}digest=${digest}" -o /dev/null
            echo "$digest"
          }
          printf '{}' > config.json
          echo '{"version":4,"serial":7,"lineage":"spike"}' > state.json
          cfg=$(upload config.json)
          layer=$(upload state.json)
          jq -n --arg cfg "$cfg" --arg layer "$layer" --argjson size "$(stat -c%s state.json)" --arg src "https://github.com/${GITHUB_REPOSITORY}" '{
            schemaVersion: 2,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            artifactType: "application/vnd.cnuss.actions-state.v1",
            config: {mediaType: "application/vnd.oci.empty.v1+json", digest: $cfg, size: 2},
            layers: [{mediaType: "application/vnd.cnuss.actions-state.tfstate.v1", digest: $layer, size: $size}],
            annotations: {"org.opencontainers.image.source": $src, "io.github.cnuss.actions-state.serial": "7"}
          }' > manifest.json
          for tag in spike-root.v7 spike-root; do
            curl -sS -X PUT -H "$auth" -H 'Content-Type: application/vnd.oci.image.manifest.v1+json' \
              --data-binary @manifest.json "https://ghcr.io/v2/${image}/manifests/${tag}" -o /dev/null -w "PUT ${tag}: HTTP %{http_code}\n"
          done
          echo "--- manifest by tag"
          curl -fsS -H "$auth" -H 'Accept: application/vnd.oci.image.manifest.v1+json' "https://ghcr.io/v2/${image}/manifests/spike-root" | jq '{artifactType, config: .config.mediaType, layer: .layers[0].mediaType}'
          echo "--- tags"
          curl -fsS -H "$auth" "https://ghcr.io/v2/${image}/tags/list" | jq -c .
          echo "--- blob (expect a redirect, then the state)"
          curl -sS -o /dev/null -w 'blob GET: HTTP %{http_code} -> %{redirect_url}\n' -H "$auth" "https://ghcr.io/v2/${image}/blobs/${layer}"
          curl -fsSL -H "$auth" "https://ghcr.io/v2/${image}/blobs/${layer}"

      - name: Read the package's visibility with GITHUB_TOKEN
        run: |
          owner=${GITHUB_REPOSITORY%%/*}
          name=$(printf '%s' "${GITHUB_REPOSITORY#*/}/actions-state-spike" | tr 'A-Z' 'a-z' | jq -sRr @uri)
          for scope in users orgs; do
            curl -sS -H "Authorization: Bearer ${GH_TOKEN}" -H 'Accept: application/vnd.github+json' \
              "https://api.github.com/${scope}/${owner}/packages/container/${name}" -o pkg.json -w "${scope}: HTTP %{http_code}\n"
            jq -c '{visibility, name, repository: .repository.full_name}' pkg.json || cat pkg.json
          done

  long-lock:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        tool: [terraform, tofu]
    steps:
      - name: Install ${{ matrix.tool }}
        run: |
          set -euo pipefail
          if [ "${{ matrix.tool }}" = terraform ]; then
            v=1.16.5; base="https://releases.hashicorp.com/terraform/${v}"; zip="terraform_${v}_linux_amd64.zip"
          else
            v=1.13.1; base="https://github.com/opentofu/opentofu/releases/download/v${v}"; zip="tofu_${v}_linux_amd64.zip"
          fi
          curl -fsSLO "${base}/${zip}"
          sudo unzip -o -q "$zip" -d /usr/local/bin "${{ matrix.tool }}"

      - name: Plan against a server that holds LOCK open for 300 s
        run: |
          set -euo pipefail
          cat > server.js <<'EOF'
          const http = require('http');
          http.createServer((req, res) => {
            console.log(new Date().toISOString(), req.method, req.url);
            if (req.method === 'LOCK') { setTimeout(() => res.end(), 300000); return; }
            if (req.method === 'GET') { res.statusCode = 404; res.end(); return; }
            res.end();
          }).listen(8765, '127.0.0.1');
          EOF
          node server.js > server.log 2>&1 &
          sleep 1
          cat > main.tf <<'EOF'
          terraform {
            backend "http" {
              address        = "http://127.0.0.1:8765/state"
              lock_address   = "http://127.0.0.1:8765/lock"
              unlock_address = "http://127.0.0.1:8765/lock"
            }
          }
          resource "terraform_data" "x" {}
          EOF
          ${{ matrix.tool }} init -input=false
          start=$(date +%s)
          ${{ matrix.tool }} plan -input=false
          echo "plan waited $(( $(date +%s) - start ))s for the lock"
          cat server.log

  detached:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - uses: ./.github/actions/state-spike-detached
      - name: Reach the server from a later step
        run: |
          sleep 2
          curl -fsS "http://127.0.0.1:$(cat "$RUNNER_TEMP/state-spike.port")/"
      - name: And from the step after that
        run: curl -fsS "http://127.0.0.1:$(cat "$RUNNER_TEMP/state-spike.port")/"
```

- [ ] **Step 3: Push and run**

```bash
cd ~/cnuss/actions-test && git switch mutex-spike && git pull --ff-only
actionlint .github/workflows/state-spike.yml
git add .github/workflows/state-spike.yml .github/actions/state-spike-detached
git commit -m "Spike: GHCR artifacts, package visibility, slow LOCK, detached server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
sleep 10
id=$(gh run list -w state-spike.yml -L 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$id" --interval 15
gh run view "$id" --log | grep -vE '##\[group\]|##\[endgroup\]' | grep -E 'PUT |artifactType|tags|blob GET|serial|users:|orgs:|visibility|waited|main:|post:|alive' 
```

Expected:
- `PUT spike-root.v7: HTTP 201` and `PUT spike-root: HTTP 201`; the manifest shows `artifactType: application/vnd.cnuss.actions-state.v1`; tags list both; the blob GET is a 307 and `-L` returns the state JSON.
- One of `users:`/`orgs:` is `HTTP 200` with `"visibility"` set.
- Both `long-lock` jobs succeed and print `plan waited 30Xs`.
- `detached` prints `main: server on <port>`, two `alive pid=...` lines and `post: server stopped`.

- [ ] **Step 4: Record results and decide**

Write the results into the spec under a new `## Spike results` section (one line per check, with the run URL) and commit in `~/cnuss/actions-state`:

```bash
cd ~/cnuss/actions-state
git add docs/superpowers/specs/2026-10-08-actions-state-design.md
git commit -m "Spec: spike results

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Gate:** if the GHCR check or the long-lock check fails, stop and bring the failure back to the user as a design change before Task 2. If package visibility is unreadable (403/404 for an existing package), change `packageVisibility` in Task 6 to return `null` on 403 as well, note it in the spec, and continue: the repo-visibility check still guards public repos.

---

### Task 2: Repository scaffold, hygiene files, names module

**Files:**
- Create: `LICENSE`, `SECURITY.md`, `.gitignore`, `.github/CODEOWNERS`, `.github/dependabot.yml`, `.github/workflows/codeql.yml`, `.github/workflows/release.yml` (copied from actions-mutex, then edited)
- Create: `.github/workflows/test.yml`
- Create: `src/core/names.js`
- Test: `test/unit/names.test.js`

**Interfaces:**
- Produces: `deriveName(workingDirectory: string, workspace: string): string`, `tagSlug(name: string): string`, `imageName(repository: string): string`, `lockKey(slug: string): string`, `holderKey(slug: string, entryId: string|number): string`

- [ ] **Step 1: Copy the hygiene files from actions-mutex**

```bash
cd ~/cnuss/actions-state
cp ~/cnuss/actions-mutex/LICENSE ~/cnuss/actions-mutex/.gitignore .
mkdir -p .github/workflows
cp ~/cnuss/actions-mutex/.github/CODEOWNERS ~/cnuss/actions-mutex/.github/dependabot.yml .github/
cp ~/cnuss/actions-mutex/.github/workflows/codeql.yml ~/cnuss/actions-mutex/.github/workflows/release.yml .github/workflows/
sed 's/actions-mutex/actions-state/g' ~/cnuss/actions-mutex/SECURITY.md > SECURITY.md
```

Then replace the `## Scope` section of `SECURITY.md` with:

```markdown
## Scope

This action runs a local HTTP server that Terraform or OpenTofu uses as its
state backend. It takes locks by reserving entries in the Actions cache service,
stores state versions as OCI artifacts in GitHub Packages, and optionally
encrypts them with a caller-supplied passphrase. It reads runner-injected
environment (`ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RESULTS_URL`) and uses the
caller's own short-lived job tokens, which expire with the job.

In scope: state readable by anyone other than the repository's readers, state
decryptable without the passphrase, the local server answering requests without
the per-job password, releasing or stealing a lock held by a live job, token
leakage to logs, and supply-chain tampering with releases or tags.

Out of scope: what Terraform or OpenTofu itself does with state, and the
latency and eventual-consistency characteristics of the cache service.
```

- [ ] **Step 2: Write the unit-test workflow**

`.github/workflows/test.yml`:

```yaml
name: Unit tests

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  unit:
    name: Unit tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - run: node --test 'test/unit/**/*.test.js'
```

- [ ] **Step 3: Write the failing test**

`test/unit/names.test.js`:

```js
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
```

- [ ] **Step 4: Run it to see it fail**

Run: `node --test 'test/unit/**/*.test.js'`
Expected: FAIL with `Cannot find module '../../src/core/names'`

- [ ] **Step 5: Implement**

`src/core/names.js`:

```js
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
```

- [ ] **Step 6: Run the tests**

Run: `node --test 'test/unit/**/*.test.js'`
Expected: PASS, 9 tests

- [ ] **Step 7: Commit**

```bash
git add LICENSE SECURITY.md .gitignore .github src/core/names.js test/unit/names.test.js
git commit -m "Scaffold: hygiene files, unit-test workflow, state names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Encryption envelope

**Files:**
- Create: `src/core/crypto.js`
- Test: `test/unit/crypto.test.js`

**Interfaces:**
- Produces: `encrypt(plaintext: Buffer, passphrase: string, aad: string): Buffer`, `decrypt(blob: Buffer, passphrase: string, aad: string): Buffer` (throws `Error('decryption failed: wrong passphrase or tampered state')`), `isEncrypted(blob: Buffer): boolean`, `aadFor(repository: string, name: string): string`, `MAGIC: Buffer`

- [ ] **Step 1: Write the failing test**

`test/unit/crypto.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encrypt, decrypt, isEncrypted, aadFor, MAGIC } = require('../../src/core/crypto');

const state = Buffer.from('{"version":4,"serial":1}');

test('round trip', () => {
  const blob = encrypt(state, 'correct horse battery', 'o/r:root');
  assert.ok(isEncrypted(blob));
  assert.deepEqual(decrypt(blob, 'correct horse battery', 'o/r:root'), state);
});

test('layout: magic, salt, nonce, ciphertext, tag', () => {
  const blob = encrypt(state, 'p', 'a');
  assert.ok(blob.subarray(0, 5).equals(MAGIC));
  assert.equal(blob.length, 5 + 16 + 12 + state.length + 16);
});

test('every encryption uses a fresh salt and nonce', () => {
  assert.notDeepEqual(encrypt(state, 'p', 'a'), encrypt(state, 'p', 'a'));
});

test('a wrong passphrase fails', () => {
  const blob = encrypt(state, 'right', 'a');
  assert.throws(() => decrypt(blob, 'wrong', 'a'), /wrong passphrase or tampered state/);
});

test('a blob moved to another repo or state name fails', () => {
  const blob = encrypt(state, 'p', 'o/r:root');
  assert.throws(() => decrypt(blob, 'p', 'o/r:other'), /wrong passphrase or tampered state/);
});

test('tampered ciphertext fails', () => {
  const blob = encrypt(state, 'p', 'a');
  blob[blob.length - 20] ^= 1;
  assert.throws(() => decrypt(blob, 'p', 'a'), /wrong passphrase or tampered state/);
});

test('plaintext is not mistaken for an encrypted blob', () => {
  assert.equal(isEncrypted(state), false);
  assert.throws(() => decrypt(state, 'p', 'a'), /not an actions-state encrypted blob/);
});

test('aadFor binds repository and state name', () => {
  assert.equal(aadFor('o/r', 'infra/zone'), 'o/r:infra/zone');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/unit/crypto.test.js`
Expected: FAIL with `Cannot find module '../../src/core/crypto'`

- [ ] **Step 3: Implement**

`src/core/crypto.js`:

```js
'use strict';

const crypto = require('crypto');

const MAGIC = Buffer.from('ASTE1');
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
// N=2^15, r=8 needs 32 MiB, exactly scrypt's default maxmem; raise the ceiling.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, SCRYPT);
}

function isEncrypted(blob) {
  return blob.length >= MAGIC.length && blob.subarray(0, MAGIC.length).equals(MAGIC);
}

function aadFor(repository, name) { return `${repository}:${name}`; }

// MAGIC | salt | nonce | ciphertext | tag
function encrypt(plaintext, passphrase, aad) {
  const salt = crypto.randomBytes(SALT_LEN);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, salt, nonce, body, cipher.getAuthTag()]);
}

function decrypt(blob, passphrase, aad) {
  const head = MAGIC.length + SALT_LEN + NONCE_LEN;
  if (!isEncrypted(blob) || blob.length < head + TAG_LEN) {
    throw new Error('decryption failed: not an actions-state encrypted blob');
  }
  const salt = blob.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const nonce = blob.subarray(MAGIC.length + SALT_LEN, head);
  const body = blob.subarray(head, blob.length - TAG_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error('decryption failed: wrong passphrase or tampered state');
  }
}

module.exports = { MAGIC, encrypt, decrypt, isEncrypted, aadFor };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/unit/crypto.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/crypto.js test/unit/crypto.test.js
git commit -m "Encryption envelope: AES-256-GCM with a scrypt key, bound to repo and state name

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: HTTP helpers

**Files:**
- Create: `src/core/http.js`
- Test: `test/unit/http.test.js`

**Interfaces:**
- Produces:
  - `request(method, url, headers = {}, body = null): Promise<{ status, headers, buffer: Buffer, text: string }>` (http or https by URL; fresh socket; no redirects followed)
  - `parseJson(text): object` (`{}` on failure)
  - `isThrottled(res): boolean` (429 or ≥500)
  - `retryAfterMs(headers, fallbackMs): number` (capped at 60 000)
  - `redactUrl(url): string`
  - `setDebug(fn)`
  - `cacheClient({ token, resultsUrl }): (method, body) => Promise<{ status, headers, json, text }>`
  - `restClient({ token, apiUrl }): (method, path, body?) => Promise<{ status, headers, json, text }>`
  - `blobs: { put(url, bytes): Promise<void>, get(url): Promise<Buffer|null> }`

- [ ] **Step 1: Write the failing test**

`test/unit/http.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeHttp = require('node:http');
const h = require('../../src/core/http');

function serve(handler) {
  return new Promise((resolve) => {
    const server = nodeHttp.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

test('request sends method, headers and body on a closed connection', async () => {
  let seen;
  const srv = await serve((req, res, body) => {
    seen = { method: req.method, path: req.url, auth: req.headers.authorization, body, connection: req.headers.connection };
    res.writeHead(201, { 'x-test': '1' });
    res.end('done');
  });
  const r = await h.request('PUT', `${srv.url}/p?q=1`, { Authorization: 'Bearer t' }, 'hello');
  await srv.close();
  assert.equal(r.status, 201);
  assert.equal(r.text, 'done');
  assert.equal(r.headers['x-test'], '1');
  assert.deepEqual(seen, { method: 'PUT', path: '/p?q=1', auth: 'Bearer t', body: 'hello', connection: 'close' });
});

test('cacheClient posts twirp JSON with the runtime token', async () => {
  let seen;
  const srv = await serve((req, res, body) => {
    seen = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.end('{"ok":true}');
  });
  const twirp = h.cacheClient({ token: 'rt', resultsUrl: `${srv.url}/` });
  const r = await twirp('CreateCacheEntry', { key: 'k', version: 'v' });
  await srv.close();
  assert.equal(seen.path, '/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry');
  assert.equal(seen.auth, 'Bearer rt');
  assert.deepEqual(seen.body, { key: 'k', version: 'v' });
  assert.deepEqual(r.json, { ok: true });
});

test('cacheClient refuses to start without the runtime environment', () => {
  assert.throws(() => h.cacheClient({ token: '', resultsUrl: '' }), /ACTIONS_RUNTIME_TOKEN/);
});

test('restClient sends GitHub API headers and parses JSON', async () => {
  let seen;
  const srv = await serve((req, res, body) => {
    seen = { path: req.url, method: req.method, accept: req.headers.accept, version: req.headers['x-github-api-version'], body };
    res.end('{"id":1}');
  });
  const rest = h.restClient({ token: 'gh', apiUrl: srv.url });
  const r = await rest('DELETE', '/repos/o/r/actions/caches/5');
  await srv.close();
  assert.deepEqual(seen, { path: '/repos/o/r/actions/caches/5', method: 'DELETE', accept: 'application/vnd.github+json', version: '2022-11-28', body: '' });
  assert.deepEqual(r.json, { id: 1 });
});

test('retryAfterMs honours seconds, falls back, and caps at a minute', () => {
  assert.equal(h.retryAfterMs({ 'retry-after': '5' }, 3000), 5000);
  assert.equal(h.retryAfterMs({}, 3000), 3000);
  assert.equal(h.retryAfterMs({ 'retry-after': '600' }, 3000), 60000);
});

test('isThrottled covers 429 and 5xx only', () => {
  assert.equal(h.isThrottled({ status: 429 }), true);
  assert.equal(h.isThrottled({ status: 503 }), true);
  assert.equal(h.isThrottled({ status: 409 }), false);
});

test('redactUrl hides SAS signatures', () => {
  assert.equal(h.redactUrl('https://x.blob.core/c?sv=1&sig=abc'), 'https://x.blob.core/c?sv=1&sig=REDACTED');
});

test('parseJson returns {} for bad input', () => {
  assert.deepEqual(h.parseJson('nope'), {});
  assert.deepEqual(h.parseJson(''), {});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/unit/http.test.js`
Expected: FAIL with `Cannot find module '../../src/core/http'`

- [ ] **Step 3: Implement**

`src/core/http.js`:

```js
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

let debug = () => {};
function setDebug(fn) { debug = fn; }

// Strip Azure SAS secrets before logging URLs.
function redactUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    for (const p of ['sig', 'skoid', 'sktid']) {
      if (u.searchParams.has(p)) u.searchParams.set(p, 'REDACTED');
    }
    return `${u.origin}${u.pathname}${u.search}`;
  } catch { return urlStr; }
}

// One request, one fresh socket: keep-alive pins a client to one cache replica.
function request(method, urlStr, headers = {}, body = null) {
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
    const r = await request('PUT', url, { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/octet-stream' }, bytes);
    if (r.status < 200 || r.status >= 300) throw new Error(`blob upload failed: HTTP ${r.status}`);
  },
  async get(url) {
    const r = await request('GET', url);
    return r.status === 200 ? r.buffer : null;
  },
};

module.exports = { request, parseJson, isThrottled, retryAfterMs, redactUrl, setDebug, cacheClient, restClient, blobs };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/unit/http.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/http.js test/unit/http.test.js
git commit -m "HTTP helpers: fresh-socket requests, cache and REST clients, blob transfer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Cache-entry lock

**Files:**
- Create: `test/fakes/cache.js`
- Create: `src/core/lock.js`
- Test: `test/unit/lock.test.js`

**Interfaces:**
- Consumes: `http.isThrottled`, `http.retryAfterMs`, `http.parseJson`, `http.blobs` (Task 4); `lockKey`, `holderKey` (Task 2)
- Produces: `createLock({ twirp, rest, repository, ref, slug, identity, blobs?, now?, sleep?, random?, timing?, log? })` returning:
  - `acquire({ info, waitMs, signal? }): Promise<{ ok: true, entryId: string, holderId: string } | { ok: false, current: Current|null } | { ok: false, aborted: true }>`
  - `release({ entryId, holderId }): Promise<void>`
  - `readCurrent({ ref? } = {}): Promise<Current|null>` where `Current = { entryId: string, holder: { v, identity, lockInfo, acquired_at } | null }`
  - `forceRelease(lockId: string): Promise<boolean>` (empty `lockId` releases any holder)
  - `waitUntilFree({ waitMs, signal? }): Promise<boolean>`
- `identity` shape: `{ run_id, run_attempt, job_id, job_name, job_url, ref }`

- [ ] **Step 1: Write the fake cache service**

`test/fakes/cache.js`:

```js
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
```

- [ ] **Step 2: Write the failing test**

`test/unit/lock.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLock } = require('../../src/core/lock');
const { createFakeCache } = require('../fakes/cache');

function clock() {
  let t = 0;
  const hooks = [];
  const sleeps = [];
  return {
    now: () => t,
    sleeps,
    sleep: async (ms) => { sleeps.push(ms); t += ms; const hook = hooks.shift(); if (hook) await hook(); },
    onNextSleep: (fn) => hooks.push(fn),
  };
}

const identity = (jobId) => ({ run_id: '1', run_attempt: '1', job_id: jobId, job_name: `job ${jobId}`, job_url: '', ref: 'refs/heads/main' });

function makeLock(fake, c, jobId = 1, extra = {}) {
  return createLock({
    twirp: fake.twirp, rest: fake.rest, blobs: fake.blobs,
    repository: 'o/r', ref: 'refs/heads/main', slug: 'root', identity: identity(jobId),
    now: c.now, sleep: c.sleep, random: () => 0, ...extra,
  });
}

test('acquire on a free lock publishes the lock and its holder record', async () => {
  const fake = createFakeCache();
  const lock = makeLock(fake, clock());
  const got = await lock.acquire({ info: { ID: 'a' }, waitMs: 0 });
  assert.equal(got.ok, true);
  assert.deepEqual(fake.finalizedKeys(), ['actions-state/root', `actions-state/root/holder/${got.entryId}`]);
  const current = await lock.readCurrent();
  assert.equal(current.entryId, got.entryId);
  assert.equal(current.holder.lockInfo.ID, 'a');
  assert.equal(current.holder.identity.job_id, 1);
});

test('a held lock with waitMs 0 reports the holder at once', async () => {
  const fake = createFakeCache();
  const c = clock();
  await makeLock(fake, c, 1).acquire({ info: { ID: 'a', Who: 'first' }, waitMs: 0 });
  const got = await makeLock(fake, c, 2).acquire({ info: { ID: 'b' }, waitMs: 0 });
  assert.equal(got.ok, false);
  assert.equal(got.current.holder.lockInfo.Who, 'first');
  assert.deepEqual(c.sleeps, []);
});

test('a waiter gets the lock once the holder releases', async () => {
  const fake = createFakeCache();
  const c = clock();
  const a = makeLock(fake, c, 1);
  const b = makeLock(fake, c, 2);
  const first = await a.acquire({ info: { ID: 'a' }, waitMs: 0 });
  c.onNextSleep(() => a.release(first));
  const got = await b.acquire({ info: { ID: 'b' }, waitMs: 60_000 });
  assert.equal(got.ok, true);
  assert.equal((await b.readCurrent()).holder.lockInfo.ID, 'b');
});

test('release deletes the lock and its holder record', async () => {
  const fake = createFakeCache();
  const lock = makeLock(fake, clock());
  await lock.release(await lock.acquire({ info: { ID: 'a' }, waitMs: 0 }));
  assert.deepEqual(fake.finalizedKeys(), []);
  assert.equal(await lock.readCurrent(), null);
});

test('reclaims a lock whose holder job has completed', async () => {
  const fake = createFakeCache();
  const c = clock();
  await makeLock(fake, c, 7).acquire({ info: { ID: 'a' }, waitMs: 0 });
  fake.setJob(7, 'completed');
  const got = await makeLock(fake, c, 8, { timing: { reclaimIntervalMs: 5000 } }).acquire({ info: { ID: 'b' }, waitMs: 120_000 });
  assert.equal(got.ok, true);
});

test('does not reclaim while the holder job is running', async () => {
  const fake = createFakeCache();
  const c = clock();
  await makeLock(fake, c, 7).acquire({ info: { ID: 'a' }, waitMs: 0 });
  fake.setJob(7, 'in_progress');
  const got = await makeLock(fake, c, 8, { timing: { reclaimIntervalMs: 5000 } }).acquire({ info: { ID: 'b' }, waitMs: 30_000 });
  assert.equal(got.ok, false);
  assert.equal(got.current.holder.lockInfo.ID, 'a');
});

test('forceRelease releases only a matching lock ID', async () => {
  const fake = createFakeCache();
  const c = clock();
  await makeLock(fake, c, 1).acquire({ info: { ID: 'a' }, waitMs: 0 });
  const other = makeLock(fake, c, 2);
  assert.equal(await other.forceRelease('not-a'), false);
  assert.equal(await other.forceRelease('a'), true);
  assert.equal(await other.readCurrent(), null);
});

test('forceRelease with an empty ID releases any holder', async () => {
  const fake = createFakeCache();
  const c = clock();
  await makeLock(fake, c, 1).acquire({ info: { ID: 'a' }, waitMs: 0 });
  assert.equal(await makeLock(fake, c, 2).forceRelease(''), true);
  assert.deepEqual(fake.finalizedKeys(), ['actions-state/root/holder/1000']);
});

test('waitUntilFree: true when free, false when held past waitMs, true once released', async () => {
  const fake = createFakeCache();
  const c = clock();
  const a = makeLock(fake, c, 1);
  assert.equal(await a.waitUntilFree({ waitMs: 0 }), true);
  const held = await a.acquire({ info: { ID: 'a' }, waitMs: 0 });
  assert.equal(await a.waitUntilFree({ waitMs: 10_000 }), false);
  c.onNextSleep(() => a.release(held));
  assert.equal(await a.waitUntilFree({ waitMs: 10_000 }), true);
});

test('a throttled CreateCacheEntry waits out Retry-After', async () => {
  const fake = createFakeCache();
  const c = clock();
  fake.throttleNext('CreateCacheEntry', 1);
  const got = await makeLock(fake, c).acquire({ info: { ID: 'a' }, waitMs: 60_000 });
  assert.equal(got.ok, true);
  assert.equal(c.sleeps[0], 1000);
});

test('an aborted acquire gives up without taking the lock', async () => {
  const fake = createFakeCache();
  const c = clock();
  await makeLock(fake, c, 1).acquire({ info: { ID: 'a' }, waitMs: 0 });
  const abort = new AbortController();
  c.onNextSleep(() => abort.abort());
  const got = await makeLock(fake, c, 2).acquire({ info: { ID: 'b' }, waitMs: 60_000, signal: abort.signal });
  assert.deepEqual(got, { ok: false, aborted: true });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --test test/unit/lock.test.js`
Expected: FAIL with `Cannot find module '../../src/core/lock'`

- [ ] **Step 4: Implement**

`src/core/lock.js`:

```js
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
  // worth waiting out a throttled window for.
  async function publishHolder(entryId, record) {
    const k = holderKey(slug, entryId);
    let create;
    for (let i = 1; i <= t.holderPublishAttempts; i += 1) {
      create = await twirp('CreateCacheEntry', { key: k, version: versionFor(k) });
      const url = create.json.signed_upload_url || create.json.signedUploadUrl;
      if (url) return publish(k, url, record);
      if (!http.isThrottled(create)) break;
      await sleep(http.retryAfterMs(create.headers, THROTTLE_FALLBACK_MS) + random() * t.pollJitterMs);
    }
    log(`could not publish holder record ${k}; if this job dies holding the lock it must be deleted by hand: ${create.text}`);
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
    const current = await readCurrent();
    const who = current && current.holder && current.holder.identity;
    if (!who || !who.job_id) return false;
    const job = await rest('GET', `/repos/${repository}/actions/jobs/${who.job_id}`);
    if (job.status !== 200 || job.json.status !== 'completed') return false;
    log(`holder "${who.job_name}" (run ${who.run_id}) ended without releasing; reclaiming`);
    await deleteEntry(current.entryId);
    return true;
  }

  async function acquire({ info, waitMs, signal }) {
    const start = now();
    let lastCreate = -Infinity;
    let lastReclaim = start;
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
          const entryId = await publish(key, url, record);
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
        if (await reclaimIfAbandoned()) { looksFree = true; continue; }
      }
      if (now() - start >= waitMs) return { ok: false, current: await readCurrent() };
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
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/unit/lock.test.js`
Expected: PASS, 11 tests

- [ ] **Step 6: Commit**

```bash
git add src/core/lock.js test/fakes/cache.js test/unit/lock.test.js
git commit -m "Cache-entry lock: acquire with wait, release, force-release, reclaim

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: GitHub lookups

**Files:**
- Create: `src/core/github.js`
- Test: `test/unit/github.test.js`

**Interfaces:**
- Consumes: a `rest(method, path)` function shaped like Task 4's `restClient`
- Produces:
  - `repoInfo(rest, repository): Promise<{ visibility: 'public'|'private'|'internal', defaultBranch: string, ownerType: 'User'|'Organization' }>`
  - `packageVisibility(rest, { ownerType, owner, packageName }): Promise<'public'|'private'|'internal'|null>` (null when the package does not exist)
  - `findSelfJob(rest, env, { attempts?, delayMs?, sleep? }): Promise<{ id: number, name: string, url: string }>`

- [ ] **Step 1: Write the failing test**

`test/unit/github.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { repoInfo, packageVisibility, findSelfJob } = require('../../src/core/github');

function stubRest(routes) {
  const calls = [];
  const rest = async (method, path) => {
    calls.push(`${method} ${path}`);
    const route = routes[`${method} ${path}`];
    if (!route) return { status: 404, json: {}, text: '' };
    const [status, json] = typeof route === 'function' ? route() : route;
    return { status, json, text: JSON.stringify(json) };
  };
  return { rest, calls };
}

test('repoInfo reads visibility, default branch and owner type', async () => {
  const { rest } = stubRest({ 'GET /repos/o/r': [200, { visibility: 'public', default_branch: 'main', owner: { type: 'User' } }] });
  assert.deepEqual(await repoInfo(rest, 'o/r'), { visibility: 'public', defaultBranch: 'main', ownerType: 'User' });
});

test('repoInfo falls back to the private flag when visibility is absent', async () => {
  const { rest } = stubRest({ 'GET /repos/o/r': [200, { private: true, default_branch: 'trunk', owner: { type: 'Organization' } }] });
  assert.equal((await repoInfo(rest, 'o/r')).visibility, 'private');
});

test('packageVisibility uses the users or orgs path with an encoded name', async () => {
  const user = stubRest({ 'GET /users/o/packages/container/r%2Factions-state': [200, { visibility: 'private' }] });
  assert.equal(await packageVisibility(user.rest, { ownerType: 'User', owner: 'o', packageName: 'r/actions-state' }), 'private');
  const org = stubRest({ 'GET /orgs/o/packages/container/r%2Factions-state': [200, { visibility: 'public' }] });
  assert.equal(await packageVisibility(org.rest, { ownerType: 'Organization', owner: 'o', packageName: 'r/actions-state' }), 'public');
});

test('packageVisibility is null when the package does not exist yet', async () => {
  const { rest } = stubRest({});
  assert.equal(await packageVisibility(rest, { ownerType: 'User', owner: 'o', packageName: 'r/actions-state' }), null);
});

test('findSelfJob matches the runner name among in-progress jobs, retrying while the API lags', async () => {
  let n = 0;
  const { rest } = stubRest({
    'GET /repos/o/r/actions/runs/9/attempts/1/jobs?per_page=100&page=1': () => {
      n += 1;
      const jobs = [{ id: 5, name: 'other', runner_name: 'GitHub Actions 2', status: 'in_progress', html_url: 'u5' }];
      if (n > 1) jobs.push({ id: 6, name: 'me', runner_name: 'GitHub Actions 1', status: 'in_progress', html_url: 'u6' });
      return [200, { jobs }];
    },
  });
  const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '1', RUNNER_NAME: 'GitHub Actions 1' };
  assert.deepEqual(await findSelfJob(rest, env, { sleep: async () => {} }), { id: 6, name: 'me', url: 'u6' });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/unit/github.test.js`
Expected: FAIL with `Cannot find module '../../src/core/github'`

- [ ] **Step 3: Implement**

`src/core/github.js`:

```js
'use strict';

async function repoInfo(rest, repository) {
  const r = await rest('GET', `/repos/${repository}`);
  if (r.status !== 200) throw new Error(`reading repository ${repository}: HTTP ${r.status}: ${r.text}`);
  return {
    visibility: r.json.visibility || (r.json.private ? 'private' : 'public'),
    defaultBranch: r.json.default_branch,
    ownerType: r.json.owner && r.json.owner.type,
  };
}

async function packageVisibility(rest, { ownerType, owner, packageName }) {
  const scope = ownerType === 'Organization' ? `orgs/${owner}` : `users/${owner}`;
  const r = await rest('GET', `/${scope}/packages/container/${encodeURIComponent(packageName)}`);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`reading package ${packageName}: HTTP ${r.status}: ${r.text}`);
  return r.json.visibility;
}

// This job, found by runner name among the run attempt's in-progress jobs. The
// jobs API can lag the job's start by a few seconds.
async function findSelfJob(rest, env, { attempts = 5, delayMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt, RUNNER_NAME: runner } = env;
  for (let tries = 1; tries <= attempts; tries += 1) {
    for (let page = 1; ; page += 1) {
      const r = await rest('GET', `/repos/${repo}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
      if (r.status !== 200) throw new Error(`listing this run's jobs: HTTP ${r.status}: ${r.text}`);
      const jobs = r.json.jobs || [];
      const job = jobs.find((j) => j.runner_name === runner && j.status === 'in_progress');
      if (job) return { id: job.id, name: job.name, url: job.html_url };
      if (jobs.length < 100) break;
    }
    if (tries < attempts) await sleep(delayMs);
  }
  throw new Error(`could not find this job (runner "${runner}") in run ${run} attempt ${attempt}`);
}

module.exports = { repoInfo, packageVisibility, findSelfJob };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/unit/github.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/github.js test/unit/github.test.js
git commit -m "GitHub lookups: repo and package visibility, this job's id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: GHCR store

**Files:**
- Create: `test/fakes/registry.js`
- Create: `src/core/store.js`
- Test: `test/unit/store.test.js`

**Interfaces:**
- Consumes: `http.request`, `http.parseJson` (Task 4)
- Produces:
  - `createStore({ registry?, image, token, request? })` returning `{ image, resolve(tag), pull(resolved), push({ bytes, mediaType, annotations, tags }), listTags() }`
    - `resolve(tag): Promise<{ digest: string, manifest: object } | null>`
    - `pull(resolved): Promise<{ bytes: Buffer, mediaType: string, annotations: object }>`
    - `push(version): Promise<string>` (manifest digest); errors carry `err.retryable: boolean`
  - `annotationsFor({ name, serial, lineage, encrypted, runId, sha, ref, previous, source, created? }): object`
  - `serialOf(manifest): number|null`
  - `buildManifest({ layerDigest, layerSize, mediaType, annotations }): object`
  - `digestOf(bytes): string`, `ARTIFACT_TYPE`, `MANIFEST_TYPE`, `EMPTY`, `PREFIX`

- [ ] **Step 1: Write the fake registry**

`test/fakes/registry.js`:

```js
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
        scopes.push(url.searchParams.get('scope'));
        return send(200, JSON.stringify({ token: 'bearer-1' }), { 'Content-Type': 'application/json' });
      }
      if (url.pathname.startsWith('/_redirected/')) return send(200, blobs.get(url.pathname.slice('/_redirected/'.length)));
      if (req.headers.authorization !== 'Bearer bearer-1') return send(401);

      let m;
      if ((m = url.pathname.match(/^\/v2\/(.+)\/blobs\/uploads\/(.*)$/))) {
        if (req.method === 'POST') {
          const id = crypto.randomUUID();
          uploads.set(id, m[1]);
          return send(202, '', { Location: `/v2/${m[1]}/blobs/uploads/${id}?state=x` });
        }
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
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    blobs, manifests, requests, scopes,
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { startFakeRegistry };
```

- [ ] **Step 2: Write the failing test**

`test/unit/store.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, annotationsFor, serialOf, digestOf, EMPTY, ARTIFACT_TYPE, PREFIX } = require('../../src/core/store');
const { startFakeRegistry } = require('../fakes/registry');

const LAYER = 'application/vnd.cnuss.actions-state.tfstate.v1';
const annotations = (serial) => annotationsFor({
  name: 'root', serial, lineage: 'L', encrypted: false, runId: '9', sha: 'abc',
  ref: 'refs/heads/main', previous: '', source: 'https://github.com/o/r', created: '2026-10-08T00:00:00Z',
});

test('resolve is null when the tag does not exist', async () => {
  const reg = await startFakeRegistry();
  const store = createStore({ registry: reg.url, image: 'o/r/actions-state', token: 'gh' });
  assert.equal(await store.resolve('root'), null);
  await reg.close();
});

test('push, resolve and pull round-trip one version', async () => {
  const reg = await startFakeRegistry();
  const store = createStore({ registry: reg.url, image: 'o/r/actions-state', token: 'gh' });
  const digest = await store.push({ bytes: Buffer.from('{"serial":3}'), mediaType: LAYER, annotations: annotations(3), tags: ['root.v3', 'root'] });
  const resolved = await store.resolve('root');
  assert.equal(resolved.digest, digest);
  assert.equal(resolved.manifest.artifactType, ARTIFACT_TYPE);
  assert.deepEqual(resolved.manifest.config, EMPTY);
  assert.equal(resolved.manifest.layers[0].mediaType, LAYER);
  assert.equal(serialOf(resolved.manifest), 3);
  assert.equal(resolved.manifest.annotations[`${PREFIX}.ref`], 'refs/heads/main');
  const pulled = await store.pull(resolved);
  assert.equal(pulled.bytes.toString(), '{"serial":3}');
  assert.deepEqual((await store.listTags()).sort(), ['root', 'root.v3']);
  assert.deepEqual(reg.scopes, ['repository:o/r/actions-state:pull,push']);
  await reg.close();
});

test('blobs already in the registry are not uploaded again', async () => {
  const reg = await startFakeRegistry();
  const store = createStore({ registry: reg.url, image: 'o/r/actions-state', token: 'gh' });
  const version = { bytes: Buffer.from('{"serial":1}'), mediaType: LAYER, annotations: annotations(1), tags: ['root'] };
  await store.push(version);
  const uploadsBefore = reg.requests.filter((r) => r.startsWith('POST ')).length;
  await store.push({ ...version, tags: ['root.v1'] });
  assert.equal(reg.requests.filter((r) => r.startsWith('POST ')).length, uploadsBefore);
  assert.equal(uploadsBefore, 2);
  await reg.close();
});

test('the empty config descriptor has the well-known digest', () => {
  assert.equal(digestOf(Buffer.from('{}')), EMPTY.digest);
});

test('server errors are retryable and client errors are not', async () => {
  const reply = (status) => async () => ({ status, headers: {}, text: '', buffer: Buffer.alloc(0) });
  const busy = createStore({ registry: 'http://r', image: 'o/r/actions-state', token: 'gh', request: reply(503) });
  await assert.rejects(busy.resolve('root'), (err) => err.retryable === true);
  const denied = createStore({ registry: 'http://r', image: 'o/r/actions-state', token: 'gh', request: reply(403) });
  await assert.rejects(denied.resolve('root'), (err) => err.retryable === false);
});

test('serialOf is null without the annotation', () => {
  assert.equal(serialOf({ annotations: {} }), null);
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --test test/unit/store.test.js`
Expected: FAIL with `Cannot find module '../../src/core/store'`

- [ ] **Step 4: Implement**

`src/core/store.js`:

```js
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

  async function send(method, path, headers = {}, body = null) {
    const url = path.startsWith('http') ? path : `${base}${path}`;
    const once = async () => {
      if (!bearer) bearer = await exchange();
      try { return await request(method, url, { Authorization: `Bearer ${bearer}`, ...headers }, body); }
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
    let res = await send('GET', `/v2/${image}/blobs/${layer.digest}`);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      try { res = await request('GET', new URL(res.headers.location, base).toString()); }
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
    const put = await send('PUT', `${location}${sep}digest=${encodeURIComponent(digest)}`, { 'Content-Type': 'application/octet-stream' }, bytes);
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
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/unit/store.test.js`
Expected: PASS, 6 tests

- [ ] **Step 6: Commit**

```bash
git add src/core/store.js test/fakes/registry.js test/unit/store.test.js
git commit -m "GHCR store: versions as OCI artifacts with a moving tag and per-serial tags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Terraform adapter

**Files:**
- Create: `src/adapters/terraform.js`
- Create: `src/adapters/index.js`
- Test: `test/unit/terraform.test.js`

**Interfaces:**
- Produces:
  - `getAdapter(name: string)` returning the adapter object below (only `'terraform'` exists)
  - adapter `terraform`: `{ name: 'terraform', OVERRIDE_FILE, LAYER_MEDIA_TYPE, stripComments(src), findBackends(dir): Array<{ file, type }>, check(dir, { replaceBackend }), wire(dir, { endpoint }): object, unwire(dir), stateMeta(bytes: Buffer): { serial: number, lineage: string } }` (`stateMeta` throws on non-JSON)

- [ ] **Step 1: Write the failing test**

`test/unit/terraform.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getAdapter } = require('../../src/adapters');

const tf = getAdapter('terraform');

function tmpdir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-state-tf-'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

test('no backend declared', () => {
  assert.deepEqual(tf.findBackends(tmpdir({ 'main.tf': 'resource "terraform_data" "x" {}\n' })), []);
});

test('detects backend and cloud blocks', () => {
  const dir = tmpdir({
    'a.tf': 'terraform {\n  backend "s3" {\n    bucket = "b"\n  }\n}\n',
    'b.tf': 'terraform {\n  cloud {\n    organization = "o"\n  }\n}\n',
  });
  assert.deepEqual(tf.findBackends(dir), [{ file: 'a.tf', type: 's3' }, { file: 'b.tf', type: 'cloud' }]);
});

test('ignores commented-out backends', () => {
  const src = '# backend "s3" {}\nterraform {\n  // backend "gcs" {}\n  /* backend "azurerm" {} */\n  required_version = ">= 1.4"\n}\n';
  assert.deepEqual(tf.findBackends(tmpdir({ 'main.tf': src })), []);
});

test('a # inside a string is not a comment', () => {
  const src = 'terraform {\n  required_version = "#1"\n  backend "local" {}\n}\n';
  assert.deepEqual(tf.findBackends(tmpdir({ 'main.tf': src })), [{ file: 'main.tf', type: 'local' }]);
});

test('only terraform blocks count', () => {
  assert.deepEqual(tf.findBackends(tmpdir({ 'main.tf': 'resource "x" "y" {\n  backend "s3" {}\n}\n' })), []);
});

test('reads .tf.json and .tofu files', () => {
  const dir = tmpdir({
    'main.tf.json': JSON.stringify({ terraform: [{ backend: [{ s3: {} }] }] }),
    'x.tofu': 'terraform {\n  backend "http" {}\n}\n',
  });
  assert.deepEqual(tf.findBackends(dir), [{ file: 'main.tf.json', type: 's3' }, { file: 'x.tofu', type: 'http' }]);
});

test('the override file this action writes is not counted', () => {
  const dir = tmpdir({ [tf.OVERRIDE_FILE]: tf.overrideHcl('http://127.0.0.1:1') });
  assert.deepEqual(tf.findBackends(dir), []);
});

test('check refuses a declared backend unless replace-backend', () => {
  const dir = tmpdir({ 'a.tf': 'terraform {\n  backend "s3" {}\n}\n' });
  assert.throws(() => tf.check(dir, {}), /already declares a backend: s3 \(a\.tf\).*replace-backend: true/);
  assert.doesNotThrow(() => tf.check(dir, { replaceBackend: true }));
});

test('check refuses a missing directory', () => {
  assert.throws(() => tf.check('/nonexistent/actions-state', {}), /does not exist/);
});

test('wire writes the override and excludes it from git; unwire removes it', () => {
  const repo = tmpdir({ '.git/info/.keep': '', 'infra/main.tf': '' });
  const dir = path.join(repo, 'infra');
  assert.deepEqual(tf.wire(dir, { endpoint: 'http://127.0.0.1:5000' }), {});
  const hcl = fs.readFileSync(path.join(dir, tf.OVERRIDE_FILE), 'utf8');
  assert.match(hcl, /backend "http"/);
  assert.match(hcl, /address\s+= "http:\/\/127\.0\.0\.1:5000\/state"/);
  assert.match(hcl, /lock_address\s+= "http:\/\/127\.0\.0\.1:5000\/lock"/);
  assert.match(hcl, /unlock_address\s+= "http:\/\/127\.0\.0\.1:5000\/lock"/);
  assert.match(hcl, /username\s+= "actions-state"/);
  tf.wire(dir, { endpoint: 'http://127.0.0.1:5000' });
  assert.equal(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8'), '/infra/actions_state_override.tf\n');
  tf.unwire(dir);
  assert.equal(fs.existsSync(path.join(dir, tf.OVERRIDE_FILE)), false);
});

test('wire works outside git and when .git is a file', () => {
  assert.doesNotThrow(() => tf.wire(tmpdir({ 'main.tf': '' }), { endpoint: 'http://127.0.0.1:1' }));
  assert.doesNotThrow(() => tf.wire(tmpdir({ '.git': 'gitdir: /elsewhere\n', 'main.tf': '' }), { endpoint: 'http://127.0.0.1:1' }));
});

test('stateMeta reads serial and lineage', () => {
  assert.deepEqual(tf.stateMeta(Buffer.from('{"version":4,"serial":12,"lineage":"abc"}')), { serial: 12, lineage: 'abc' });
});

test('stateMeta defaults missing fields', () => {
  assert.deepEqual(tf.stateMeta(Buffer.from('{"version":4}')), { serial: 0, lineage: '' });
});

test('stateMeta throws on non-JSON', () => {
  assert.throws(() => tf.stateMeta(Buffer.from('not json')));
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/unit/terraform.test.js`
Expected: FAIL with `Cannot find module '../../src/adapters'`

- [ ] **Step 3: Implement**

`src/adapters/terraform.js`:

```js
'use strict';

// Terraform and OpenTofu: both read *_override.tf and share the http backend.

const fs = require('fs');
const path = require('path');

const OVERRIDE_FILE = 'actions_state_override.tf';
const LAYER_MEDIA_TYPE = 'application/vnd.cnuss.actions-state.tfstate.v1';
const SOURCE = /\.(tf|tofu)(\.json)?$/;

// Removes comments and keeps strings, so a commented-out backend is not detected.
function stripComments(src) {
  let out = '';
  let inString = false;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === '"') inString = false;
      i += 1;
    } else if (c === '"') {
      inString = true; out += c; i += 1;
    } else if (c === '#' || (c === '/' && next === '/')) {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
    } else {
      out += c; i += 1;
    }
  }
  return out;
}

// Bodies of top-level `terraform { ... }` blocks.
function terraformBlocks(src) {
  const bodies = [];
  const re = /(^|\n)\s*terraform\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let inString = false;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i += 1) {
      const c = src[i];
      if (inString) {
        if (c === '\\') i += 1;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
    }
    bodies.push(src.slice(re.lastIndex, i - 1));
    re.lastIndex = i;
  }
  return bodies;
}

function backendsIn(file, text) {
  if (file.endsWith('.json')) {
    const doc = JSON.parse(text);
    return [].concat(doc.terraform || []).flatMap((block) => [
      ...[].concat(block.backend || []).flatMap((b) => Object.keys(b)),
      ...(block.cloud ? ['cloud'] : []),
    ]);
  }
  return terraformBlocks(stripComments(text)).flatMap((body) => {
    const found = [...body.matchAll(/\bbackend\s+"([^"]+)"\s*\{/g)].map((x) => x[1]);
    if (/(^|\s)cloud\s*\{/.test(body)) found.push('cloud');
    return found;
  });
}

function findBackends(dir) {
  return fs.readdirSync(dir)
    .filter((f) => SOURCE.test(f) && f !== OVERRIDE_FILE)
    .sort()
    .flatMap((f) => backendsIn(f, fs.readFileSync(path.join(dir, f), 'utf8')).map((type) => ({ file: f, type })));
}

function check(dir, { replaceBackend = false } = {}) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`working-directory ${dir} does not exist`);
  const found = findBackends(dir);
  if (found.length && !replaceBackend) {
    const list = found.map((b) => `${b.type} (${b.file})`).join(', ');
    throw new Error(`${dir} already declares a backend: ${list}. Remove it, or set replace-backend: true to override it.`);
  }
  return found;
}

function overrideHcl(endpoint) {
  return [
    '# Written by cnuss/actions-state and removed when the job ends.',
    'terraform {',
    '  backend "http" {',
    `    address        = "${endpoint}/state"`,
    `    lock_address   = "${endpoint}/lock"`,
    `    unlock_address = "${endpoint}/lock"`,
    '    lock_method    = "LOCK"',
    '    unlock_method  = "UNLOCK"',
    '    update_method  = "POST"',
    '    username       = "actions-state"',
    '  }',
    '}',
    '',
  ].join('\n');
}

function gitRoot(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

// Worktrees and submodules (.git as a file) are skipped.
function excludeFromGit(file) {
  const root = gitRoot(path.dirname(file));
  if (!root || !fs.statSync(path.join(root, '.git')).isDirectory()) return;
  const excludePath = path.join(root, '.git', 'info', 'exclude');
  const line = `/${path.relative(root, file).split(path.sep).join('/')}`;
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  if (existing.split('\n').includes(line)) return;
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  fs.appendFileSync(excludePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`);
}

// Addresses go in the file, not TF_HTTP_ADDRESS: env vars apply to the whole
// job, and a job may serve several states.
function wire(dir, { endpoint }) {
  const file = path.join(dir, OVERRIDE_FILE);
  fs.writeFileSync(file, overrideHcl(endpoint));
  excludeFromGit(file);
  return {};
}

function unwire(dir) {
  fs.rmSync(path.join(dir, OVERRIDE_FILE), { force: true });
}

function stateMeta(bytes) {
  const doc = JSON.parse(bytes.toString('utf8'));
  return {
    serial: Number.isInteger(doc.serial) ? doc.serial : 0,
    lineage: typeof doc.lineage === 'string' ? doc.lineage : '',
  };
}

module.exports = {
  name: 'terraform', OVERRIDE_FILE, LAYER_MEDIA_TYPE,
  stripComments, findBackends, check, overrideHcl, wire, unwire, stateMeta,
};
```

`src/adapters/index.js`:

```js
'use strict';

// An adapter connects one tool to the state server:
//   check(dir, opts)       throws on configuration that conflicts with it
//   wire(dir, { endpoint }) writes the tool's configuration, returns env vars
//   unwire(dir)            removes what wire wrote
//   stateMeta(bytes)       { serial, lineage } for annotations and tags
//   LAYER_MEDIA_TYPE       media type of the stored state
const ADAPTERS = {
  terraform: require('./terraform'),
};

function getAdapter(name) {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new Error(`unknown adapter "${name}"`);
  return adapter;
}

module.exports = { getAdapter };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/unit/terraform.test.js`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add src/adapters test/unit/terraform.test.js
git commit -m "Terraform adapter: backend detection, override file, state metadata

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Server protocol

**Files:**
- Create: `src/server.js` (this task: `createApp`; Task 10 adds `start`)
- Test: `test/unit/server.test.js`

**Interfaces:**
- Consumes: lock interface (Task 5), store interface (Task 7: `resolve(tag)`, `pull(resolved)`, `push(version)`), `annotationsFor`, `serialOf` (Task 7), `encrypt`, `decrypt`, `isEncrypted` (Task 3), adapter (Task 8), `parseJson` (Task 4)
- Produces: `createApp(ctx)` returning `{ handle(req, res), loadLatest(): Promise<Buffer|null>, releaseHeld(): Promise<void>, held }` where `ctx = { password, lock, store, adapter, slug, name, isDefaultRef, allowAnyRef, lockTimeoutMs, passphrase, aad, meta: { runId, sha, ref, defaultRef, source }, log?, sleep?, onHeldChange?, onShutdown? }`

- [ ] **Step 1: Write the failing test**

`test/unit/server.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeHttp = require('node:http');
const { createApp } = require('../../src/server');
const { request } = require('../../src/core/http');
const { getAdapter } = require('../../src/adapters');
const { isEncrypted, encrypt } = require('../../src/core/crypto');
const { PREFIX } = require('../../src/core/store');

function fakeLock() {
  const state = { holder: null, released: [], acquireCalls: 0 };
  return {
    state,
    async acquire({ info }) {
      state.acquireCalls += 1;
      if (state.holder) return { ok: false, current: { entryId: 'e0', holder: { lockInfo: state.holder } } };
      state.holder = info;
      return { ok: true, entryId: 'e1', holderId: 'h1' };
    },
    async release(h) { state.released.push(h.entryId); state.holder = null; },
    async readCurrent() { return state.holder ? { entryId: 'e0', holder: { lockInfo: state.holder } } : null; },
    async forceRelease(id) {
      if (!state.holder || (id && state.holder.ID !== id)) return false;
      state.holder = null;
      return true;
    },
    async waitUntilFree() { return !state.holder; },
  };
}

function fakeStore() {
  const versions = [];
  return {
    versions,
    failPushes: [],
    async resolve() {
      const v = versions[versions.length - 1];
      return v ? { digest: v.digest, manifest: v.manifest } : null;
    },
    async pull(resolved) {
      const v = versions.find((x) => x.digest === resolved.digest);
      return { bytes: v.bytes, mediaType: v.manifest.layers[0].mediaType, annotations: v.manifest.annotations };
    },
    async push({ bytes, mediaType, annotations, tags }) {
      const failure = this.failPushes.shift();
      if (failure) throw failure;
      const digest = `sha256:${versions.length + 1}`;
      versions.push({ digest, bytes, tags, manifest: { annotations, layers: [{ mediaType }] } });
      return digest;
    },
  };
}

const stateJson = (serial, lineage = 'L') => JSON.stringify({ version: 4, serial, lineage, resources: [] });

async function setup(overrides = {}) {
  const lock = overrides.lock || fakeLock();
  const store = overrides.store || fakeStore();
  const events = { shutdown: 0, held: [] };
  const app = createApp({
    password: 'pw', lock, store, adapter: getAdapter('terraform'), slug: 'root', name: 'root',
    isDefaultRef: true, allowAnyRef: false, lockTimeoutMs: 1000, passphrase: '', aad: 'o/r:root',
    meta: { runId: '9', sha: 'abc', ref: 'refs/heads/main', defaultRef: 'refs/heads/main', source: 'https://github.com/o/r' },
    sleep: async () => {},
    onHeldChange: (h) => events.held.push(h),
    onShutdown: () => { events.shutdown += 1; },
    ...overrides,
  });
  const server = nodeHttp.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body = null, password = 'pw') => request(method, `${url}${path}`, {
    Authorization: `Basic ${Buffer.from(`actions-state:${password}`).toString('base64')}`,
  }, body);
  const lockBody = (ID, Operation = 'OperationTypeApply') => JSON.stringify({ ID, Operation, Who: 'tester', Info: '', Version: '1', Created: '', Path: '' });
  return { app, lock, store, events, url, call, lockBody, close: () => new Promise((r) => server.close(r)) };
}

test('requests without the password are refused', async () => {
  const s = await setup();
  assert.equal((await s.call('GET', '/state', null, 'wrong')).status, 401);
  await s.close();
});

test('lock, read empty state, save, read it back', async () => {
  const s = await setup();
  assert.equal((await s.call('LOCK', '/lock', s.lockBody('a'))).status, 200);
  assert.equal((await s.call('GET', '/state')).status, 404);
  assert.equal((await s.call('POST', '/state?ID=a', stateJson(1))).status, 200);
  assert.deepEqual(s.store.versions[0].tags, ['root.v1', 'root']);
  assert.equal(s.store.versions[0].manifest.annotations[`${PREFIX}.serial`], '1');
  assert.equal(s.store.versions[0].manifest.annotations[`${PREFIX}.previous`], '');
  const got = await s.call('GET', '/state');
  assert.equal(got.status, 200);
  assert.equal(got.text, stateJson(1));
  assert.equal((await s.call('UNLOCK', '/lock', s.lockBody('a'))).status, 200);
  assert.deepEqual(s.lock.state.released, ['e1']);
  await s.close();
});

test('POST without a lock ID is refused', async () => {
  const s = await setup();
  await s.call('GET', '/state');
  const r = await s.call('POST', '/state', stateJson(1));
  assert.equal(r.status, 409);
  assert.match(r.text, /-lock=false/);
  await s.close();
});

test('POST with a lock ID this server does not hold is refused', async () => {
  const s = await setup();
  await s.call('LOCK', '/lock', s.lockBody('a'));
  await s.call('GET', '/state');
  assert.equal((await s.call('POST', '/state?ID=b', stateJson(1))).status, 409);
  await s.close();
});

test('POST is refused when a newer version appeared after the read', async () => {
  const s = await setup();
  await s.call('LOCK', '/lock', s.lockBody('a'));
  await s.call('GET', '/state');
  await s.store.push({ bytes: Buffer.from(stateJson(5)), mediaType: 'x', annotations: { [`${PREFIX}.serial`]: '5' }, tags: ['root'] });
  const r = await s.call('POST', '/state?ID=a', stateJson(2));
  assert.equal(r.status, 409);
  assert.match(r.text, /state changed since it was loaded \(loaded serial none, current serial 5\)/);
  await s.close();
});

test('POST with a non-state body is a 400', async () => {
  const s = await setup();
  await s.call('LOCK', '/lock', s.lockBody('a'));
  await s.call('GET', '/state');
  assert.equal((await s.call('POST', '/state?ID=a', 'not json')).status, 400);
  await s.close();
});

test('LOCK held by another job times out with its lock info', async () => {
  const s = await setup();
  s.lock.state.holder = { ID: 'other', Who: 'someone@elsewhere' };
  const r = await s.call('LOCK', '/lock', s.lockBody('a'));
  assert.equal(r.status, 423);
  assert.equal(JSON.parse(r.text).Who, 'someone@elsewhere');
  await s.close();
});

test('LOCK is idempotent for the holder and refused for anyone else', async () => {
  const s = await setup();
  assert.equal((await s.call('LOCK', '/lock', s.lockBody('a'))).status, 200);
  assert.equal((await s.call('LOCK', '/lock', s.lockBody('a'))).status, 200);
  const r = await s.call('LOCK', '/lock', s.lockBody('b'));
  assert.equal(r.status, 423);
  assert.equal(JSON.parse(r.text).ID, 'a');
  assert.equal(s.lock.state.acquireCalls, 1);
  await s.close();
});

test('UNLOCK with an empty body force-releases another job\'s lock', async () => {
  const s = await setup();
  s.lock.state.holder = { ID: 'other' };
  assert.equal((await s.call('UNLOCK', '/lock', '')).status, 200);
  assert.equal(s.lock.state.holder, null);
  await s.close();
});

test('UNLOCK naming a different ID than the holder is a 409', async () => {
  const s = await setup();
  s.lock.state.holder = { ID: 'other', Who: 'x' };
  const r = await s.call('UNLOCK', '/lock', s.lockBody('mine'));
  assert.equal(r.status, 409);
  assert.equal(JSON.parse(r.text).ID, 'other');
  await s.close();
});

test('a plan-only ref plans without a cache lock and is refused applies and saves', async () => {
  const s = await setup({ isDefaultRef: false, meta: { runId: '9', sha: 'abc', ref: 'refs/pull/1/merge', defaultRef: 'refs/heads/main', source: 'https://github.com/o/r' } });
  assert.equal((await s.call('LOCK', '/lock', s.lockBody('p', 'OperationTypePlan'))).status, 200);
  assert.equal(s.lock.state.acquireCalls, 0);
  assert.equal((await s.call('UNLOCK', '/lock', s.lockBody('p'))).status, 200);
  const refused = await s.call('LOCK', '/lock', s.lockBody('x', 'OperationTypeApply'));
  assert.equal(refused.status, 423);
  assert.match(JSON.parse(refused.text).Info, /may only plan.*allow-apply-from-any-ref/);
  assert.equal((await s.call('POST', '/state?ID=x', stateJson(1))).status, 403);
  await s.close();
});

test('allow-apply-from-any-ref takes a real lock on other refs', async () => {
  const s = await setup({ isDefaultRef: false, allowAnyRef: true });
  assert.equal((await s.call('LOCK', '/lock', s.lockBody('x'))).status, 200);
  assert.equal(s.lock.state.acquireCalls, 1);
  await s.close();
});

test('with a passphrase, saved layers are encrypted and reads decrypt them', async () => {
  const s = await setup({ passphrase: 'secret-passphrase' });
  await s.call('LOCK', '/lock', s.lockBody('a'));
  await s.call('GET', '/state');
  await s.call('POST', '/state?ID=a', stateJson(1));
  const v = s.store.versions[0];
  assert.ok(isEncrypted(v.bytes));
  assert.equal(v.manifest.layers[0].mediaType, 'application/vnd.cnuss.actions-state.tfstate.v1.enc');
  assert.equal(v.manifest.annotations[`${PREFIX}.encrypted`], 'true');
  assert.equal((await s.call('GET', '/state')).text, stateJson(1));
  await s.close();
});

test('encrypted state without a passphrase fails to load', async () => {
  const store = fakeStore();
  await store.push({ bytes: encrypt(Buffer.from(stateJson(1)), 'p', 'o/r:root'), mediaType: 'x.enc', annotations: {}, tags: ['root'] });
  const s = await setup({ store });
  await assert.rejects(s.app.loadLatest(), /set the passphrase input/);
  await s.close();
});

test('DELETE /state is not supported', async () => {
  const s = await setup();
  assert.equal((await s.call('DELETE', '/state')).status, 405);
  await s.close();
});

test('a failed push is retried, and gives up with a 502', async () => {
  const s = await setup();
  await s.call('LOCK', '/lock', s.lockBody('a'));
  await s.call('GET', '/state');
  s.store.failPushes.push(Object.assign(new Error('503'), { retryable: true }));
  assert.equal((await s.call('POST', '/state?ID=a', stateJson(1))).status, 200);
  s.store.failPushes.push(Object.assign(new Error('403'), { retryable: false }));
  assert.equal((await s.call('POST', '/state?ID=a', stateJson(2))).status, 502);
  await s.close();
});

test('shutdown releases a held lock', async () => {
  const s = await setup();
  await s.call('LOCK', '/lock', s.lockBody('a'));
  assert.equal((await s.call('POST', '/shutdown')).status, 200);
  assert.deepEqual(s.lock.state.released, ['e1']);
  assert.equal(s.events.shutdown, 1);
  assert.equal(s.events.held.at(-1), null);
  await s.close();
});

test('a LOCK abandoned by its client leaves nothing held', async () => {
  let release;
  const lock = fakeLock();
  lock.acquire = ({ signal }) => new Promise((resolve) => {
    release = () => resolve({ ok: true, entryId: 'late', holderId: 'h' });
    signal.addEventListener('abort', () => setTimeout(release, 10));
  });
  const s = await setup({ lock });
  const req = nodeHttp.request(`${s.url}/lock`, {
    method: 'LOCK',
    headers: { Authorization: `Basic ${Buffer.from('actions-state:pw').toString('base64')}` },
  });
  req.on('error', () => {});
  req.end(s.lockBody('a'));
  await new Promise((r) => setTimeout(r, 50));
  req.destroy();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.app.held, null);
  assert.deepEqual(lock.state.released, ['late']);
  await s.close();
});

test('a second LOCK while one is waiting is refused', async () => {
  let finish;
  const lock = fakeLock();
  lock.acquire = () => new Promise((resolve) => { finish = () => resolve({ ok: true, entryId: 'e1', holderId: 'h1' }); });
  const s = await setup({ lock });
  const first = s.call('LOCK', '/lock', s.lockBody('a'));
  await new Promise((r) => setTimeout(r, 20));
  const second = await s.call('LOCK', '/lock', s.lockBody('b'));
  assert.equal(second.status, 423);
  assert.equal(JSON.parse(second.text).ID, 'a');
  finish();
  assert.equal((await first).status, 200);
  await s.close();
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/unit/server.test.js`
Expected: FAIL with `Cannot find module '../../src/server'`

- [ ] **Step 3: Implement**

`src/server.js`:

```js
'use strict';

// Terraform HTTP-backend server. createApp() is the protocol; start() runs it
// as the detached process the action launches.

const crypto = require('crypto');
const { URL } = require('url');
const box = require('./core/crypto');
const { parseJson } = require('./core/http');
const { annotationsFor, serialOf } = require('./core/store');

// One try plus three retries.
const PUSH_ATTEMPTS = 4;

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
}) {
  const writable = isDefaultRef || allowAnyRef;
  let held = null;     // { id, info, virtual, entryId, holderId }
  let locking = null;  // lock info of a LOCK still waiting
  let loaded = null;   // { digest, serial } of the version Terraform last read
  let cache = null;    // { digest, serial, bytes } with bytes decrypted

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

  async function loadLatest() {
    const resolved = await store.resolve(slug);
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
    held = null;
    if (!h.virtual) await lock.release(h);
    onHeldChange(null);
    log(`unlocked "${name}" (${h.id})`);
  }

  async function lockState(res, body) {
    const info = parseJson(body.toString('utf8'));
    if (!info.ID) return send(res, 400, 'lock request has no ID');
    if (held) return held.id === info.ID ? send(res, 200) : sendJson(res, 423, held.info);
    if (locking) return sendJson(res, 423, locking);
    if (!writable && info.Operation !== 'OperationTypePlan') {
      const why = `${meta.ref} may only plan; set allow-apply-from-any-ref: true to apply from it`;
      log(`refused ${info.Operation} lock: ${why}`);
      return sendJson(res, 423, refusal(info, why));
    }

    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    locking = info;
    try {
      if (!writable) {
        const free = await lock.waitUntilFree({ waitMs: lockTimeoutMs, signal: abort.signal });
        if (abort.signal.aborted) return undefined;
        if (!free) return sendJson(res, 423, holderInfo(await lock.readCurrent({ ref: meta.defaultRef })));
        held = { id: info.ID, info, virtual: true };
        log(`plan lock on "${name}" (${info.ID}), not shared with other refs`);
        return send(res, 200);
      }
      const got = await lock.acquire({ info, waitMs: lockTimeoutMs, signal: abort.signal });
      if (!got.ok) {
        if (got.aborted) return undefined;
        log(`lock on "${name}" still held after ${lockTimeoutMs / 1000}s`);
        return sendJson(res, 423, holderInfo(got.current));
      }
      if (abort.signal.aborted) {
        await lock.release(got);
        return undefined;
      }
      held = { id: info.ID, info, virtual: false, entryId: got.entryId, holderId: got.holderId };
      onHeldChange(held);
      log(`locked "${name}" for ${info.Operation} (${info.ID})`);
      return send(res, 200);
    } finally {
      locking = null;
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

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
      const body = await readBody(req);
      if (!authorized(req)) return send(res, 401, 'unauthorized', { 'WWW-Authenticate': 'Basic realm="actions-state"' });
      switch (route) {
        case 'GET /health':
          return send(res, 200, 'ok');
        case 'POST /shutdown':
          await releaseHeld();
          send(res, 200, 'bye');
          return onShutdown();
        case 'GET /state': {
          const bytes = await loadLatest();
          return bytes ? send(res, 200, bytes, { 'Content-Type': 'application/json' }) : send(res, 404, 'no state yet');
        }
        case 'POST /state':
          return postState(res, url.searchParams.get('ID'), body);
        case 'DELETE /state':
          return send(res, 405, 'deleting state is not supported');
        case 'LOCK /lock':
          return lockState(res, body);
        case 'UNLOCK /lock':
          return unlockState(res, body);
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

module.exports = { createApp };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/unit/server.test.js`
Expected: PASS, 19 tests

- [ ] **Step 5: Run the whole suite**

Run: `node --test 'test/unit/**/*.test.js'`
Expected: PASS, all suites

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/unit/server.test.js
git commit -m "Server: Terraform HTTP-backend protocol over the lock and store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Server process, action entry point, action.yml

**Files:**
- Modify: `src/server.js` (add `start`, the detached-process entry)
- Create: `index.js`
- Create: `action.yml`
- Test: `test/unit/index.test.js`

**Interfaces:**
- Consumes: everything above
- Produces: `index.js` exports `resolveConfig(env)`, `jobPassword(runDir)`, `claimRunfile(runDir, slug, name)`, `waitForServer(runfile, logFile, timeoutMs)`; `src/server.js` exports `start(env)`
- Runfile shape (`$RUNNER_TEMP/actions-state/<slug>.json`): `{ pid, port, held: string[] }` or `{ pid, error }`
- Server environment: `ACTIONS_STATE_CONFIG` (JSON below), `ACTIONS_STATE_PASSWORD`, `ACTIONS_STATE_PASSPHRASE`, `ACTIONS_STATE_TOKEN`, plus the runner's `ACTIONS_RUNTIME_TOKEN` and `ACTIONS_RESULTS_URL`
- `ACTIONS_STATE_CONFIG`: `{ runfile, apiUrl, registry, repository, ref, slug, name, image, adapter, identity, isDefaultRef, allowAnyRef, lockTimeoutMs, aad, meta }`

- [ ] **Step 1: Write the failing test**

`test/unit/index.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveConfig, jobPassword, claimRunfile, waitForServer } = require('../../index');

const baseEnv = {
  GITHUB_WORKSPACE: '/w', GITHUB_REPOSITORY: 'CNuss/Thing', GITHUB_REF: 'refs/heads/main', RUNNER_TEMP: '/tmp/rt',
  'INPUT_GITHUB-TOKEN': 'gh', 'INPUT_LOCK-TIMEOUT': '600', 'INPUT_REPLACE-BACKEND': 'false', 'INPUT_ALLOW-APPLY-FROM-ANY-REF': 'false',
};

test('resolveConfig derives the name, slug and image', () => {
  const cfg = resolveConfig({ ...baseEnv, 'INPUT_WORKING-DIRECTORY': 'infra/zone' });
  assert.equal(cfg.workingDirectory, '/w/infra/zone');
  assert.equal(cfg.name, 'infra/zone');
  assert.equal(cfg.slug, 'infra-zone');
  assert.equal(cfg.image, 'cnuss/thing/actions-state');
  assert.equal(cfg.lockTimeoutMs, 600_000);
  assert.equal(cfg.replaceBackend, false);
  assert.equal(cfg.allowAnyRef, false);
  assert.equal(cfg.runDir, '/tmp/rt/actions-state');
});

test('resolveConfig: the name input overrides the derived name', () => {
  const cfg = resolveConfig({ ...baseEnv, INPUT_NAME: 'shared' });
  assert.equal(cfg.name, 'shared');
  assert.equal(cfg.workingDirectory, '/w');
});

test('resolveConfig: booleans and lock-timeout 0', () => {
  const cfg = resolveConfig({ ...baseEnv, 'INPUT_LOCK-TIMEOUT': '0', 'INPUT_REPLACE-BACKEND': 'true', 'INPUT_ALLOW-APPLY-FROM-ANY-REF': 'true' });
  assert.equal(cfg.lockTimeoutMs, 0);
  assert.equal(cfg.replaceBackend, true);
  assert.equal(cfg.allowAnyRef, true);
});

test('resolveConfig refuses a non-numeric lock-timeout', () => {
  assert.throws(() => resolveConfig({ ...baseEnv, 'INPUT_LOCK-TIMEOUT': '10m' }), /whole number of seconds/);
});

test('jobPassword is created once per job and reused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-state-pw-'));
  const first = jobPassword(dir);
  assert.match(first, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(jobPassword(dir), first);
});

test('claimRunfile refuses a second use of one state name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-state-run-'));
  assert.equal(claimRunfile(dir, 'root', 'root'), path.join(dir, 'root.json'));
  assert.throws(() => claimRunfile(dir, 'root', 'root'), /already served in this job/);
});

test('waitForServer returns the runfile once it has a port, and surfaces startup errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-state-wait-'));
  const runfile = path.join(dir, 'root.json');
  fs.writeFileSync(runfile, '');
  setTimeout(() => fs.writeFileSync(runfile, JSON.stringify({ pid: 1, port: 4000, held: [] })), 150);
  assert.equal((await waitForServer(runfile, path.join(dir, 'log'), 2000)).port, 4000);
  fs.writeFileSync(runfile, JSON.stringify({ pid: 1, error: 'decryption failed: wrong passphrase or tampered state' }));
  await assert.rejects(waitForServer(runfile, path.join(dir, 'log'), 2000), /wrong passphrase/);
});

test('waitForServer times out with the server log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-state-wait-'));
  fs.writeFileSync(path.join(dir, 'log'), 'boom');
  await assert.rejects(waitForServer(path.join(dir, 'none.json'), path.join(dir, 'log'), 300), /did not start[\s\S]*boom/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/unit/index.test.js`
Expected: FAIL with `Cannot find module '../../index'`

- [ ] **Step 3: Add `start` to `src/server.js`**

Add after `createApp`, and replace the `module.exports` line:

```js
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
  if (env.ACTIONS_STEP_DEBUG === 'true') setDebug(log);
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
```

- [ ] **Step 4: Write `index.js`**

```js
'use strict';

// main checks the configuration, starts the state server and points Terraform
// at it; post stops the server and removes the override file. main and post are
// the same file: main saves STATE_post so the post run knows which it is.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { deriveName, tagSlug, imageName } = require('./src/core/names');
const { aadFor } = require('./src/core/crypto');
const { request, restClient } = require('./src/core/http');
const { repoInfo, packageVisibility, findSelfJob } = require('./src/core/github');
const { getAdapter } = require('./src/adapters');

const START_TIMEOUT_MS = 10_000;

function log(msg) { process.stdout.write(`${msg}\n`); }

function appendCommandFile(file, name, value) {
  if (!file) return;
  const delimiter = `ghadelimiter_${crypto.randomBytes(16).toString('hex')}`;
  fs.appendFileSync(file, `${name}<<${delimiter}\n${value ?? ''}\n${delimiter}\n`);
}
const setOutput = (name, value) => appendCommandFile(process.env.GITHUB_OUTPUT, name, value);
const saveState = (name, value) => appendCommandFile(process.env.GITHUB_STATE, name, value);
const exportVariable = (name, value) => appendCommandFile(process.env.GITHUB_ENV, name, value);

function input(env, name) { return (env[`INPUT_${name.toUpperCase()}`] || '').trim(); }

function resolveConfig(env) {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const dirInput = input(env, 'working-directory') || '.';
  const name = input(env, 'name') || deriveName(dirInput, workspace);
  const lockTimeout = input(env, 'lock-timeout') || '600';
  if (!/^\d+$/.test(lockTimeout)) throw new Error(`lock-timeout must be a whole number of seconds, got "${lockTimeout}"`);
  return {
    workingDirectory: path.resolve(workspace, dirInput),
    name,
    slug: tagSlug(name),
    repository: env.GITHUB_REPOSITORY,
    image: imageName(env.GITHUB_REPOSITORY),
    ref: env.GITHUB_REF,
    passphrase: input(env, 'passphrase'),
    lockTimeoutMs: Number(lockTimeout) * 1000,
    replaceBackend: input(env, 'replace-backend') === 'true',
    allowAnyRef: input(env, 'allow-apply-from-any-ref') === 'true',
    token: input(env, 'github-token'),
    runDir: path.join(env.RUNNER_TEMP || os.tmpdir(), 'actions-state'),
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    serverUrl: env.GITHUB_SERVER_URL || 'https://github.com',
  };
}

// One password per job: the first use of the action creates it, later uses
// reuse it, because TF_HTTP_PASSWORD is job-wide.
function jobPassword(runDir) {
  const file = path.join(runDir, 'password');
  try { return fs.readFileSync(file, 'utf8'); } catch { /* first use in this job */ }
  const password = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(file, password, { mode: 0o600 });
  return password;
}

function claimRunfile(runDir, slug, name) {
  const file = path.join(runDir, `${slug}.json`);
  try {
    fs.writeFileSync(file, '', { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error(`state "${name}" is already served in this job; give the second use a different name`);
    throw err;
  }
  return file;
}

async function waitForServer(runfile, logFile, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let run = null;
    try { run = JSON.parse(fs.readFileSync(runfile, 'utf8')); } catch { /* not written yet */ }
    if (run && run.error) throw new Error(run.error);
    if (run && run.port) return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  const serverLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no server log)';
  throw new Error(`state server did not start within ${timeoutMs / 1000}s:\n${serverLog}`);
}

function basicAuth(password) {
  return { Authorization: `Basic ${Buffer.from(`actions-state:${password}`).toString('base64')}` };
}

async function main() {
  saveState('post', 'true');
  const env = process.env;
  const cfg = resolveConfig(env);
  if (!cfg.token) throw new Error('input `github-token` is required');
  const adapter = getAdapter('terraform');
  adapter.check(cfg.workingDirectory, { replaceBackend: cfg.replaceBackend });

  const rest = restClient({ token: cfg.token, apiUrl: cfg.apiUrl });
  const repo = await repoInfo(rest, cfg.repository);
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const isDefaultRef = cfg.ref === defaultRef;
  if (!cfg.passphrase) {
    if (repo.visibility === 'public') {
      throw new Error(`${cfg.repository} is public, so its state package would be readable by anyone: set the passphrase input from a secret to encrypt state`);
    }
    const owner = cfg.repository.split('/')[0];
    const visibility = await packageVisibility(rest, { ownerType: repo.ownerType, owner, packageName: cfg.image.slice(owner.length + 1) });
    if (visibility === 'public') throw new Error(`ghcr.io/${cfg.image} is public: set the passphrase input from a secret to encrypt state`);
  }
  const job = await findSelfJob(rest, env);

  fs.mkdirSync(cfg.runDir, { recursive: true });
  const runfile = claimRunfile(cfg.runDir, cfg.slug, cfg.name);
  const logFile = path.join(cfg.runDir, `${cfg.slug}.log`);
  saveState('runfile', runfile);
  saveState('log_file', logFile);
  saveState('working_directory', cfg.workingDirectory);
  const password = jobPassword(cfg.runDir);
  log(`::add-mask::${password}`);

  const config = {
    runfile, apiUrl: cfg.apiUrl, registry: 'https://ghcr.io', repository: cfg.repository, ref: cfg.ref,
    slug: cfg.slug, name: cfg.name, image: cfg.image, adapter: adapter.name,
    identity: { run_id: env.GITHUB_RUN_ID, run_attempt: env.GITHUB_RUN_ATTEMPT, job_id: job.id, job_name: job.name, job_url: job.url, ref: cfg.ref },
    isDefaultRef, allowAnyRef: cfg.allowAnyRef, lockTimeoutMs: cfg.lockTimeoutMs, aad: aadFor(cfg.repository, cfg.name),
    meta: { runId: env.GITHUB_RUN_ID, sha: env.GITHUB_SHA, ref: cfg.ref, defaultRef, source: `${cfg.serverUrl}/${cfg.repository}` },
  };
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'src', 'server.js')], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...env, ACTIONS_STATE_CONFIG: JSON.stringify(config), ACTIONS_STATE_PASSWORD: password, ACTIONS_STATE_PASSPHRASE: cfg.passphrase, ACTIONS_STATE_TOKEN: cfg.token },
  });
  child.unref();
  fs.closeSync(out);

  const run = await waitForServer(runfile, logFile);
  const endpoint = `http://127.0.0.1:${run.port}`;
  const health = await request('GET', `${endpoint}/health`, basicAuth(password));
  if (health.status !== 200) throw new Error(`state server health check failed: HTTP ${health.status}`);

  adapter.wire(cfg.workingDirectory, { endpoint });
  exportVariable('TF_HTTP_PASSWORD', password);
  setOutput('state-name', cfg.name);
  setOutput('image', `ghcr.io/${cfg.image}`);
  setOutput('address', `${endpoint}/state`);
  const mode = isDefaultRef ? 'read/write' : cfg.allowAnyRef ? 'read/write (allow-apply-from-any-ref)' : 'plan only';
  log(`[actions-state] serving "${cfg.name}" from ghcr.io/${cfg.image}:${cfg.slug} (${mode}) at ${endpoint}`);
}

async function post() {
  const env = process.env;
  const runfile = env.STATE_runfile;
  if (env.STATE_working_directory) getAdapter('terraform').unwire(env.STATE_working_directory);
  if (!runfile || !fs.existsSync(runfile)) return;

  let run = {};
  try { run = JSON.parse(fs.readFileSync(runfile, 'utf8') || '{}'); } catch { /* server never wrote it */ }
  let password = '';
  try { password = fs.readFileSync(path.join(path.dirname(runfile), 'password'), 'utf8'); } catch { /* main failed early */ }

  let stopped = false;
  if (run.port && password) {
    try {
      stopped = (await request('POST', `http://127.0.0.1:${run.port}/shutdown`, basicAuth(password))).status === 200;
    } catch { /* server already gone */ }
  }
  if (!stopped) {
    const held = run.held || [];
    if (held.length) {
      const rest = restClient({ token: input(env, 'github-token'), apiUrl: env.GITHUB_API_URL || 'https://api.github.com' });
      for (const id of held) {
        const r = await rest('DELETE', `/repos/${env.GITHUB_REPOSITORY}/actions/caches/${id}`);
        log(`[actions-state] deleted lock entry ${id}: HTTP ${r.status}`);
      }
    }
    if (run.pid) { try { process.kill(run.pid, 'SIGKILL'); } catch { /* already exited */ } }
  }
  fs.rmSync(runfile, { force: true });

  const logFile = env.STATE_log_file;
  if (logFile && fs.existsSync(logFile)) {
    log('::group::actions-state server log');
    log(fs.readFileSync(logFile, 'utf8'));
    log('::endgroup::');
  }
}

module.exports = { resolveConfig, jobPassword, claimRunfile, waitForServer };

if (require.main === module) {
  const run = process.env.STATE_post === 'true' ? post : main;
  run().catch((err) => {
    log(`::error::${err.message}`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 5: Write `action.yml`**

```yaml
name: 'Terraform state on GitHub'
description: >-
  Terraform and OpenTofu state stored in GitHub Packages and locked with the
  Actions cache. Add one step, then run terraform as usual.
author: 'cnuss'

inputs:
  working-directory:
    description: 'Root module directory. The backend override file is written here.'
    required: false
    default: '.'
  name:
    description: 'State name. Defaults to working-directory relative to the workspace ("root" for the workspace itself).'
    required: false
    default: ''
  passphrase:
    description: 'Encrypts state before it leaves the runner. Required when the repository or its state package is public. Pass it from a secret.'
    required: false
    default: ''
  lock-timeout:
    description: 'Seconds to wait for a lock held by another job. 0 fails at once.'
    required: false
    default: '600'
  replace-backend:
    description: 'Proceed even if the configuration declares a backend; the override replaces it.'
    required: false
    default: 'false'
  allow-apply-from-any-ref:
    description: 'Let refs other than the default branch apply and save state. Locks taken on other refs do not exclude each other.'
    required: false
    default: 'false'
  github-token:
    description: 'Token for the cache, packages and REST calls. Needs actions: write and packages: write.'
    required: false
    default: ${{ github.token }}

outputs:
  state-name:
    description: 'The resolved state name.'
  image:
    description: 'The state package, ghcr.io/<owner>/<repo>/actions-state.'
  address:
    description: 'The local state URL Terraform uses.'

runs:
  using: 'node24'
  main: 'index.js'
  post: 'index.js'
  post-if: always()

branding:
  icon: 'database'
  color: 'purple'
```

- [ ] **Step 6: Run the tests**

Run: `node --test 'test/unit/**/*.test.js'`
Expected: PASS, all suites including 8 `index` tests

- [ ] **Step 7: Check that requiring the entry points has no side effects**

Run: `node -e "require('./index.js'); require('./src/server.js'); console.log('ok')"`
Expected: `ok` and nothing else

- [ ] **Step 8: Commit**

```bash
git add index.js action.yml src/server.js test/unit/index.test.js
git commit -m "Action entry: start the detached server, wire Terraform, clean up in post

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Publish the repo and run the integration suite

**Files:**
- Create: `test/fixtures/data/main.tf`, `test/fixtures/s3-backend/main.tf`
- Create: `test/scripts/install-tool.sh`, `test/scripts/inspect.js`, `test/scripts/push-direct.js`, `test/scripts/cleanup.js`
- Create: `.github/workflows/integration.yml`

**Interfaces:**
- Consumes: `createStore`, `annotationsFor`, `serialOf`, `digestOf` (Task 7), `encrypt`, `decrypt`, `isEncrypted`, `aadFor` (Task 3), `restClient` (Task 4), `repoInfo` (Task 6), `imageName`, `tagSlug` (Task 2)

- [ ] **Step 1: Fixtures**

`test/fixtures/data/main.tf`:

```hcl
variable "value" {
  type    = string
  default = "one"
}

variable "sleep" {
  type    = number
  default = 0
}

# Replaced whenever value changes, so every apply that changes value writes a
# new serial; the provisioner holds the apply open for var.sleep seconds.
resource "terraform_data" "data" {
  input            = var.value
  triggers_replace = var.value

  provisioner "local-exec" {
    command = "sleep ${var.sleep}"
  }
}

output "value" {
  value = terraform_data.data.output
}
```

`test/fixtures/s3-backend/main.tf`:

```hcl
terraform {
  backend "s3" {
    bucket = "never-used"
    key    = "never-used"
    region = "us-east-1"
  }
}

resource "terraform_data" "data" {
  input = "replaced"
}
```

- [ ] **Step 2: Scripts**

`test/scripts/install-tool.sh`:

```bash
#!/usr/bin/env bash
# Installs terraform or tofu into $RUNNER_TEMP/bin after checking the release's
# published SHA-256. Versions come from TERRAFORM_VERSION and TOFU_VERSION.
set -euo pipefail

tool="$1"
case "$tool" in
  terraform)
    version="$TERRAFORM_VERSION"
    base="https://releases.hashicorp.com/terraform/${version}"
    zip="terraform_${version}_linux_amd64.zip"
    sums="terraform_${version}_SHA256SUMS"
    ;;
  tofu)
    version="$TOFU_VERSION"
    base="https://github.com/opentofu/opentofu/releases/download/v${version}"
    zip="tofu_${version}_linux_amd64.zip"
    sums="tofu_${version}_SHA256SUMS"
    ;;
  *)
    echo "unknown tool: $tool" >&2
    exit 1
    ;;
esac

dir="${RUNNER_TEMP}/bin"
mkdir -p "$dir"
cd "$RUNNER_TEMP"
curl -fsSLO "${base}/${zip}"
curl -fsSLO "${base}/${sums}"
grep " ${zip}\$" "$sums" | sha256sum -c -
unzip -o -q "$zip" -d "$dir" "$tool"
echo "$dir" >> "$GITHUB_PATH"
"$dir/$tool" version
```

`test/scripts/inspect.js`:

```js
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
```

`test/scripts/push-direct.js`:

```js
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
```

`test/scripts/cleanup.js`:

```js
'use strict';

// Usage: node test/scripts/cleanup.js <tag prefix>
// Deletes this repo's state package versions whose tags start with the prefix.

const { restClient } = require('../../src/core/http');
const { repoInfo } = require('../../src/core/github');
const { imageName } = require('../../src/core/names');

async function main() {
  const prefix = process.argv[2];
  const repository = process.env.GITHUB_REPOSITORY;
  const owner = repository.split('/')[0];
  const rest = restClient({ token: process.env.GH_TOKEN });
  const { ownerType } = await repoInfo(rest, repository);
  const scope = ownerType === 'Organization' ? `orgs/${owner}` : `users/${owner}`;
  const pkg = encodeURIComponent(imageName(repository).slice(owner.length + 1));
  let deleted = 0;
  for (let page = 1; ; page += 1) {
    const r = await rest('GET', `/${scope}/packages/container/${pkg}/versions?per_page=100&page=${page}`);
    if (r.status === 404) break;
    if (r.status !== 200) throw new Error(`listing versions: HTTP ${r.status}: ${r.text}`);
    const versions = Array.isArray(r.json) ? r.json : [];
    for (const v of versions) {
      const tags = (v.metadata && v.metadata.container && v.metadata.container.tags) || [];
      if (tags.some((t) => t.startsWith(prefix))) {
        const d = await rest('DELETE', `/${scope}/packages/container/${pkg}/versions/${v.id}`);
        if (d.status === 204) deleted += 1;
        else console.log(`could not delete version ${v.id}: HTTP ${d.status}`);
      }
    }
    if (versions.length < 100) break;
  }
  console.log(`deleted ${deleted} versions tagged ${prefix}*`);
}

main().catch((err) => { console.error(`::error::${err.message}`); process.exit(1); });
```

Run: `chmod +x test/scripts/install-tool.sh`

- [ ] **Step 3: Integration workflow**

`.github/workflows/integration.yml`:

```yaml
name: Integration

# End-to-end runs against GHCR and the Actions cache. Every state name is unique
# to the run and the cleanup job deletes the run's package versions. Jobs set
# allow-apply-from-any-ref so they also run on pull requests; the refs job
# checks the default without it.

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  actions: write
  packages: write
  contents: read

env:
  TERRAFORM_VERSION: 1.16.5
  TOFU_VERSION: 1.13.1
  PREFIX: it-${{ github.run_id }}-${{ github.run_attempt }}
  # Test-only value: these states hold nothing but terraform_data.
  PASSPHRASE: integration-test-passphrase
  FIXTURE: test/fixtures/data
  GH_TOKEN: ${{ github.token }}

jobs:
  lifecycle:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        tool: [terraform, tofu]
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - run: test/scripts/install-tool.sh ${{ matrix.tool }}
      - uses: ./
        with:
          working-directory: ${{ env.FIXTURE }}
          name: ${{ env.PREFIX }}-lifecycle-${{ matrix.tool }}
          passphrase: ${{ env.PASSPHRASE }}
          allow-apply-from-any-ref: true
      - name: First apply creates state
        working-directory: ${{ env.FIXTURE }}
        run: |
          ${{ matrix.tool }} init -input=false
          ${{ matrix.tool }} apply -auto-approve -input=false -var value=one
      - run: node test/scripts/inspect.js "$PREFIX-lifecycle-${{ matrix.tool }}" --expect-encrypted --min-serial 1

  lifecycle-reload:
    needs: lifecycle
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        tool: [terraform, tofu]
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - run: test/scripts/install-tool.sh ${{ matrix.tool }}
      - uses: ./
        with:
          working-directory: ${{ env.FIXTURE }}
          name: ${{ env.PREFIX }}-lifecycle-${{ matrix.tool }}
          passphrase: ${{ env.PASSPHRASE }}
          allow-apply-from-any-ref: true
      - name: A new job sees the saved state, then changes it
        working-directory: ${{ env.FIXTURE }}
        run: |
          ${{ matrix.tool }} init -input=false
          ${{ matrix.tool }} plan -detailed-exitcode -input=false -var value=one
          ${{ matrix.tool }} apply -auto-approve -input=false -var value=two
      - run: node test/scripts/inspect.js "$PREFIX-lifecycle-${{ matrix.tool }}" --expect-encrypted --min-serial 2

  wrong-passphrase:
    needs: lifecycle
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - id: wrong
        continue-on-error: true
        uses: ./
        with:
          working-directory: ${{ env.FIXTURE }}
          name: ${{ env.PREFIX }}-lifecycle-terraform
          passphrase: not-the-passphrase
          allow-apply-from-any-ref: true
      - name: The action must fail before Terraform runs
        if: steps.wrong.outcome != 'failure'
        run: |
          echo "::error::a wrong passphrase was accepted"
          exit 1

  public-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - id: guard
        continue-on-error: true
        uses: ./
        with:
          working-directory: ${{ env.FIXTURE }}
          name: ${{ env.PREFIX }}-guard
          allow-apply-from-any-ref: true
      - name: A public repo without a passphrase must be refused
        if: steps.guard.outcome != 'failure'
        run: |
          echo "::error::state would have been stored unencrypted in a public package"
          exit 1

  backend-conflict:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - run: test/scripts/install-tool.sh terraform
      - id: refused
        continue-on-error: true
        uses: ./
        with:
          working-directory: test/fixtures/s3-backend
          name: ${{ env.PREFIX }}-conflict-refused
          passphrase: ${{ env.PASSPHRASE }}
          allow-apply-from-any-ref: true
      - name: A declared backend must be refused by default
        if: steps.refused.outcome != 'failure'
        run: |
          echo "::error::the s3 backend was silently replaced"
          exit 1
      - uses: ./
        with:
          working-directory: test/fixtures/s3-backend
          name: ${{ env.PREFIX }}-conflict-replaced
          passphrase: ${{ env.PASSPHRASE }}
          allow-apply-from-any-ref: true
          replace-backend: true
      - name: replace-backend overrides it without touching AWS
        working-directory: test/fixtures/s3-backend
        run: |
          terraform init -input=false
          terraform apply -auto-approve -input=false

  contention-seed:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - run: test/scripts/install-tool.sh terraform
      - uses: ./
        with:
          working-directory: ${{ env.FIXTURE }}
          name: ${{ env.PREFIX }}-contention
          passphrase: ${{ env.PASSPHRASE }}
          allow-apply-from-any-ref: true
      - working-directory: ${{ env.FIXTURE }}
        run: |
          terraform init -input=false
          terraform apply -auto-approve -input=false -var value=seed

  contention:
    needs: contention-seed
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        n: [1, 2, 3]
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - run: test/scripts/install-tool.sh terraform
      - uses: ./
        with:
          working-directory: ${{ env.FIXTURE }}
          name: ${{ env.PREFIX }}-contention
          passphrase: ${{ env.PASSPHRASE }}
          allow-apply-from-any-ref: true
      - name: Concurrent applies take turns
        working-directory: ${{ env.FIXTURE }}
        run: |
          terraform init -input=false
          terraform apply -auto-approve -input=false -var value=n${{ matrix.n }} -var sleep=10

  contention-verify:
    needs: contention
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - run: node test/scripts/inspect.js "$PREFIX-contention" --expect-encrypted --min-serial 4

  fail-fast-holder:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - run: test/scripts/install-tool.sh terraform
      - uses: ./
        with:
          working-directory: ${{ env.FIXTURE }}
          name: ${{ env.PREFIX }}-failfast
          passphrase: ${{ env.PASSPHRASE }}
          allow-apply-from-any-ref: true
      - name: Create state, then hold the lock for two minutes
        working-directory: ${{ env.FIXTURE }}
        run: |
          terraform init -input=false
          terraform apply -auto-approve -input=false -var value=a
          terraform apply -auto-approve -input=false -var value=b -var sleep=120

  fail-fast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - run: test/scripts/install-tool.sh terraform
      - name: Wait for the holder's first version, then for it to take the lock
        run: |
          node test/scripts/inspect.js "$PREFIX-failfast" --wait 600
          sleep 30
      - uses: ./
        with:
          working-directory: ${{ env.FIXTURE }}
          name: ${{ env.PREFIX }}-failfast
          passphrase: ${{ env.PASSPHRASE }}
          allow-apply-from-any-ref: true
          lock-timeout: 0
      - id: apply
        continue-on-error: true
        working-directory: ${{ env.FIXTURE }}
        run: |
          terraform init -input=false
          terraform apply -auto-approve -input=false -var value=c 2>&1 | tee "$RUNNER_TEMP/apply.log"
          exit "${PIPESTATUS[0]}"
      - name: The second apply fails at once with the holder's lock info
        run: |
          [ "${{ steps.apply.outcome }}" = failure ]
          grep -q 'Lock Info' "$RUNNER_TEMP/apply.log"

  crash-holder:
    runs-on: ubuntu-latest
    # Killing the runner fails this job on purpose; the waiter is the test.
    continue-on-error: true
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - run: test/scripts/install-tool.sh terraform
      - uses: ./
        with:
          working-directory: ${{ env.FIXTURE }}
          name: ${{ env.PREFIX }}-crash
          passphrase: ${{ env.PASSPHRASE }}
          allow-apply-from-any-ref: true
      - name: Create state, take the lock, then kill the runner
        working-directory: ${{ env.FIXTURE }}
        run: |
          terraform init -input=false
          terraform apply -auto-approve -input=false -var value=a
          terraform apply -auto-approve -input=false -var value=b -var sleep=600 &
          sleep 30
          sudo pkill -9 -f Runner.Worker

  crash-waiter:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - run: test/scripts/install-tool.sh terraform
      - name: Wait for the holder's first version, then for it to take the lock
        run: |
          node test/scripts/inspect.js "$PREFIX-crash" --wait 600
          sleep 30
      - uses: ./
        with:
          working-directory: ${{ env.FIXTURE }}
          name: ${{ env.PREFIX }}-crash
          passphrase: ${{ env.PASSPHRASE }}
          allow-apply-from-any-ref: true
          lock-timeout: 900
      - name: The abandoned lock is reclaimed and the apply goes through
        working-directory: ${{ env.FIXTURE }}
        run: |
          terraform init -input=false
          start=$(date +%s)
          terraform apply -auto-approve -input=false -var value=c
          echo "waited and applied in $(( $(date +%s) - start ))s" | tee -a "$GITHUB_STEP_SUMMARY"

  stale-save:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - run: test/scripts/install-tool.sh terraform
      - id: state
        uses: ./
        with:
          working-directory: ${{ env.FIXTURE }}
          name: ${{ env.PREFIX }}-stale
          passphrase: ${{ env.PASSPHRASE }}
          allow-apply-from-any-ref: true
      - working-directory: ${{ env.FIXTURE }}
        run: |
          terraform init -input=false
          terraform apply -auto-approve -input=false -var value=a
      - id: apply
        continue-on-error: true
        working-directory: ${{ env.FIXTURE }}
        run: |
          (sleep 8 && node "$GITHUB_WORKSPACE/test/scripts/push-direct.js" "$PREFIX-stale") &
          terraform apply -auto-approve -input=false -var value=b -var sleep=25 2>&1 | tee "$RUNNER_TEMP/apply.log"
          exit "${PIPESTATUS[0]}"
      - name: The save is refused because a newer version appeared
        run: |
          [ "${{ steps.apply.outcome }}" = failure ]
          grep -q 'HTTP error: 409' "$RUNNER_TEMP/apply.log"
          grep -q 'state changed since it was loaded' "$RUNNER_TEMP"/actions-state/*.log

  refs:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - run: test/scripts/install-tool.sh terraform
      - uses: ./
        with:
          working-directory: ${{ env.FIXTURE }}
          name: ${{ env.PREFIX }}-refs
          passphrase: ${{ env.PASSPHRASE }}
      - name: A pull request may plan
        working-directory: ${{ env.FIXTURE }}
        run: |
          terraform init -input=false
          terraform plan -input=false
      - id: apply
        continue-on-error: true
        working-directory: ${{ env.FIXTURE }}
        run: |
          terraform apply -auto-approve -input=false 2>&1 | tee "$RUNNER_TEMP/apply.log"
          exit "${PIPESTATUS[0]}"
      - name: But may not apply
        run: |
          [ "${{ steps.apply.outcome }}" = failure ]
          grep -q 'may only plan' "$RUNNER_TEMP/apply.log"

  cleanup:
    needs: [lifecycle-reload, wrong-passphrase, public-guard, backend-conflict, contention-verify, fail-fast, fail-fast-holder, crash-holder, crash-waiter, stale-save, refs]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - run: node test/scripts/cleanup.js "$PREFIX-"
```

- [ ] **Step 4: Lint and run the unit suite**

```bash
actionlint .github/workflows/*.yml
node --test 'test/unit/**/*.test.js'
```

Expected: no lint output; unit tests PASS.

- [ ] **Step 5: Commit and publish the repository**

```bash
git add test/fixtures test/scripts .github/workflows/integration.yml
git commit -m "Integration tests against GHCR and the Actions cache

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
gh repo create cnuss/actions-state --public \
  --description "Terraform and OpenTofu state on GitHub: GHCR for versions, the Actions cache for locks." \
  --source . --remote origin --push
gh api -X PUT repos/cnuss/actions-state/private-vulnerability-reporting --silent
gh api -X PUT repos/cnuss/actions-state/vulnerability-alerts --silent
gh api -X PUT repos/cnuss/actions-state/automated-security-fixes --silent
gh api -X PUT repos/cnuss/actions-state/actions/permissions -F enabled=true -f allowed_actions=selected --silent
gh api -X PUT repos/cnuss/actions-state/actions/permissions/selected-actions --silent \
  --input - <<'EOF'
{"github_owned_allowed": true, "verified_allowed": false, "patterns_allowed": ["cnuss/*"]}
EOF
```

- [ ] **Step 6: Watch the push-triggered runs**

```bash
sleep 15
for wf in test.yml integration.yml codeql.yml; do
  id=$(gh run list -R cnuss/actions-state -w "$wf" -L 1 --json databaseId --jq '.[0].databaseId')
  gh run watch "$id" -R cnuss/actions-state --interval 20 > /dev/null
  gh run view "$id" -R cnuss/actions-state --json conclusion,jobs --jq '"\(.conclusion)", (.jobs[] | "  \(.name): \(.conclusion)")'
done
```

Expected: `Unit tests` and `CodeQL` succeed. In `Integration`, every job succeeds except `crash-holder` (failure, allowed by `continue-on-error`); `refs` is skipped on a push. Fix failures before going on; a failure that contradicts the spec goes back to the user.

- [ ] **Step 7: Run the refs job through a pull request**

```bash
git switch -c ci/refs-check
git commit --allow-empty -m "Exercise the plan-only path from a pull request

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin ci/refs-check
gh pr create -R cnuss/actions-state --title "Exercise the plan-only path" --body "Runs the integration suite from a pull request so the refs job runs. Close without merging.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
sleep 15
id=$(gh run list -R cnuss/actions-state -w integration.yml -b ci/refs-check -L 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$id" -R cnuss/actions-state --interval 20 > /dev/null
gh run view "$id" -R cnuss/actions-state --json jobs --jq '.jobs[] | select(.name == "refs") | .conclusion'
gh pr close ci/refs-check -R cnuss/actions-state --delete-branch
git switch main
```

Expected: `success`.

---

### Task 12: README, branch protection, release

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write the README**

`README.md`:

````markdown
# actions-state

[![CodeQL](https://github.com/cnuss/actions-state/actions/workflows/codeql.yml/badge.svg)](https://github.com/cnuss/actions-state/actions/workflows/codeql.yml)
[![Unit tests](https://github.com/cnuss/actions-state/actions/workflows/test.yml/badge.svg)](https://github.com/cnuss/actions-state/actions/workflows/test.yml)
[![Integration](https://github.com/cnuss/actions-state/actions/workflows/integration.yml/badge.svg)](https://github.com/cnuss/actions-state/actions/workflows/integration.yml)
[![Security policy](https://img.shields.io/badge/security-policy-brightgreen)](./SECURITY.md)

Terraform and OpenTofu state on GitHub, with nothing to set up outside the
workflow. State versions are stored in GitHub Packages and locks live in the
Actions cache.

```yaml
permissions:
  actions: write   # locks
  packages: write  # state
  contents: read

jobs:
  apply:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: cnuss/actions-state@v1
        with:
          passphrase: ${{ secrets.STATE_PASSPHRASE }}  # required in public repos
      - run: terraform init
      - run: terraform apply -auto-approve
```

## How it works

The action starts a small server on the runner that speaks Terraform's `http`
backend protocol, and writes `actions_state_override.tf` into your root module
so Terraform uses it. The override file is removed when the job ends and is
listed in `.git/info/exclude`.

- **State** is saved to `ghcr.io/<owner>/<repo>/actions-state` on every write.
  The tag `<state>` points at the newest version and `<state>.v<serial>` keeps
  each one, so any version can be pulled back with standard OCI tools.
- **Locks** are cache entries, the mechanism from
  [actions-mutex](https://github.com/cnuss/actions-mutex). A second job waits
  for the lock (up to `lock-timeout`), and a lock left behind by a runner that
  died is reclaimed about a minute after that job ends.
- **Only the default branch writes.** Other refs (pull requests, feature
  branches) may `plan` against the current state; `apply` is refused unless
  `allow-apply-from-any-ref: true`. A save is also refused if a newer version
  appeared since the state was read.
- **Encryption.** With `passphrase`, state is encrypted (AES-256-GCM, key from
  scrypt) before it leaves the runner. Without one, the action refuses to run
  in a public repository or against a public package.

## Inputs

| input | default | description |
|---|---|---|
| `working-directory` | `.` | Root module directory. |
| `name` | derived | State name. Defaults to `working-directory` relative to the workspace (`root` for the workspace itself). |
| `passphrase` | | Encrypts state. Required for public repositories or packages. |
| `lock-timeout` | `600` | Seconds to wait for a lock held by another job. `0` fails at once. |
| `replace-backend` | `false` | Proceed even if the configuration declares a backend. |
| `allow-apply-from-any-ref` | `false` | Let refs other than the default branch apply. |
| `github-token` | `${{ github.token }}` | Needs `actions: write` and `packages: write`. |

## Outputs

| output | description |
|---|---|
| `state-name` | The resolved state name. |
| `image` | The state package. |
| `address` | The local state URL. |

## Several root modules

Use the action once per directory; each gets its own state:

```yaml
      - uses: cnuss/actions-state@v1
        with:
          working-directory: infra/dns
          passphrase: ${{ secrets.STATE_PASSPHRASE }}
      - uses: cnuss/actions-state@v1
        with:
          working-directory: infra/zone
          passphrase: ${{ secrets.STATE_PASSPHRASE }}
```

## Moving existing state

Run once with `replace-backend: true` and `terraform init -migrate-state
-force-copy`, which copies the old backend's state into actions-state. A local
`terraform.tfstate` in the directory is migrated the same way.

## Limits

- Locks are per ref. With `allow-apply-from-any-ref`, locks taken on different
  refs do not exclude each other; the stale-save check is the only guard.
- `terraform apply -lock=false` cannot save state.
- If a runner dies in the ~300 ms between reserving and finalizing a lock,
  that lock blocks for at least 90 minutes and cannot be deleted.
- The cache service allows about 200 lock reservations a minute per
  repository; many concurrent waiters slow each other down.
- Terraform workspaces are not supported (the `http` backend has only
  `default`). Use `name` instead.
- Changing the passphrase: pull the newest version with the old passphrase
  (`terraform state pull > state.json`), change the secret, then
  `terraform state push state.json`.
- A failed save leaves `errored.tfstate` in the working directory. To keep it,
  add `actions/upload-artifact` with `if: failure()`; it is plaintext.

## Notes

- Dependency-free: no `node_modules`, no bundling, no build step. Node 24.
- The server log is printed in a collapsed group at the end of the job. Set
  `ACTIONS_STEP_DEBUG=true` for every request.
````

- [ ] **Step 2: Commit and push**

```bash
git add README.md
git commit -m "README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

- [ ] **Step 3: Protect `main` (same rules as actions-mutex, plus unit tests)**

```bash
gh api -X PUT repos/cnuss/actions-state/branches/main/protection --silent --input - <<'EOF'
{
  "required_status_checks": {"strict": true, "checks": [{"context": "Analyze", "app_id": 15368}, {"context": "Unit tests", "app_id": 15368}]},
  "enforce_admins": true,
  "required_pull_request_reviews": {"dismiss_stale_reviews": true, "require_code_owner_reviews": false, "required_approving_review_count": 0, "require_last_push_approval": false},
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false
}
EOF
gh api -X POST repos/cnuss/actions-state/branches/main/protection/required_signatures --silent
gh api repos/cnuss/actions-state/branches/main/protection --jq '[.required_status_checks.contexts, .enforce_admins.enabled, .required_signatures.enabled]'
```

Expected: `[["Analyze","Unit tests"],true,true]`

- [ ] **Step 4: Release v1.0.0 (after the user confirms)**

Ask the user before releasing. Then:

```bash
gh run list -R cnuss/actions-state -b main -L 3 --json workflowName,conclusion --jq '.[] | "\(.workflowName): \(.conclusion)"'
gh workflow run release.yml -R cnuss/actions-state --ref main -f version=v1.0.0
sleep 10
id=$(gh run list -R cnuss/actions-state -w release.yml -L 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$id" -R cnuss/actions-state --exit-status
for t in v1.0.0 v1; do printf '%s -> ' "$t"; gh api "repos/cnuss/actions-state/commits/$t" --jq '.sha[0:7]'; done
```

Expected: both tags point at the same commit, the newest on `main`.
