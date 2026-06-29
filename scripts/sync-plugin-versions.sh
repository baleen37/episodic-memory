#!/usr/bin/env bash
set -euo pipefail

# package.json is the source of truth for shared plugin metadata.
version="$(jq -r '.version' package.json)"
description="$(jq -r '.description' package.json)"
repository="$(jq -r '.repository.url // .repository' package.json)"
homepage="$(jq -r '.homepage // .repository.url // .repository' package.json)"
license="$(jq -r '.license' package.json)"
keywords="$(jq -c '.keywords' package.json)"

tmp="$(mktemp)"
jq \
  --arg version "$version" \
  --arg description "$description" \
  --arg repository "$repository" \
  --arg homepage "$homepage" \
  --arg license "$license" \
  --argjson keywords "$keywords" \
  '.version = $version
   | .description = $description
   | .repository = $repository
   | .homepage = $homepage
   | .license = $license
   | .keywords = $keywords' \
  .claude-plugin/plugin.json > "$tmp"
mv "$tmp" .claude-plugin/plugin.json

tmp="$(mktemp)"
jq \
  --arg version "$version" \
  --arg description "$description" \
  --arg repository "$repository" \
  --arg homepage "$homepage" \
  --arg license "$license" \
  --argjson keywords "$keywords" \
  '.version = $version
   | .description = $description
   | .repository = $repository
   | .homepage = $homepage
   | .license = $license
   | .keywords = $keywords' \
  .codex-plugin/plugin.json > "$tmp"
mv "$tmp" .codex-plugin/plugin.json
