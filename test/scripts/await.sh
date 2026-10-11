#!/usr/bin/env bash
# await.sh job <job name>                until that job of this run attempt has completed
# await.sh step <job name> <step>        until that step has started; prints when it started
# await.sh lock <state name> [<since>]   until the state's lock entry on this ref exists,
#                                        created at or after <since> (ISO 8601)
# Polls every 3 s for up to AWAIT_TIMEOUT seconds (default 300); exits 1 on timeout.
set -euo pipefail

jobs() { gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT/jobs?per_page=100"; }

check() {
  case "$1" in
    job) jobs | jq -e --arg j "$2" '.jobs[] | select(.name == $j and .status == "completed")' >/dev/null ;;
    step) jobs | jq -er --arg j "$2" --arg s "$3" \
      'first(.jobs[] | select(.name == $j) | .steps[]? | select(.name == $s and .started_at != null) | .started_at)' ;;
    lock) gh api -X GET "repos/$GITHUB_REPOSITORY/actions/caches" -f key="$key" -f ref="$GITHUB_REF" |
      jq -e --arg k "$key" --arg since "${3:-1970-01-01T00:00:00Z}" \
        '.actions_caches[] | select(.key == $k and (.created_at | sub("\\.[0-9]+"; "") | fromdate) >= ($since | fromdate))' >/dev/null ;;
    *) echo "usage: await.sh job|step|lock ..." >&2; exit 2 ;;
  esac
}

if [ "$1" = lock ]; then
  key=$(node -e 'const n = require(process.argv[1]); console.log(n.lockKey(n.tagSlug(process.argv[2])))' \
    "$GITHUB_WORKSPACE/src/core/names.js" "$2")
fi
deadline=$(( $(date +%s) + ${AWAIT_TIMEOUT:-300} ))
until check "$@"; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::timed out waiting for $*" >&2
    exit 1
  fi
  sleep 3
done
echo "done waiting for $*" >&2
