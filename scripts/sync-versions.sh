#!/usr/bin/env bash
# Usage: scripts/sync-versions.sh <version>
# Sets the release version in Cargo.toml, Cargo.lock (own package entry only),
# and both plugin.json files. Uses sed/awk only (no cargo/jq needed).
set -euo pipefail

VER="${1:?usage: sync-versions.sh <version>}"
cd "$(dirname "$0")/.."

# Cargo.toml: only the first `version = ` line, which is in [package].
awk -v v="$VER" '!done && /^version = "/ { print "version = \"" v "\""; done=1; next } { print }' Cargo.toml >Cargo.toml.tmp
mv Cargo.toml.tmp Cargo.toml

# Cargo.lock: version line of the `episodic-memory` [[package]] entry.
awk -v v="$VER" '
  /^\[\[package\]\]/ { inpkg=1; own=0 }
  inpkg && /^name = "episodic-memory"$/ { own=1 }
  own && /^version = "/ { print "version = \"" v "\""; own=0; next }
  { print }
' Cargo.lock >Cargo.lock.tmp
mv Cargo.lock.tmp Cargo.lock

for f in .claude-plugin/plugin.json .codex-plugin/plugin.json; do
  sed -E "s/^([[:space:]]*\"version\"[[:space:]]*:[[:space:]]*\")[^\"]*(\")/\1$VER\2/" "$f" >"$f.tmp"
  mv "$f.tmp" "$f"
done
