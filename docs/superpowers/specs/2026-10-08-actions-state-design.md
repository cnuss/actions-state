# actions-state design

Date: 2026-10-08
Status: draft for review

## Goal

Terraform and OpenTofu state that lives entirely on GitHub, with no setup
outside the workflow:

```yaml
permissions:
  actions: write   # locks
  packages: write  # state
  contents: read

steps:
  - uses: actions/checkout@v6
  - uses: cnuss/actions-state@v1
  - run: terraform init -upgrade
  - run: terraform apply -auto-approve
```

The action starts a local server that speaks Terraform's HTTP backend protocol.
Locks are entries in the Actions cache (the actions-mutex mechanism). State
versions are OCI artifacts in GitHub Packages (GHCR). Prior art: tfstate.dev,
which served the same protocol from a hosted API; this needs no hosted service.

## Decisions

| topic | decision |
|---|---|
| Tools in v1 | Terraform and OpenTofu. The storage core is tool-agnostic so a Pulumi adapter (or anything else that needs state) can be added later. |
| State identity | One state per root-module directory. `name` overrides the derived name. |
| Encryption | Optional `passphrase`. Without one, the action refuses to run when the repo or the state package is public. |
| Lock contention | The server waits for the lock up to `lock-timeout` (default 600 s). `lock-timeout: 0` fails fast. |
| Refs | Only the default branch writes state. Other refs may plan. `allow-apply-from-any-ref: true` lifts this. Saves are also refused when GHCR has a newer version than the one loaded. |
| Wiring | The action writes a `_override.tf` file declaring the `http` backend. A declared backend is an error unless `replace-backend: true`. |
| Implementation | Dependency-free Node 24 JavaScript action with a detached background server, like actions-run-once and actions-mutex. |

## Interface

### Inputs

| input | default | description |
|---|---|---|
| `working-directory` | `.` | Root module directory. The override file goes here. |
| `name` | derived | State name. Derived from `working-directory` relative to the workspace: `.` becomes `root`, `infra/zone` stays `infra/zone`. |
| `passphrase` | | Encrypts state before it leaves the runner. Required when the repo or package is public. |
| `lock-timeout` | `600` | Seconds the server waits for a held lock. `0` means one attempt. |
| `replace-backend` | `false` | Proceed even if the configuration declares a backend; the override replaces it. |
| `allow-apply-from-any-ref` | `false` | Let refs other than the default branch take write locks and save state. |
| `github-token` | `${{ github.token }}` | Needs `actions: write` and `packages: write`. |

### Outputs

| output | description |
|---|---|
| `state-name` | The resolved state name. |
| `image` | `ghcr.io/<owner>/<repo>/actions-state`. |
| `address` | The server's state URL, e.g. `http://127.0.0.1:41234/state`. |

## Architecture

```
action.yml           inputs, outputs, main + post (post-if: always())
index.js             main/post dispatcher (STATE_post, as in actions-mutex)
src/
  server.js          HTTP server; runs as its own detached process
  core/
    http.js          fresh-socket request helper, cache-service (twirp) and REST clients
    lock.js          cache-entry mutex: acquire with wait, release, holder record, reclaim
    store.js         GHCR client: resolve tag, pull, push, tag
    crypto.js        passphrase envelope
    names.js         state name and tag slug rules
  adapters/
    index.js         adapter interface and registry
    terraform.js     backend detection, override file, env
```

Unit boundaries:

- `core/` knows nothing about Terraform. Per state name it offers
  `lock(info, { waitMs, mode })`, `unlock(id)`, `load()` and
  `save(bytes, meta)`.
- An adapter implements `check(dir)` (fail on conflicting configuration),
  `wire(dir, endpoint)` (write files, return env) and `unwire(dir)`. It also
  names the layer media type for its state. v1 ships `terraform`, which covers
  Terraform and OpenTofu.
- `server.js` maps HTTP-backend requests onto `core/`.
- `core/lock.js` is lifted from actions-mutex (copied, not imported, so the
  action stays dependency-free).

### Lifecycle

Main step:

1. Resolve the state name, the tag slug and whether this run is on the default
   branch (`GITHUB_REF` against `repository.default_branch` from the event
   payload, falling back to the REST API).
2. `adapter.check(working-directory)`.
3. Without a passphrase, check the repo's visibility and, if the package
   exists, the package's. Fail if either is public.
4. Generate the job's server password, or reuse it if an earlier use of the
   action in this job created one (`$RUNNER_TEMP/actions-state/password`).
   Mask it with `::add-mask::`.
5. Start `node src/server.js` detached (`detached: true`, `unref()`), logging to
   `$RUNNER_TEMP/actions-state/<slug>.log`. Secrets reach it through its
   environment, never its arguments: `ACTIONS_RUNTIME_TOKEN`,
   `ACTIONS_RESULTS_URL`, the GitHub token, the passphrase, the password.
6. The server listens on `127.0.0.1:0`, fetches the newest state version
   (failing on a decryption error), then writes
   `$RUNNER_TEMP/actions-state/<slug>.json` with its pid and port.
7. Main waits up to 10 s for that file and a passing `GET /health`, else fails
   and prints the server log.
8. `adapter.wire()` writes the override file and the step exports the env.

Steps in between run Terraform against the server. Every save is pushed to GHCR
before the server answers, so nothing is pending when the job ends.

Post step:

1. `POST /shutdown`. The server releases any lock it still holds, then exits.
2. If the server does not answer, delete the cache entries listed in
   `<slug>.json` directly and kill the pid.
3. `adapter.unwire()`.
4. Print the server log in a collapsed group.

### Terraform wiring

`actions_state_override.tf` in `working-directory`:

```hcl
terraform {
  backend "http" {
    address        = "http://127.0.0.1:<port>/state"
    lock_address   = "http://127.0.0.1:<port>/lock"
    unlock_address = "http://127.0.0.1:<port>/lock"
    lock_method    = "LOCK"
    unlock_method  = "UNLOCK"
    update_method  = "POST"
    username       = "actions-state"
  }
}
```

The addresses go in the file, not in `TF_HTTP_ADDRESS`, because env vars apply
to the whole job: two `uses:` for two directories in one job would otherwise
point at the same server. The password is the only job-wide value and is
exported as `TF_HTTP_PASSWORD`.

- In an override file, a `backend` block replaces the original's entirely, so
  `replace-backend` needs nothing further.
- The file is appended to `.git/info/exclude` when the directory is inside a
  git work tree, and removed in post.
- Backend detection reads `*.tf`, `*.tf.json`, `*.tofu` and `*.tofu.json` in
  the directory (not recursively), strips `#`, `//` and `/* */` comments, and
  looks for `backend "<type>"` or `cloud {` inside `terraform` blocks (JSON:
  `terraform[].backend` / `terraform[].cloud`). A file this action wrote earlier
  is ignored.
- A local `terraform.tfstate` in the directory makes `terraform init` ask about
  migrating; the README documents running `terraform init -migrate-state` once.

## HTTP protocol

All requests need Basic auth with the job's password; otherwise 401.

| request | behavior |
|---|---|
| `GET /state` | Re-resolve the `<slug>` tag. If its digest equals the cached one, serve the cache; otherwise pull and decrypt. Remember the loaded digest. 200 with the state, or 404 when no state exists (Terraform starts empty). |
| `POST /state?ID=<id>` | 403 on a non-default ref unless `allow-apply-from-any-ref`. 409 if `ID` is missing (`-lock=false`; saving always requires the lock) or is not the lock this server holds. Stale check: resolve `<slug>`; if its digest differs from the loaded digest, 409 with both serials. Otherwise encrypt (if configured), push, update the loaded digest, 200. Push failures (network, 5xx) are retried 3 times with backoff, then 502. |
| `DELETE /state` | 405. The HTTP backend only uses it for workspace deletion, which it does not support. |
| `LOCK /lock` | Body is Terraform's lock info (`ID`, `Operation`, `Who`, `Info`, `Version`, `Created`, `Path`). Rules below. 200 when granted; 423 with the holder's lock info on timeout. |
| `UNLOCK /lock` | If `ID` matches the lock this server holds, release it, 200. If it matches the lock info in another job's holder record (`terraform force-unlock` from another run), delete that lock entry, 200. Otherwise 409 with the current holder's lock info. |
| `GET /health`, `POST /shutdown` | Internal. |

### Lock rules

- Default branch: any operation takes the cache lock, waiting up to
  `lock-timeout`. The holder record carries Terraform's lock info along with
  the job identity, so 423 responses and `force-unlock` can show and match it.
- Other refs: only `OperationTypePlan` is allowed; other operations get 403
  unless `allow-apply-from-any-ref`. A plan lock creates no cache entry. The
  server waits until the default branch's lock is no longer visible (reads from
  a non-default ref fall back to the default branch's cache scope), then grants
  a lock that exists only inside this server.
- With `allow-apply-from-any-ref`, non-default refs take a real cache lock in
  their own scope. That lock does not exclude other refs; the stale-save check
  is the remaining guard. The README says so.

### Cache keys

- Lock: `actions-state/<slug>` (version derived from the key, as in
  actions-mutex).
- Holder record: `actions-state/<slug>/holder/<entry id>`, containing the job
  identity (run id, attempt, job id, job name) and Terraform's lock info.
- Waiting, throttling and reclaim behave as in actions-mutex: read-gated
  polling, `CreateCacheEntry` only when the lock looks free or every 15 s,
  backoff on 429 honouring `Retry-After`, and reclaim once the holder's job has
  completed.

## Storage

### Package and tags

- Package: `ghcr.io/<owner>/<repo>/actions-state`, lowercased, with the
  `org.opencontainers.image.source` annotation set to the repo URL so the
  package links to the repo and inherits its access.
- Tag slug: the state name lowercased, every run of characters outside
  `[a-z0-9._-]` replaced by `-`, leading `.` and `-` trimmed. Names longer than
  100 characters become the first 89 characters, `-`, and the first 10 hex
  digits of the name's SHA-256.
- `<slug>`: moving tag for the newest version.
- `<slug>.v<serial>`: one tag per version, using the state's own `serial`.
- Nothing is deleted in v1.

### Manifest

An OCI image manifest per version:

- `artifactType`: `application/vnd.cnuss.actions-state.v1`
- `config`: the empty descriptor (`application/vnd.oci.empty.v1+json`, `{}`)
- One layer: `application/vnd.cnuss.actions-state.tfstate.v1` (plaintext JSON)
  or `application/vnd.cnuss.actions-state.tfstate.v1.enc` (encrypted). The
  adapter chooses the layer type.
- Annotations (`io.github.cnuss.actions-state.*`): `name`, `serial`, `lineage`,
  `encrypted`, `run-id`, `sha`, `ref`, `previous` (digest of the version this
  one replaced). Plus `org.opencontainers.image.source` and
  `org.opencontainers.image.created`.

### Save sequence

1. Resolve `<slug>`; compare with the loaded digest (409 on mismatch).
2. Upload the layer blob and the empty config blob.
3. Put the manifest by `<slug>.v<serial>`, then by `<slug>`.

The registry has no compare-and-swap, so a second writer could slip in between
steps 1 and 3. The window is short and only default-branch lock holders save,
so the check catches overwrites from other refs and from writers that bypassed
the lock, not a perfectly timed race.

### Registry auth

Token exchange at `https://ghcr.io/token` with scope
`repository:<owner>/<repo>/actions-state:pull,push`, Basic auth with the GitHub
token.

### Encryption

- Layer bytes: `ASTE1` (5 bytes) | salt (16) | nonce (12) | ciphertext | GCM tag (16).
- Key: scrypt(passphrase, salt, N=2^15, r=8, p=1, 32 bytes).
- Cipher: AES-256-GCM, additional authenticated data
  `<owner>/<repo>:<state name>`, so a version copied to another repo or state
  name fails to decrypt.
- A fresh salt and nonce per save.
- An encrypted state loaded without a passphrase, or with the wrong one, fails
  the main step: "decryption failed: wrong passphrase or tampered state".
- Passphrase rotation is out of scope for v1; the README documents pulling with
  the old passphrase and pushing with the new one.

## Failure handling

| failure | behavior |
|---|---|
| Terraform step fails or is cancelled holding the lock | The server stays up; post's `/shutdown` releases the lock. GHCR keeps the last successful save. |
| GHCR push fails | Three retries with backoff, then 502. Terraform reports "Failed to save state" and writes `errored.tfstate`. The README shows an `upload-artifact` step for that file, with a warning that it is plaintext. |
| Stale save | 409 with the loaded and current serials. Re-run the job. |
| Cache throttled | Backoff within `lock-timeout`, honouring `Retry-After`. |
| Cache service down | `LOCK` returns 503; Terraform retries twice, then fails to acquire the lock. |
| Server dies mid-job | Terraform gets connection errors. Post deletes the entries listed in `<slug>.json`. |
| Runner dies | Post never runs; the next waiter reclaims the lock once the job is marked completed. |
| Wrong or missing passphrase on encrypted state | Main step fails before Terraform runs. |
| Public repo or package without a passphrase | Main step fails with instructions. |
| Declared backend | Main step fails unless `replace-backend: true`. |
| Server does not start within 10 s | Main step fails and prints the server log. |

Logging: requests, lock events, digests and serials. Never state contents, the
passphrase, the password or tokens. `ACTIONS_STEP_DEBUG` adds per-request
detail with signed URLs redacted, as in the sibling actions.

## Testing

### Unit tests

`node --test`, run by `test.yml` on every pull request and required by branch
protection alongside CodeQL.

- `crypto`: round trip; a different repo or state name in the AAD fails;
  tampered ciphertext or tag fails.
- `names`: derived names, slug rules, the long-name hash form.
- `adapters/terraform`: no backend; `http`; `s3`; `cloud {}`; a backend inside a
  comment; several files; `.tf.json` and `.tofu`; override write and removal;
  env produced.
- `server`: every row of the protocol table against in-memory fakes of `lock`
  and `store`, including per-ref rules, `force-unlock`, stale saves and auth.
- `store`: manifest, tags and annotations built from a save.

### Integration workflows

`uses: ./`, a state name unique to each run, and a final job that deletes the
run's package versions. Every test except the public-guard one sets a
passphrase, since the repo is public. Fixtures use `terraform_data`, which is
built into Terraform 1.4+ and OpenTofu, so no providers or credentials are
needed.

| workflow | asserts |
|---|---|
| lifecycle (terraform, tofu) | Apply saves state; a second job loads it and `plan -detailed-exitcode` exits 0; serial and tags advance. |
| contention | Three concurrent applies on `main` serialize; the final serial is the initial one plus three. |
| fail-fast | With `lock-timeout: 0` a second job gets the 423 holder message immediately. |
| refs | On a branch, `plan` succeeds and `apply` is refused. |
| crash | The runner is killed mid-apply; the next job reclaims the lock. |
| encryption | The GHCR layer starts with `ASTE1`; a wrong passphrase fails the main step. |
| public guard | Without a passphrase, the main step fails. |
| backend conflict | An `s3` fixture fails; `replace-backend: true` proceeds. |
| stale save | Job A loads, a newer version is pushed directly, A's save gets 409. |

## Spike (before implementation)

Throwaway checks, each a short workflow in actions-test:

1. GHCR accepts the nested name `<repo>/actions-state`, a custom
   `artifactType` with the empty config, and the `<slug>.v<serial>` tags.
2. `GITHUB_TOKEN` can read the package's visibility through the REST API.
3. Terraform and OpenTofu keep a `LOCK` request open for 5 minutes without a
   client timeout.
4. A server started detached in one step is reachable from later steps and can
   be stopped from the post step.

A failure in 1 or 3 changes the design and comes back for review before
planning.

## Repository

`cnuss/actions-state`, public, with the same hygiene as actions-mutex: MIT
license, SECURITY.md with private vulnerability reporting, CODEOWNERS, CodeQL,
Dependabot for actions pinned by SHA, the manual release workflow (`vX.Y.Z` plus
moving `vX`), branch protection on `main` (CodeQL and unit tests required, PRs,
signed commits, linear history, conversation resolution, admins included), and
Actions restricted to GitHub-owned actions and `cnuss/*`.

## Out of scope for v1

- Pulumi and other adapters (the interface exists; no implementation).
- Passphrase rotation.
- Pruning old state versions.
- Locks that exclude other refs.
- Terraform workspaces (the HTTP backend supports only `default`).
- GitHub Enterprise Server.
