#!/usr/bin/env bash
# check-summary.sh <state name> [first line]
# Checks the outputs summary an earlier step of this job wrote for the null fixture.
# The runner keeps only the masked copy of an earlier step's summary.
set -euo pipefail

heading="## Terraform outputs · \`$1\`"
md=""
for f in "$(dirname "$GITHUB_STEP_SUMMARY")"/step_summary_*-scrubbed; do
  if [ -f "$f" ] && grep -qxF "$heading" "$f"; then md=$f; fi
done
if [ -z "$md" ]; then
  echo "::error::no step summary has the heading $heading"
  exit 1
fi
cat "$md"

grep -A2 -xF "$heading" "$md" | grep -F '<sub>actions-state · <code>ghcr.io/' >/dev/null

if [ -n "${2:-}" ]; then test "$(head -n1 "$md")" = "$2"; fi
grep -A2 -xF '### `greeting`' "$md" | grep -xF '`hello`' >/dev/null
grep -A2 -xF '### `subnets`' "$md" | grep -xF '`[{"cidr":"10.0.0.0/24","zones":["a","b"]},{"cidr":"10.0.1.0/24","zones":["c"]}]`' >/dev/null
grep -A60 -xF '#### `prod`' "$md" | grep -A3 -xF '<td><code>region</code></td>' | grep -xF '`us-east-1`' >/dev/null
grep -A60 -xF '#### `prod`' "$md" | grep -A2 -xF '<td><code>tags</code></td>' | grep -xF '<table>' >/dev/null
grep -A3 -xF '<td><code>tier</code></td>' "$md" | grep -xF '`web`' >/dev/null
if grep -qF '<details>' "$md"; then
  echo "::error::the step summary collapses a table"
  exit 1
fi
grep -A2 -xF '### `secret`' "$md" | grep -xF '_Sensitive; not shown._' >/dev/null
if grep -qF '***' "$md"; then
  echo "::error::a masked value reached the step summary"
  exit 1
fi
