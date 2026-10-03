#!/usr/bin/env bats
# Wrapper tests: stub binaries and stub uname/curl on PATH. No network.

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  WRAPPER="$ROOT/bin/episodic-memory"
  VER="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/.claude-plugin/plugin.json" | head -n 1)"
  T="$(mktemp -d)"
  export EPISODIC_MEMORY_DIR="$T/data"
  STUBS="$T/stubs"
  mkdir -p "$STUBS" "$EPISODIC_MEMORY_DIR/bin"
  unset EPISODIC_MEMORY_BIN
}

teardown() {
  rm -rf "$T"
}

make_bin() { # path
  printf '#!/bin/sh\necho "stub $*"\n' >"$1"
  chmod 0755 "$1"
}

stub_uname() { # os arch
  cat >"$STUBS/uname" <<STUB
#!/bin/sh
case "\$1" in -s) echo "$1" ;; -m) echo "$2" ;; esac
STUB
  chmod +x "$STUBS/uname"
}

# curl stub: copies files from \$FIXTURES by URL basename; fails if absent.
stub_curl() {
  cat >"$STUBS/curl" <<'STUB'
#!/bin/sh
out=""; url=""
echo "$*" >>"$CURL_ARGS"
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; --connect-timeout|--max-time) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
echo "$url" >>"$CURL_LOG"
src="$FIXTURES/$(basename "$url")"
[ -f "$src" ] || exit 22
cp "$src" "$out"
STUB
  chmod +x "$STUBS/curl"
  export CURL_LOG="$T/curl.log"
  export CURL_ARGS="$T/curl.args"
  export FIXTURES="$T/fixtures"
  mkdir -p "$FIXTURES"
}

make_release() { # target [corrupt]
  local name="episodic-memory-v$VER-$1"
  mkdir -p "$T/pkg"
  make_bin "$T/pkg/episodic-memory"
  tar -czf "$FIXTURES/$name.tar.gz" -C "$T/pkg" episodic-memory
  local hex
  hex="$( (shasum -a 256 "$FIXTURES/$name.tar.gz" 2>/dev/null || sha256sum "$FIXTURES/$name.tar.gz") | awk '{print $1}')"
  [ "${2:-}" = corrupt ] && hex="0000000000000000000000000000000000000000000000000000000000000000"
  echo "$hex  $name.tar.gz" >"$FIXTURES/$name.sha256"
}

@test "EPISODIC_MEMORY_BIN runs the override with args verbatim" {
  make_bin "$T/override"
  EPISODIC_MEMORY_BIN="$T/override" run "$WRAPPER" mcp --flag "a b"
  [ "$status" -eq 0 ]
  [ "$output" = "stub mcp --flag a b" ]
}

@test "installed versioned binary runs without download" {
  make_bin "$EPISODIC_MEMORY_DIR/bin/episodic-memory-v$VER"
  stub_curl
  PATH="$STUBS:$PATH" run "$WRAPPER" sync
  [ "$status" -eq 0 ]
  [ "$output" = "stub sync" ]
  [ ! -e "$CURL_LOG" ]
}

@test "unsupported platform: sync exits 0 with message" {
  stub_uname Darwin x86_64
  PATH="$STUBS:$PATH" run "$WRAPPER" sync
  [ "$status" -eq 0 ]
  [[ "$output" == *"unsupported platform Darwin/x86_64"* ]]
}

@test "unsupported platform: mcp exits 1 with message" {
  stub_uname Darwin x86_64
  PATH="$STUBS:$PATH" run "$WRAPPER" mcp
  [ "$status" -eq 1 ]
  [[ "$output" == *"unsupported platform Darwin/x86_64"* ]]
}

@test "downloads, verifies, installs, then execs" {
  stub_uname Linux aarch64
  stub_curl
  make_release aarch64-unknown-linux-gnu
  PATH="$STUBS:$PATH" run "$WRAPPER" mcp
  [ "$status" -eq 0 ]
  [ "$output" = "stub mcp" ]
  [ -x "$EPISODIC_MEMORY_DIR/bin/episodic-memory-v$VER" ]
  grep -q "releases/download/v$VER/episodic-memory-v$VER-aarch64-unknown-linux-gnu.tar.gz" "$CURL_LOG"
  # every download is bounded
  [ "$(grep -c -- '--connect-timeout 10 --max-time 300' "$CURL_ARGS")" -eq 2 ]
  # temp dirs cleaned up
  [ -z "$(ls -A "$EPISODIC_MEMORY_DIR/bin" | grep '^\.install\.[A-Za-z0-9]' || true)" ]
}

@test "sha256 mismatch: nothing installed, mcp exits 1" {
  stub_uname Darwin arm64
  stub_curl
  make_release aarch64-apple-darwin corrupt
  PATH="$STUBS:$PATH" run "$WRAPPER" mcp
  [ "$status" -eq 1 ]
  [[ "$output" == *"sha256 mismatch"* ]]
  [ ! -e "$EPISODIC_MEMORY_DIR/bin/episodic-memory-v$VER" ]
}

@test "download failure: sync exits 0" {
  stub_uname Linux x86_64
  stub_curl
  PATH="$STUBS:$PATH" run "$WRAPPER" sync
  [ "$status" -eq 0 ]
  [[ "$output" == *"download failed"* ]]
}
