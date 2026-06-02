#!/usr/bin/env bash
set -euo pipefail

# Arrange: 임시 작업 디렉터리에 버전이 어긋난 메타데이터 파일들을 만든다.
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

mkdir -p "$workdir/.claude-plugin" "$workdir/.codex-plugin"
echo '{"version":"9.9.9","name":"memmem"}' > "$workdir/package.json"
echo '{"version":"0.0.0","name":"memmem"}' > "$workdir/.claude-plugin/plugin.json"
echo '{"version":"0.0.0","name":"memmem"}' > "$workdir/.codex-plugin/plugin.json"
echo '{"plugins":[{"name":"memmem","version":"0.0.0"}]}' > "$workdir/.claude-plugin/marketplace.json"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Act: 스크립트를 임시 디렉터리에서 실행한다.
( cd "$workdir" && bash "$SCRIPT_DIR/sync-plugin-versions.sh" )

# Assert: 세 파일이 모두 package.json 버전(9.9.9)에 정렬됐다.
fail=0
check() {
  local label="$1" actual="$2"
  if [[ "$actual" != "9.9.9" ]]; then
    echo "FAIL: $label expected 9.9.9 got $actual"
    fail=1
  fi
}
check "claude plugin.json" "$(jq -r '.version' "$workdir/.claude-plugin/plugin.json")"
check "codex plugin.json"  "$(jq -r '.version' "$workdir/.codex-plugin/plugin.json")"
check "marketplace.json"   "$(jq -r '.plugins[0].version' "$workdir/.claude-plugin/marketplace.json")"

if [[ "$fail" -ne 0 ]]; then
  echo "sync-plugin-versions.test.sh FAILED"
  exit 1
fi
echo "sync-plugin-versions.test.sh PASSED"
