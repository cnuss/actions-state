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
  for the lock (up to `lock-timeout`). A lock left by a job whose runner died
  is reclaimed by the next job waiting for it, which checks about once a
  minute (a short `lock-timeout` gets one check at the end of its wait).
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
| `run` | | Commands to run in `working-directory` once the backend is up. See [Running Terraform in the step](#running-terraform-in-the-step). |
| `github-token` | `${{ github.token }}` | Needs `actions: write` and `packages: write`. |

## Names

The state name becomes an OCI tag (lowercased, characters outside
`a-z0-9._-` replaced with `-`), and the lock is keyed on the same tag.

- A name whose tag would end in `.v<digits>` (for example `api.v2`) is refused,
  because it collides with per-version tags.
- Names that differ only in case or in `/` versus `-` (`Infra/DNS`,
  `infra-dns`) map to the same tag and the same lock. Give them distinct
  `name`s.
- If a tag already holds another state's version, the action refuses to load
  or save it.

## Permissions

On the default branch, or with `allow-apply-from-any-ref`, the action checks
`actions: write` and `packages: write` up front and fails before Terraform
runs if either is missing. Plan-only jobs (other refs) do not need the write
permissions, but still need `actions: read`, `packages: read` and
`contents: read`, because the action reads the repository, this job's id and
the package.

## Outputs

| output | description |
|---|---|
| `state-name` | The resolved state name. |
| `image` | The state package. |
| `address` | The local state URL. |
| `outputs` | Non-sensitive root module outputs as a JSON object: of the state after `run` when given, else of the state as loaded (`{}` before the first apply). |

## Running Terraform in the step

`run` runs commands in `working-directory` once the backend is up, so one
step can replace the action plus a separate `run:` step:

```yaml
      - id: state
        uses: cnuss/actions-state@v1
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
        with:
          passphrase: ${{ secrets.STATE_PASSPHRASE }}
          run: |
            terraform init -input=false
            terraform apply -input=false -auto-approve
      - run: echo "$REGION"
        env:
          REGION: ${{ fromJSON(steps.state.outputs.outputs).environments.prod.region }}
```

- It runs like a bash `run:` step (`bash -e -o pipefail`) with the step's
  `env`, and its output streams to the log. A failing command fails the step.
- The action's inputs (the passphrase and token) are not in its environment.
- After it, `outputs` holds the newest state's outputs. Lines the script
  writes to `$GITHUB_OUTPUT` become outputs of this step.
- The state server stays up for later steps in the job, such as
  `cnuss/actions-state/outputs`.
- The script appears in the step's log header, like any input; keep secrets
  in `env`.

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

## Secrets as variables

Pass a repository secret to a Terraform variable through a `TF_VAR_<name>`
environment variable on each step that runs `plan` or `apply`:

```hcl
variable "db_password" {
  type      = string
  sensitive = true
}
```

```yaml
      - uses: cnuss/actions-state@v1
        with:
          passphrase: ${{ secrets.STATE_PASSPHRASE }}
      - run: terraform init
      - run: terraform apply -auto-approve
        env:
          TF_VAR_db_password: ${{ secrets.DB_PASSWORD }}
```

GitHub masks the secret in logs, and `sensitive = true` keeps it out of plan
output. A value that reaches a resource or output is still written to state,
so set `passphrase` to encrypt it, even in a private repository.

## Terraform outputs

`cnuss/actions-state/outputs` turns the root module outputs of the newest
state into step outputs. Use it after `apply`, with the same
`working-directory` or `name`:

```yaml
jobs:
  apply:
    runs-on: ubuntu-latest
    outputs:
      environments: ${{ steps.tf.outputs.environments }}
    steps:
      - uses: actions/checkout@v6
      - uses: cnuss/actions-state@v1
        with:
          passphrase: ${{ secrets.STATE_PASSPHRASE }}
      - run: terraform init
      - run: terraform apply -auto-approve
      - id: tf
        uses: cnuss/actions-state/outputs@v1
      - run: echo "$URL"
        env:
          URL: ${{ steps.tf.outputs.url }}

  deploy:
    needs: apply
    runs-on: ubuntu-latest
    steps:
      - run: echo "$REGION"
        env:
          REGION: ${{ fromJSON(needs.apply.outputs.environments).prod.region }}
```

- Each output becomes a step output of the same name. Strings are passed as
  they are; numbers, booleans, lists, maps and nested combinations are JSON,
  so read into them with `fromJSON(...)`.
- `json` holds every included output as one JSON object, so
  `fromJSON(steps.tf.outputs.json).<name>` works for strings too.
- Sensitive outputs are left out and their names listed in `sensitive` (a JSON
  array). `include-sensitive: true` sets them too, masked in logs, but GitHub
  drops job outputs that contain masked values, so they only reach later steps
  of the same job.
- An output named `json` or `sensitive` is only in `json`.
- A job that only reads state does not need Terraform: the main action's
  `outputs` output has the outputs of the state it loaded.

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
- Renaming or transferring the repository changes the package path and the
  encryption binding, so existing state is not found. Migrate first:
  `terraform state pull > state.json` before, `terraform state push
  state.json` after.
- Making a private repository public does not re-encrypt versions already
  stored. Delete the old plaintext versions or the package.
- Tested on Linux (`ubuntu-latest`) runners only.
- The passphrase cannot be changed in place: stored versions are decrypted
  with the current secret, so a changed secret makes the state unreadable.
  Keep the secret stable. Rotation is not supported yet.
- A failed save leaves `errored.tfstate` in the working directory. To keep it,
  add `actions/upload-artifact` with `if: failure()`; it is plaintext.

## Notes

- Dependency-free: no `node_modules`, no bundling, no build step. Node 24.
- The server log is printed in a collapsed group at the end of the job.
- Per-request logging of the action's outbound requests (cache, registry,
  GitHub API) turns on with runner debug logging: re-run the job with debug
  logging enabled, or set the `ACTIONS_STEP_DEBUG` secret. URLs are logged
  without query strings.
