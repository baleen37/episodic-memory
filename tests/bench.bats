#!/usr/bin/env bats
# Benchmark script smoke test: tiny sizes against the release binary. Skips if it is not built.

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  BIN="${CARGO_TARGET_DIR:-$ROOT/target}/release/episodic-memory"
  [ -x "$BIN" ] || skip "release binary not built: $BIN"
}

@test "bench prints every timing and finds the synthetic data" {
  run "$ROOT/scripts/bench.sh" --bin "$BIN" --sessions 3 --big-mb 1 --repeat 2
  [ "$status" -eq 0 ]
  for key in first_sync embed_drain noop_sync incremental_sync_claude incremental_sync_codex incremental_sync_codex_um search_single search_array; do
    echo "$output" | grep -Eq "^$key +[0-9]+\.[0-9]{3}s" || { echo "missing $key"; false; }
  done
}

@test "bench leaves no daemon or temp dir behind" {
  run "$ROOT/scripts/bench.sh" --bin "$BIN" --sessions 2 --big-mb 1 --repeat 1
  [ "$status" -eq 0 ]
  dir="$(echo "$output" | sed -n 's/^data_dir *//p')"
  [ -n "$dir" ]
  [ ! -e "$dir" ]
}

@test "bench searches do not run lsof (MCP host has a Claude session file)" {
  stub="$BATS_TEST_TMPDIR/stub"
  mkdir -p "$stub"
  printf '#!/bin/sh\necho called >>"%s"\n' "$BATS_TEST_TMPDIR/lsof-calls" >"$stub/lsof"
  chmod +x "$stub/lsof"
  PATH="$stub:$PATH" run "$ROOT/scripts/bench.sh" --bin "$BIN" --sessions 2 --big-mb 1 --repeat 2
  [ "$status" -eq 0 ]
  [ ! -e "$BATS_TEST_TMPDIR/lsof-calls" ]
}
