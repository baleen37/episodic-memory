# Phase 6 — Manual Verification (deferred, external-dependency checks)

The automatable Phase 6 verification (Go regression, index/search/read
cross-implementation equivalence, CLI smoke, MCP stdio smoke) is covered by
`scripts/phase6/` and reported in the Phase 6 gate. This document lists the
three checks that require external dependencies a CI/agent cannot provision
(an LLM API key, a real Claude Code instance, a clean machine). Run these
manually to close the remaining equivalence gaps.

All commands assume repo root and the local model assets in `.cache/`. On
darwin/arm64, CGO builds need the tokenizer static lib:

```bash
export CGO_LDFLAGS="-L$(pwd)/poc/lib"
go build -o /tmp/memmem-go ./cmd/memmem
go build -o /tmp/memmem-mcp-go ./cmd/memmem-mcp
```

Local-model env (skips the 235MB model download in the Go binary):

```bash
export MEMMEM_MODEL_PATH="$(pwd)/.cache/Xenova/multilingual-e5-small/onnx/model_fp16.onnx"
export MEMMEM_TOKENIZER_PATH="$(pwd)/.cache/Xenova/multilingual-e5-small/tokenizer.json"
export MEMMEM_ORT_LIB_PATH="/opt/homebrew/opt/onnxruntime/lib/libonnxruntime.dylib"
```

---

## 1. Full extraction equivalence (needs an LLM provider key)

The automated equivalence proof inserts memory records directly (no LLM), so it
does NOT exercise `llm/extractor.go` vs `src/core/llm/extractor.ts`. To prove the
extraction path is equivalent, sync the SAME transcripts with both
implementations *with a provider configured* and diff the resulting
`memory_records`.

Configure a provider (gemini or zai) in a temp config dir:

```bash
export RUN=/tmp/p6-extract
mkdir -p "$RUN/cfg-ts" "$RUN/cfg-go"
cat > "$RUN/cfg-ts/config.json" <<'JSON'
{ "provider": "gemini", "apiKey": "YOUR_KEY", "model": "gemini-2.0-flash" }
JSON
cp "$RUN/cfg-ts/config.json" "$RUN/cfg-go/config.json"
```

Pick a SMALL, fixed transcript set so extraction is deterministic-ish and cheap.
Point both impls at the same source roots but separate config/db so they index
independently:

```bash
# Use a tiny fixed codex transcript dir to bound cost; empty out Claude roots.
export CODEX_HOME="$RUN/codex"            # contains sessions/.../rollout-*.jsonl
export CLAUDE_CONFIG_DIR="$RUN/claude-empty"
mkdir -p "$CLAUDE_CONFIG_DIR"

# TS sync
CONVERSATION_MEMORY_CONFIG_DIR="$RUN/cfg-ts" \
CONVERSATION_MEMORY_DB_PATH="$RUN/ts.db" \
  bun run src/cli/main.ts sync

# Go sync (same provider, same transcripts)
CONVERSATION_MEMORY_CONFIG_DIR="$RUN/cfg-go" \
CONVERSATION_MEMORY_DB_PATH="$RUN/go.db" \
  /tmp/memmem-go sync
```

Diff the extracted records (kind/text/provenance). LLM output is not
bit-reproducible across runs, so compare the *structure and provenance*
(archive_path, line_start, line_end, source_kind, kind) and spot-check text
similarity rather than requiring identical strings:

```bash
sqlite3 "$RUN/ts.db" \
  "SELECT kind, source_kind, archive_path, line_start, line_end FROM memory_records ORDER BY archive_path, line_start" > "$RUN/ts.rows"
sqlite3 "$RUN/go.db" \
  "SELECT kind, source_kind, archive_path, line_start, line_end FROM memory_records ORDER BY archive_path, line_start" > "$RUN/go.rows"
diff "$RUN/ts.rows" "$RUN/go.rows"   # provenance set should match closely
```

Pass criteria: both impls extract over the same spans (same archive line ranges
attempted), produce comparable record counts/kinds, and `extraction_state` shows
the same spans marked done/empty/errored. Exact text need not be identical
(LLM nondeterminism), but the prompts, span bounds, dedupe keys, and
schema-validation behavior must match.

---

## 2. MCP-in-Claude-Code (needs a real Claude Code instance)

The automated test drives the Go MCP binary with a one-shot JSON-RPC sequence
over stdio. To prove it works as a real MCP server inside Claude Code, register
the Go binary and call `search` / `fetch` from a live session.

`.mcp.json` pointing at the Go binary:

```json
{
  "mcpServers": {
    "memmem-go": {
      "command": "/tmp/memmem-mcp-go",
      "env": {
        "CONVERSATION_MEMORY_DB_PATH": "/abs/path/to/conversations.db",
        "MEMMEM_MODEL_PATH": "/abs/path/.cache/Xenova/multilingual-e5-small/onnx/model_fp16.onnx",
        "MEMMEM_TOKENIZER_PATH": "/abs/path/.cache/Xenova/multilingual-e5-small/tokenizer.json",
        "MEMMEM_ORT_LIB_PATH": "/opt/homebrew/opt/onnxruntime/lib/libonnxruntime.dylib"
      }
    }
  }
}
```

In Claude Code:
- Confirm the `memmem-go` server connects and lists exactly two tools:
  `search` and `fetch`.
- Call `search` with a single query and with a 2–5 element array (multi-query
  AND); confirm compact memory cards come back.
- Take a returned record `id`, call `fetch` with it, and confirm the raw
  transcript renders.

Pass criteria: identical tool surface and behavior to the existing TS MCP
server (`memmem` v3.0.0), against a real index.

---

## 3. Clean-room deploy (needs a machine with NO bun/node)

Prove the shipped Go binary is self-contained: it provisions its own runtime
(onnxruntime dylib + tokenizer via go:embed, model download on first run) with
no bun/node and no repo checkout.

```bash
# On a clean machine / container with neither bun nor node installed:
# 1. Download the release artifact for the platform.
curl -L -o memmem.tar.gz \
  https://github.com/baleen37/memmem/releases/download/vX.Y.Z/memmem_<os>_<arch>.tar.gz
tar xzf memmem.tar.gz
./memmem --help

# 2. First run downloads the ~235MB model into the runtime cache, then indexes.
#    (No MEMMEM_MODEL_PATH override here — exercise the download-on-first-run path.)
./memmem sync

# 3. Search and read.
./memmem search "source of truth" --limit 5
./memmem stats
./memmem doctor
```

Pass criteria: `sync` provisions the runtime and model with no external
toolchain, `search`/`stats`/`doctor` succeed, and the produced
`conversations.db` is readable by the TS implementation (and vice versa) — i.e.
the index-equivalence proven offline holds end-to-end on a clean deploy.
