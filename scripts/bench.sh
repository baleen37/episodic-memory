#!/usr/bin/env bash
# Usage: scripts/bench.sh [--bin PATH] [--sessions N] [--big-mb N] [--repeat N]
# Benchmarks the real binary on synthetic transcripts in a temp dir (no network, no real data):
# first sync, a sync with nothing new, incremental sync after appending to one large Claude Code and one large Codex
# archive, and to a large Codex archive without `item_completed` events (its user signal comes from `user_message`
# events; added after the first sync so first_sync stays comparable), and single/array search through the MCP stdio
# tool. Uses the hidden test flags `--fake-embedder` (no model download) and `sync --wait` (returns when the sync job
# has indexed; embedding continues in the daemon's worker, measured separately as embed_drain).
# Baseline numbers: scripts/bench-baseline.txt.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/release/episodic-memory"
SESSIONS=300 # small sessions per provider, 20 exchanges each
BIG_MB=100   # size of the one large session per provider
REPEAT=5     # runs per incremental-sync and search measurement

while [ $# -gt 0 ]; do
  case "$1" in
    --bin) BIN="$2"; shift 2 ;;
    --sessions) SESSIONS="$2"; shift 2 ;;
    --big-mb) BIG_MB="$2"; shift 2 ;;
    --repeat) REPEAT="$2"; shift 2 ;;
    *) echo "usage: bench.sh [--bin PATH] [--sessions N] [--big-mb N] [--repeat N]" >&2; exit 2 ;;
  esac
done
[ -x "$BIN" ] || { echo "bench: binary not found: $BIN (cargo build --release)" >&2; exit 1; }

# Short path: the daemon socket lives in the data dir and unix socket paths are length-limited.
T="$(mktemp -d /tmp/em-bench.XXXXXX)"
CLAUDE="$T/c"
CODEX="$T/x"
DATA="$T/d"
FLAGS=(--fake-embedder --idle-secs 600)
mkdir -p "$CLAUDE/projects" "$CODEX/sessions/2026/01/02" "$DATA"

cleanup() {
  exec 3>&- 4<&- 2>/dev/null || true
  local pid
  for lock in "$DATA"/daemon-*.lock; do
    [ -f "$lock" ] || continue
    pid="$(tr -d '[:space:]' <"$lock")"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  rm -rf "$T"
}
trap cleanup EXIT

em() {
  EPISODIC_MEMORY_DIR="$DATA" CLAUDE_CONFIG_DIR="$CLAUDE" CODEX_HOME="$CODEX" \
    EPISODIC_MEMORY_DISABLE='' "$BIN" "$@"
}

# Seconds since epoch with microseconds; perl when bash lacks EPOCHREALTIME (bash < 5).
now() {
  if [ -n "${EPOCHREALTIME:-}" ]; then echo "$EPOCHREALTIME"; else perl -MTime::HiRes=time -e 'printf "%.6f\n", time'; fi
}
elapsed() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.3f", b - a }'; }

# Prints `name  median s (min .. max over N)` for a list of second values.
report() { # name values...
  local name="$1"; shift
  printf '%s\n' "$@" | sort -n | awk -v name="$name" '
    { v[NR] = $1 }
    END {
      med = (NR % 2) ? v[(NR + 1) / 2] : (v[NR / 2] + v[NR / 2 + 1]) / 2
      printf "%-24s %.3fs  (median of %d; min %.3f max %.3f)\n", name, med, NR, v[1], v[NR]
    }'
}

# Writes synthetic exchanges to stdout. kind: claude|codex|codex_um (Codex with `user_message` events instead of
# `item_completed`). Stops after `n` exchanges, or once
# `bytes` bytes are written when bytes > 0. `head` = 1 writes the Codex session_meta line.
gen() { # kind sid n bytes seed head
  awk -v kind="$1" -v sid="$2" -v n="$3" -v bytes="$4" -v seed="$5" -v head="$6" '
    # topic(k): k words from the topic list. filler(k): k words from a skewed 5,000-word vocabulary.
    function topic(k,   s, j) {
      s = W[int(rand() * NW) + 1]
      for (j = 1; j < k; j++) s = s " " W[int(rand() * NW) + 1]
      return s
    }
    function filler(k,   s, j) {
      s = "w" int(rand() ^ 3 * 5000)
      for (j = 1; j < k; j++) s = s " w" int(rand() ^ 3 * 5000)
      return s
    }
    function out(line) { print line; written += length(line) + 1 }
    BEGIN {
      NW = split("database index rollback deploy migration schema query cache latency " \
        "worker thread socket daemon archive parser token vector search embedding batch " \
        "commit branch merge release binary config logging timeout retry backoff queue " \
        "transaction lock mutex channel buffer stream offset generation session project " \
        "benchmark profile memory allocation compile lint format test fixture harness " \
        "kubernetes ingress gateway service endpoint payload header cookie session-id", W, " ")
      srand(seed)
      ts = "2026-01-02T03:04:05.000Z"
      cwd = "/work/proj-" (seed % 7)
      if (kind != "claude" && head)
        out("{\"timestamp\":\"" ts "\",\"type\":\"session_meta\",\"payload\":{\"id\":\"" sid "\",\"cwd\":\"" cwd "\",\"source\":\"cli\"}}")
      for (i = 1; (bytes > 0) ? written < bytes : i <= n; i++) {
        # Every 50th exchange carries the phrase the search measurements look for.
        q = (i % 50 == 1) ? "How do I rollback the database migration safely?" : "How do I " topic(3) " " filler(6) "?"
        a = topic(2) " " filler(50)
        tool = filler(300)
        if (kind == "claude") {
          out("{\"type\":\"user\",\"sessionId\":\"" sid "\",\"cwd\":\"" cwd "\",\"timestamp\":\"" ts "\",\"message\":{\"role\":\"user\",\"content\":\"" q "\"}}")
          out("{\"type\":\"assistant\",\"sessionId\":\"" sid "\",\"timestamp\":\"" ts "\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Checking.\"},{\"type\":\"tool_use\",\"id\":\"t" i "\",\"name\":\"Bash\",\"input\":{\"command\":\"grep -r " W[i % NW + 1] "\"}}]}}")
          out("{\"type\":\"user\",\"sessionId\":\"" sid "\",\"timestamp\":\"" ts "\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t" i "\",\"content\":\"" tool "\"}]}}")
          out("{\"type\":\"assistant\",\"sessionId\":\"" sid "\",\"timestamp\":\"" ts "\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"" a "\"}]}}")
        } else {
          if (kind == "codex_um")
            out("{\"timestamp\":\"" ts "\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"" q "\"}}")
          else
            out("{\"timestamp\":\"" ts "\",\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"UserMessage\",\"id\":\"u" i "\",\"content\":[{\"type\":\"text\",\"text\":\"" q "\",\"text_elements\":[]}]}}}")
          out("{\"timestamp\":\"" ts "\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"" q "\"}]}}")
          out("{\"timestamp\":\"" ts "\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"call_id\":\"c" i "\",\"name\":\"exec\",\"input\":\"grep -r " W[i % NW + 1] "\"}}")
          out("{\"timestamp\":\"" ts "\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\",\"call_id\":\"c" i "\",\"output\":\"" tool "\"}}")
          out("{\"timestamp\":\"" ts "\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"" a "\"}]}}")
        }
      }
    }'
}

claude_file() { echo "$CLAUDE/projects/-work-proj-$(($1 % 7))/claude-$1.jsonl"; }
codex_file() { echo "$CODEX/sessions/2026/01/02/rollout-2026-01-02T03-04-05-codex-$1.jsonl"; }

timed_sync() {
  local t0 t1
  t0="$(now)"
  em sync --wait "${FLAGS[@]}"
  t1="$(now)"
  elapsed "$t0" "$t1"
}

# Start the daemon on empty sources so its startup is not part of the first-sync number.
em sync --wait "${FLAGS[@]}"

echo "generating: $SESSIONS sessions x 20 exchanges per provider, one ${BIG_MB} MB session per provider" >&2
for i in $(seq 1 "$SESSIONS"); do
  mkdir -p "$(dirname "$(claude_file "$i")")"
  gen claude "claude-$i" 20 0 "$i" 1 >"$(claude_file "$i")"
  gen codex "codex-$i" 20 0 "$i" 1 >"$(codex_file "$i")"
done
BIG_CLAUDE="$(claude_file 0)"
BIG_CODEX="$(codex_file 0)"
mkdir -p "$(dirname "$BIG_CLAUDE")"
gen claude claude-0 0 $((BIG_MB * 1048576)) 1001 1 >"$BIG_CLAUDE"
gen codex codex-0 0 $((BIG_MB * 1048576)) 1002 1 >"$BIG_CODEX"

echo "binary         $BIN"
echo "data_dir       $T"
echo "source_bytes   $(cat "$CLAUDE"/projects/*/*.jsonl "$CODEX"/sessions/2026/01/02/*.jsonl | wc -c | tr -d ' ')"

report first_sync "$(timed_sync)"

# Embedding runs in a daemon worker after sync returns; wait for the backlog so it does not
# overlap the measurements below. Reports the time from first_sync's return until drained.
t0="$(now)"
until em doctor 2>/dev/null | grep -q '^\[ok\] embeddings: none pending'; do sleep 0.1; done
t1="$(now)"
report embed_drain "$(elapsed "$t0" "$t1")"

runs=()
for r in $(seq 1 "$REPEAT"); do runs+=("$(timed_sync)"); done
report noop_sync "${runs[@]}"

# The large Codex session without `item_completed`, indexed by an untimed sync before its appends are timed.
BIG_CODEX_UM="$CODEX/sessions/2026/01/02/rollout-2026-01-02T03-04-05-codex-um.jsonl"
gen codex_um codex-um 0 $((BIG_MB * 1048576)) 1003 1 >"$BIG_CODEX_UM"
em sync --wait "${FLAGS[@]}"

for kind in claude codex codex_um; do
  case "$kind" in
    claude) big="$BIG_CLAUDE" ;;
    codex) big="$BIG_CODEX" ;;
    codex_um) big="$BIG_CODEX_UM" ;;
  esac
  runs=()
  for r in $(seq 1 "$REPEAT"); do
    gen "$kind" "$kind-0" 1 0 $((2000 + r)) 0 >>"$big"
    runs+=("$(timed_sync)")
  done
  report "incremental_sync_$kind" "${runs[@]}"
done

# MCP over stdio: one client process, one request per line, timed until its response line.
# The MCP host is this shell ($$, the parent of the exec'd `mcp`). Give it a Claude session file like a real
# Claude Code host, so search finds the host session there instead of running lsof per search (Codex path).
mkdir -p "$CLAUDE/sessions"
printf '{"pid":%d,"sessionId":"bench-host"}\n' "$$" >"$CLAUDE/sessions/$$.json"
mkfifo "$T/in" "$T/out"
(exec env EPISODIC_MEMORY_DIR="$DATA" CLAUDE_CONFIG_DIR="$CLAUDE" CODEX_HOME="$CODEX" EPISODIC_MEMORY_DISABLE='' \
  "$BIN" mcp "${FLAGS[@]}") <"$T/in" >"$T/out" &
exec 3>"$T/in" 4<"$T/out"
ID=0
rpc() { # method params -> response line in $REPLY
  ID=$((ID + 1))
  printf '{"jsonrpc":"2.0","id":%d,"method":"%s","params":%s}\n' "$ID" "$1" "$2" >&3
  while IFS= read -r REPLY <&4; do
    case "$REPLY" in *"\"id\":$ID,"* | *"\"id\":$ID}"*) return 0 ;; esac
  done
  echo "bench: mcp closed before answering request $ID" >&2
  exit 1
}
rpc initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"bench","version":"0"}}'

search_bench() { # name query-json
  local name="$1" query="$2" t0 t1 runs=()
  for r in $(seq 1 "$REPEAT"); do
    t0="$(now)"
    rpc tools/call "{\"name\":\"search\",\"arguments\":{\"query\":$query}}"
    t1="$(now)"
    case "$REPLY" in
      *'"isError":true'* | *'No results.'*) echo "bench: $name returned no results: $REPLY" >&2; exit 1 ;;
    esac
    runs+=("$(elapsed "$t0" "$t1")")
  done
  report "$name" "${runs[@]}"
  case "$REPLY" in *'keyword results only'*) echo "  ($name ran keyword-only)" ;; esac
}
search_bench search_single '"rollback the database migration"'
search_bench search_array '["database","rollback","migration"]'
