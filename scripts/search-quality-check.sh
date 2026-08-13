#!/usr/bin/env bash
set -euo pipefail

unset NODE_ENV

echo 'benchmark: bun run bench:search-quality'
bun run bench:search-quality

echo 'tests: bun test'
export SEARCH_QUALITY_CHECK_RUNNING=1
bun test

echo 'typecheck: bun run typecheck'
bun run typecheck

echo 'build: bun run build'
bun run build
