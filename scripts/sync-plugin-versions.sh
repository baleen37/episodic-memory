#!/usr/bin/env bash
set -euo pipefail

# package.json 버전을 단일 진실원본으로 삼아 나머지 메타데이터 파일에 기록한다.
version="$(jq -r '.version' package.json)"

tmp="$(mktemp)"
jq --arg version "$version" '.version = $version' \
  .claude-plugin/plugin.json > "$tmp"
mv "$tmp" .claude-plugin/plugin.json

tmp="$(mktemp)"
jq --arg version "$version" '.version = $version' \
  .codex-plugin/plugin.json > "$tmp"
mv "$tmp" .codex-plugin/plugin.json

tmp="$(mktemp)"
jq --arg version "$version" '.plugins[0].version = $version' \
  .claude-plugin/marketplace.json > "$tmp"
mv "$tmp" .claude-plugin/marketplace.json
