# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| `v1.x` (tag `v1`) | :white_check_mark: |
| `< v1` | :x: |

Always pin to a released tag — `uses: cnuss/actions-state@v1` (moving major)
or a full commit SHA for maximum supply-chain safety.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately via GitHub's **Private Vulnerability Reporting**:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (Advisories → Report).
3. Describe the issue, affected versions, and reproduction steps.

You will get an acknowledgement within **3 business days**. Once confirmed, a
fix and a GitHub Security Advisory (with CVE if warranted) will be published,
and the moving `v1` tag updated.

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
