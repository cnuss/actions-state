#!/usr/bin/env bash
# Checks the null fixture's non-sensitive outputs. $1 is the outputs as JSON,
# $2 the secret they were applied with.
set -euo pipefail

sha=$(printf %s "$2" | sha256sum | cut -d' ' -f1)
if ! jq -e --arg sha "$sha" '
  (.id | type == "string" and length > 0) and
  del(.id) == {
    greeting: "hello",
    secret_sha: $sha,
    environments: {
      prod: {region: "us-east-1", replicas: 3, tags: {team: "core", tier: "web"}},
      dev: {region: "us-west-2", replicas: 1, tags: {team: "core", tier: "web"}}
    },
    subnets: [
      {cidr: "10.0.0.0/24", zones: ["a", "b"]},
      {cidr: "10.0.1.0/24", zones: ["c"]}
    ]
  }' <<<"$1" >/dev/null; then
  echo "::error::unexpected outputs: $1"
  exit 1
fi
