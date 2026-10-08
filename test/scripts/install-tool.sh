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
