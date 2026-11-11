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
  [actions-mutex](https://github.com/cnuss/actions-mutex). On the default
  branch (or with `allow-apply-from-any-ref`), the action's `pre` step takes
  the lock before the job's other steps run, and its `post` step releases it
  when the job ends. Terraform's own locks nest inside it, so every step of the
  job, including deploy steps after Terraform, runs under one hold. A second
  job waits for the lock (up to `lock-timeout`). A lock left by a job whose
  runner died is reclaimed by the next job waiting for it, which checks about
  once a minute (a short `lock-timeout` gets one check at the end of its wait).
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
| `repository` | | Another repository whose state to read. See [Outputs from another repository](#outputs-from-another-repository). |
| `passphrase` | | Encrypts state. Required for public repositories or packages. |
| `lock-timeout` | `600` | Seconds to wait for a lock held by another job. `0` fails at once. |
| `replace-backend` | `false` | Proceed even if the configuration declares a backend. |
| `allow-apply-from-any-ref` | `false` | Let refs other than the default branch apply. |
| `include-sensitive` | `true` | Set sensitive Terraform outputs as step outputs too; `false` leaves them out. See [Terraform outputs](#terraform-outputs). |
| `summary` | `true` | Write the Terraform outputs to the step summary; `false` turns it off. See [Terraform outputs](#terraform-outputs). |
| `run` | | Commands to run in `working-directory` once the backend is up. See [Running Terraform in the step](#running-terraform-in-the-step). |
| `github-token` | `${{ github.token }}` | Needs `actions: write` and `packages: write`; with `pull-requests: write` it also [comments the plan](#plans-on-pull-requests). |

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
the package. `pull-requests: write` is optional: with it, the plan is
commented on the pull request.

## Outputs

| output | description |
|---|---|
| `state-name` | The resolved state name. |
| `image` | The state package. |
| `address` | The local state URL. |
| `<output name>` | Each Terraform root module output. See [Terraform outputs](#terraform-outputs). |
| `json` | All included Terraform outputs as one JSON object (`{}` before the first apply). |
| `sensitive` | Names of sensitive Terraform outputs, as a JSON array. |
| `plan-changes` | `true` or `false`: whether the plan saved by `run` changes anything. See [Plans on pull requests](#plans-on-pull-requests). |
| `plan-comment-url` | The pull request comment that plan went to, or empty. |

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
          REGION: ${{ fromJSON(steps.state.outputs.environments).prod.region }}
```

- It runs like a bash `run:` step (`bash -e -o pipefail`) with the step's
  `env`, and its output streams to the log. A failing command fails the step.
- The action's inputs (the passphrase and token) are not in its environment.
- The step's [Terraform outputs](#terraform-outputs) come from the state the
  script leaves. Lines the script writes to `$GITHUB_OUTPUT` become outputs of
  this step too.
- The state server stays up for later steps in the job.
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

## Outputs from another repository

With `repository`, the step reads the newest version of that repository's
state and sets its [Terraform outputs](#terraform-outputs), so an app's
deploy can use what its infrastructure repository applied:

```yaml
      - id: infra
        uses: cnuss/actions-state@v1
        with:
          repository: my-org/infra
          name: terraform
      - run: echo "$BUCKET"
        env:
          BUCKET: ${{ steps.infra.outputs.bucket }}
```

- Nothing is served: no backend override, no lock, and `run` is refused.
  `working-directory` need not exist; give `name` as the other repository
  saves it (its `working-directory` there, by default).
- The job's token needs read access to `ghcr.io/<repository>/actions-state`.
  For `github.token`, add this repository under the package's settings,
  Manage Actions access, with the Read role.
- An encrypted state needs the same `passphrase`, and `repository` spelled
  as on GitHub: the encryption binds the writer's repository name.
- A missing tag, or one the token may not read, fails the step.

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

The action sets each root module output as a step output of the same name:
from the state after `run` when it is given, otherwise from the state as
loaded when the step starts. To use the result of an `apply`, run it in `run`:

```yaml
jobs:
  apply:
    runs-on: ubuntu-latest
    outputs:
      environments: ${{ steps.tf.outputs.environments }}
    steps:
      - uses: actions/checkout@v6
      - id: tf
        uses: cnuss/actions-state@v1
        with:
          passphrase: ${{ secrets.STATE_PASSPHRASE }}
          run: |
            terraform init -input=false
            terraform apply -input=false -auto-approve
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

- Strings are passed as they are; numbers, booleans, lists, maps and nested
  combinations are JSON, so read into them with `fromJSON(...)`.
- `json` holds every included output as one JSON object, so
  `fromJSON(steps.tf.outputs.json).<name>` works for strings too.
- Sensitive outputs are set too, masked in logs, and their names are listed
  in `sensitive` (a JSON array). GitHub drops job outputs that contain masked
  values, so they only reach later steps of the same job.
  `include-sensitive: false` leaves them out of the step outputs and `json`.
- An output named `json`, `sensitive`, `state-name`, `image`, `address`,
  `plan-changes` or `plan-comment-url` is only in `json`.
- A job that only reads state needs no Terraform: without `run`, the outputs
  are those of the state it loaded.
- The outputs are also written to the step summary, under an h2 heading that
  names the state (the summaries of all steps share one page), with one
  section per output. A map or object is a key and value table, sorted by
  key; a nested map is a table inside its row. A map whose values are all
  maps gets a heading per key instead. A list of scalars is joined with
  commas; other lists are JSON.
- Sensitive outputs appear in the summary by name only, whatever
  `include-sensitive` says. Other values are written unchanged, so GitHub
  still masks secrets in them; a value over 2048 characters is left out. A
  summary that would pass GitHub's 1 MiB limit is cut off at the end. If the
  summary can't be written, the step warns and goes on. `summary: false`
  turns it off.

## Plans on pull requests

Every `terraform plan` (or `tofu plan`) in the job is saved, and the action
renders it to the step summary and, on a pull request, to a comment, so
reviewers see the resource changes next to the code changes:

```yaml
on: pull_request

permissions:
  actions: read
  packages: read
  contents: read
  pull-requests: write   # only for the comment

jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: cnuss/actions-state@v1
        with:
          passphrase: ${{ secrets.STATE_PASSPHRASE }}
          run: |
            terraform init -input=false
            terraform plan -input=false
```

- The action sets `TF_CLI_ARGS_plan=-out=actions_state.tfplan` for the job,
  so a plain `plan` saves to the root module, and lists the file in
  `.git/info/exclude`. A plan saved with your own `-out` is found too: the
  newest plan file in `working-directory` since the step started. The
  variable is job-wide, so a plan run in a directory the action does not
  serve leaves `actions_state.tfplan` there.
- A plan saved in `run` is rendered at the end of the step and sets the
  `plan-changes` and `plan-comment-url` outputs. A plan saved in a later step
  is rendered when the job ends, without outputs.
- The comment has the counts (`Plan: 1 to add, 0 to change, 1 to destroy`)
  and a report from [tfplan2md](https://github.com/oocx/tfplan2md): a summary
  table and a collapsed section per resource. Changes made outside Terraform
  are shown only for resources the plan changes. When tfplan2md can't run, the
  plan is shown as `show` prints it, in a `diff` block. A footer names the
  state serial and the commit the plan was made against, and links the run.
- Each state has one comment, updated on every push. A plan with no changes
  adds no comment, but an earlier comment is changed to say "No changes".
- Without `pull-requests: write`, or on a pull request from a fork, whose
  token is read-only, there is no comment and the step goes on. The step
  summary has the plan either way; `summary: false` leaves it out.
- A plan too long for a comment (65,536 characters) is cut down to the
  summary table, then to the text, with a link to the run.
- The plan is read with `terraform show -json`, or `tofu show -json` when
  terraform can't read it. The setup actions' wrappers are skipped for the
  `terraform-bin` and `tofu-bin` beside them.
- tfplan2md is downloaded from its GitHub release (version pinned, checked
  against a SHA-256 in this action) on Linux x64 and arm64 and macOS arm64.
  The Linux builds need glibc 2.39 (`ubuntu-24.04`); on older runners the
  text is used instead.

**Secrets.** A comment is posted through the API, so the runner's log
masking does not apply to it, and in a public repository anyone can read
it, even though the state is encrypted. Terraform shows values marked
`sensitive` as `(sensitive value)`; the action also replaces every value the
plan marks sensitive (variables, outputs, attributes) wherever else it
appears, along with the token and passphrase. Values of 5 characters or
fewer are not replaced. A secret that reaches an attribute Terraform does not
mark sensitive is shown, as it is in the log: mark variables
`sensitive = true`.

## Moving existing state

Run once with `replace-backend: true` and `terraform init -migrate-state
-force-copy`, which copies the old backend's state into actions-state. A local
`terraform.tfstate` in the directory is migrated the same way.

## Limits

- The job's lock is taken in `pre`, so waiting jobs queue in the order they
  start, not in commit order.
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
  The one download is the pinned tfplan2md binary for plan comments.
- The server log is printed in a collapsed group at the end of the job.
- Per-request logging of the action's outbound requests (cache, registry,
  GitHub API) turns on with runner debug logging: re-run the job with debug
  logging enabled, or set the `ACTIONS_STEP_DEBUG` secret. URLs are logged
  without query strings.
