#!/usr/bin/env bash
set -euo pipefail

target="plugins/memmem"

rm -rf "$target"
mkdir -p "$target"

cp -pR \
  .codex-plugin \
  .claude-plugin \
  .mcp.json \
  skills \
  bin \
  dist \
  scripts \
  src \
  package.json \
  package-lock.json \
  bun.lock \
  tsconfig.json \
  README.md \
  "$target/"

# The runtime wrapper rebuilds when package.json is newer than dist. The plugin
# view is copied after package metadata, so keep bundled outputs decisively newer.
touch "$target"/dist/*.mjs
