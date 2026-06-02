#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/dispatch-marketplace-update.sh"

fail=0

# Test 1: 필수 환경변수(RELEASE_VERSION)가 없으면 실패한다.
if MARKETPLACE_DISPATCH_TOKEN=x RELEASE_VERSION= bash "$SCRIPT" >/dev/null 2>&1; then
  echo "FAIL: missing RELEASE_VERSION should error"
  fail=1
else
  echo "ok: errors on missing RELEASE_VERSION"
fi

# Test 2: 필수 토큰이 없으면 실패한다.
if MARKETPLACE_DISPATCH_TOKEN= RELEASE_VERSION=1.2.3 bash "$SCRIPT" >/dev/null 2>&1; then
  echo "FAIL: missing token should error"
  fail=1
else
  echo "ok: errors on missing token"
fi

# Test 3: curl을 가짜로 대체해 올바른 URL과 payload가 만들어지는지 확인한다.
shim="$(mktemp -d)"
trap 'rm -rf "$shim"' EXIT
cat > "$shim/curl" <<'SHIM'
#!/usr/bin/env bash
# 인자와 stdin(payload)을 파일로 떨군다.
echo "$@" > "$CURL_CAPTURE/args"
# -d 다음 값이 payload
prev=""
for a in "$@"; do
  if [[ "$prev" == "-d" ]]; then echo "$a" > "$CURL_CAPTURE/payload"; fi
  prev="$a"
done
SHIM
chmod +x "$shim/curl"

export CURL_CAPTURE="$shim"
PATH="$shim:$PATH" \
  MARKETPLACE_DISPATCH_TOKEN="tok123" \
  RELEASE_VERSION="1.2.3" \
  MARKETPLACE_REPOSITORY="baleen37/baleen-marketplace" \
  PLUGIN_NAME="memmem" \
  bash "$SCRIPT"

args="$(cat "$shim/args")"
payload="$(cat "$shim/payload")"

if [[ "$args" != *"https://api.github.com/repos/baleen37/baleen-marketplace/dispatches"* ]]; then
  echo "FAIL: wrong URL: $args"; fail=1
else
  echo "ok: correct dispatch URL"
fi

if [[ "$(echo "$payload" | jq -r '.event_type')" != "update_versions" ]]; then
  echo "FAIL: wrong event_type: $payload"; fail=1
else
  echo "ok: event_type=update_versions"
fi
if [[ "$(echo "$payload" | jq -r '.client_payload.version')" != "1.2.3" ]]; then
  echo "FAIL: wrong version: $payload"; fail=1
else
  echo "ok: version=1.2.3"
fi
if [[ "$(echo "$payload" | jq -r '.client_payload.plugin')" != "memmem" ]]; then
  echo "FAIL: wrong plugin: $payload"; fail=1
else
  echo "ok: plugin=memmem"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "dispatch-marketplace-update.test.sh FAILED"
  exit 1
fi
echo "dispatch-marketplace-update.test.sh PASSED"
