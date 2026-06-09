#!/usr/bin/env bash
# Phase 6 index-equivalence runner.
# Builds two DBs (one populated by TS, one by Go) using the SAME corpus, then
# runs BOTH search binaries against BOTH DBs with the same query set, and diffs.
# The KEY property: cross-implementation read produces identical search output.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

OUT="${OUT:-/tmp/p6}"
mkdir -p "$OUT"
TS_DB="$OUT/ts.db"
GO_DB="$OUT/go.db"
rm -f "$TS_DB" "$TS_DB"-wal "$TS_DB"-shm "$GO_DB" "$GO_DB"-wal "$GO_DB"-shm

GO_BIN="${GO_BIN:-/tmp/memmem-go}"

# Local model env (offline). Both impls honor these.
MODEL_DIR="$ROOT/.cache/Xenova/multilingual-e5-small"
export MEMMEM_MODEL_PATH="$MODEL_DIR/onnx/model_fp16.onnx"
export MEMMEM_TOKENIZER_PATH="$MODEL_DIR/tokenizer.json"
export MEMMEM_ORT_LIB_PATH="/opt/homebrew/opt/onnxruntime/lib/libonnxruntime.dylib"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1

echo "== Build TS DB ($TS_DB) =="
CONVERSATION_MEMORY_DB_PATH="$TS_DB" bun run scripts/phase6/ts_insert.ts >/dev/null

echo "== Build Go DB ($GO_DB) =="
CONVERSATION_MEMORY_DB_PATH="$GO_DB" \
  CGO_LDFLAGS="-L$ROOT/poc/lib" go run ./scripts/phase6/goinsert >/dev/null

# Query set: single, multi-word, and filtered. (Multi-query AND is not a CLI
# surface — it is MCP-only — so it is exercised separately in mcp_equiv below.)
run_query() {  # $1=label $2=db $3=bin ... rest=args
  local label="$1"; local dbp="$2"; local bin="$3"; shift 3
  if [ "$bin" = "ts" ]; then
    CONVERSATION_MEMORY_DB_PATH="$dbp" bun run src/cli/main.ts search "$@" 2>/dev/null
  else
    CONVERSATION_MEMORY_DB_PATH="$dbp" "$GO_BIN" search "$@" 2>/dev/null
  fi
}

QUERIES=(
  "Q1|source of truth"
  "Q2|embedding model dimensions"
  "Q3|how does search work"
  "Q4|--after|2025-01-01|vectors"
  "Q5|--before|2025-01-01|vectors"
  "Q6|--source-kind|codex-sessions|hybrid search"
  "Q7|--source-kind|claude-projects|--limit|2|memory"
  "Q8|completely unrelated zebra astronomy"
)

PASS=0; FAIL=0
for spec in "${QUERIES[@]}"; do
  IFS='|' read -r label rest <<<"$spec"
  IFS='|' read -r -a qargs <<<"$rest"

  ts_on_ts=$(run_query "$label" "$TS_DB" ts "${qargs[@]}")
  go_on_ts=$(run_query "$label" "$TS_DB" go "${qargs[@]}")
  ts_on_go=$(run_query "$label" "$GO_DB" ts "${qargs[@]}")
  go_on_go=$(run_query "$label" "$GO_DB" go "${qargs[@]}")

  # The four outputs must all be identical: same DB content, same query, same
  # ranking and scores regardless of which impl built the DB or ran the search.
  ok=1
  if [ "$ts_on_ts" != "$go_on_ts" ]; then ok=0; echo "DIVERGE $label: TS-search vs Go-search on TS-built DB"; fi
  if [ "$ts_on_go" != "$go_on_go" ]; then ok=0; echo "DIVERGE $label: TS-search vs Go-search on Go-built DB"; fi
  if [ "$ts_on_ts" != "$ts_on_go" ]; then ok=0; echo "DIVERGE $label: TS-search differs across TS-built vs Go-built DB"; fi
  if [ "$ts_on_ts" != "$go_on_go" ]; then ok=0; echo "DIVERGE $label: TS-on-TS vs Go-on-Go"; fi

  if [ "$ok" = 1 ]; then
    n=$(printf '%s' "$ts_on_ts" | grep -c '^## \[' || true)
    echo "OK   $label  (${n} results, all 4 impl×db outputs identical)"
    PASS=$((PASS+1))
  else
    echo "---- $label ts_on_ts ----"; printf '%s\n' "$ts_on_ts"
    echo "---- $label go_on_ts ----"; printf '%s\n' "$go_on_ts"
    echo "---- $label ts_on_go ----"; printf '%s\n' "$ts_on_go"
    echo "---- $label go_on_go ----"; printf '%s\n' "$go_on_go"
    FAIL=$((FAIL+1))
  fi
done

echo
echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
