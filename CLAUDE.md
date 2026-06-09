# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# memmem

## Purpose

Persistent conversation memory across Claude Code and Codex sessions using archived transcripts.
Memmem syncs local transcripts into an archive, extracts source-linked event/fact memory records, and exposes compact memory search plus archive line reading through CLI and MCP.

## Memory Architecture Principles

- Transcript archive is the source of truth.
- The persisted and searchable unit is `memory_record`, not a turn-level transcript object.
- A `memory_record` is an atomic fact or event extracted from transcript content.
- Every `memory_record` must have provenance: `archive_path`, `line_start`, `line_end`, and `source_kind`.
- Memory is an append-first derived index. Do not silently overwrite old facts; supersede them when needed.
- Store facts/events, not conversation summaries.
- Search retrieves compact memory records first. Raw transcript lines are read only when evidence or additional context is needed.
- Token efficiency is a product requirement: default outputs must be compact, deduplicated, bounded, and source-linked.
- LLM extraction must be bounded, idempotent, schema-validated, and failure-tolerant.

## Commands

```bash
go test ./...                          # Run all tests
go test ./internal/core/search         # Run a single package
go vet ./...                           # Static analysis (type check is part of build)
bash scripts/build-binaries.sh         # Build bin/memmem and bin/memmem-mcp
./bin/memmem <sync|search|read|stats|verify|doctor>   # Run built CLI
```

**CRITICAL**: Builds require CGO and staged native runtime assets. `bash scripts/build-binaries.sh` fetches, stages, and builds in one step: it runs `scripts/fetch-dev-assets.sh` (gh/curl, only when assets are missing), then `scripts/stage-runtime-assets.sh` (copies the ORT lib + tokenizer into the `go:embed` directory), then `go build` with `CGO_ENABLED=1` and `CGO_LDFLAGS="-L$(pwd)/poc/lib"` to statically link `libtokenizers.a`. The ONNX runtime dylib and `tokenizer.json` are embedded via `go:embed`; the embedding model (`model_fp16.onnx`, ~235MB) is downloaded on first run, not embedded.

## Key Files

| File | Description |
| ---- | ----------- |
| `internal/core/db/db.go` | Memory database schema — use `OpenDatabase()` in production, `InitDatabase()` only in tests (`migrations.go`, `records.go` alongside) |
| `internal/core/sources/types.go` | Source adapter and transcript span types |
| `internal/core/sources/claude.go` | Claude Code transcript adapters and JSONL parser |
| `internal/core/sources/codex.go` | Codex transcript adapter and rollout parser |
| `internal/core/sources/sources.go` | Built-in source adapter registry (`BuiltInSourceAdapters()`) |
| `internal/core/indexer/indexer.go` | Archive indexing into memory records and vectors (with `backoff.go`, `dedupe.go`, `prune.go`, `txstore.go`) |
| `internal/core/search/search.go` | Hybrid vector-first + text fallback memory search |
| `internal/core/read/read.go` | Archived transcript line reading/rendering |
| `internal/core/embeddings/embeddings.go` | Xenova/multilingual-e5-small embeddings (384-dim) with passage/query prefix routing (`model.go`, `truncate.go` alongside) |
| `internal/core/ratelimiter/ratelimiter.go` | Token bucket rate limiter (singleton in `singletons.go`, configurable) |
| `internal/llm/config.go` | LLM config loading + `CreateProvider()` factory; supports single-provider and `providers[]` round-robin modes |
| `internal/llm/extractor.go` | Bounded, schema-validated fact/event extraction from transcript spans |
| `internal/llm/{gemini,zai}.go` | Provider implementations behind the `Provider` interface (`internal/llm/types.go`) |
| `internal/llm/roundrobin.go` | Rotates across multiple `(apiKey, model)` entries to spread rate limits |
| `internal/cli/sync.go` | CLI sync command: copy transcripts to archive and index changed files |
| `internal/cli/commands.go` | Search, read, and stats command handlers |
| `internal/cli/verify.go` | CLI verify command |
| `internal/cli/doctor.go` | CLI doctor health-diagnostic command |
| `internal/cli/parse.go` | CLI argument parsing |
| `cmd/memmem/main.go` | CLI router exposing `sync`, `search`, `read`, `stats`, `verify`, and `doctor` |
| `internal/mcp/server.go` | MCP server exposing search and read tools |
| `internal/mcp/handlers.go` | MCP handlers for memory search/read |
| `internal/mcp/schemas.go` | MCP input schemas for search/read |
| `internal/mcp/tools.go` | MCP tool definitions for search/read |
| `cmd/memmem-mcp/main.go` | MCP server entrypoint |
| `internal/core/runtime/runtime.go` | Extracts `go:embed`'d native runtime assets (ORT lib + tokenizer) on first run |
| `hooks/hooks.json` | SessionStart and Stop hook configuration invoking `${CLAUDE_PLUGIN_ROOT}/bin/memmem sync` |
| `scripts/build-binaries.sh` | Fetches + stages native assets, then builds `bin/memmem` and `bin/memmem-mcp` |

## Architecture Overview

### Data Flow

```text
SessionStart/Stop hook → bin/memmem sync (internal/cli/sync.go)
sync              → source adapters discover Claude/Codex JSONL transcripts
sync              → copy changed transcripts into conversation-archive/<source_kind>/<relative path>
indexer           → parse changed archive files into transcript spans
extractor         → extract bounded fact/event memory records with source-linked provenance
indexer           → embed memory records into vec_memory_records
CLI/MCP           → search compact memory records, then read archive line ranges when needed
```

The archive is the source of truth. Memory rows and vector rows are derived indexes and must be rebuildable from archived transcripts.

### Database Schema

Primary tables in `~/.config/memmem/conversation-index/conversations.db`:

- **`memory_records`**: Atomic fact/event memories extracted from archived transcripts, with source metadata and archive line provenance.
- **`vec_memory_records`**: 384-dimensional float embeddings for memory search (`sqlite-vec` virtual table).
- **`extraction_state`**: Per-span extraction status used to avoid repeated LLM calls and control retry/backoff.

`OpenDatabase()` opens/creates and preserves data. `InitDatabase()` wipes and recreates — tests only.

### Search and Read

Search is hybrid:

1. Generate a query embedding.
2. Search `vec_memory_records` joined to active `memory_records` by vector distance.
3. Supplement with text matches on `memory_records.text`.
4. Deduplicate by memory/provenance and return compact, source-linked memory cards up to the requested limit.

Public MCP/CLI filters: `after`, `before`, and `source_kind`.
Internal compatibility options may also support project/file filtering in code paths, but do not document them as primary MCP surface unless the schemas expose them.

Use `read` with `archive_path`, `line_start`, and `line_end` from search results to inspect raw transcript context. Search results should not include raw transcript text by default.

### Source Adapters

Built-in adapters:

- `claude-projects`: Claude Code project transcripts under the Claude config directory.
- `claude-transcripts`: Claude transcript directory when present.
- `codex-sessions`: Codex session JSONL transcripts under `CODEX_HOME`.

Adapters discover roots, detect JSONL files, parse transcript spans for extraction, and preserve source-specific metadata where available.

### LLM Provider Layer

`internal/llm/` is the only LLM-dependent subsystem; it is used by the indexer's extractor to turn transcript spans into memory records. Everything behind the `Provider` interface (`types.go`).

- `LoadConfig()` reads the `llm` section of `~/.config/memmem/config.json`; returns `nil` when unconfigured, which is why sync/read work without any provider.
- `CreateProvider(config)` is the single factory. Two configuration shapes:
  - **Single provider**: `{ provider: 'gemini' | 'zai', apiKey, model }`.
  - **Round-robin**: `{ providers: [{ provider, apiKey, model }, ...] }` → the round-robin provider (`roundrobin.go`) rotates across entries to spread per-key rate limits.
- `extractor.go` enforces the bounded/idempotent/schema-validated/failure-tolerant contract from Memory Architecture Principles; spans that fail extraction are skipped, not retried unbounded (tracked via `extraction_state`).

When adding a provider: implement `Provider`, and wire it into `CreateProvider()` and the provider-type set in `config.go`.

### MCP Surface

MCP exposes only:

- **`search`**: accepts `query` as a single string, or an array of 2-5 strings for multi-query AND search (returns only records matching every query, scored by mean similarity). Returns compact memory records with `kind`, `text`, `archive_path`, `line_start`, `line_end`, `source_kind`, `project`, `timestamp`, and optional `score`.
- **`read`**: renders archived transcript content for an archive path and optional line range.

There is no summary detail or graph layer in the target architecture.

### Build Output

`go build` produces two self-contained binaries in `bin/`:

- `cmd/memmem/main.go` → `bin/memmem` (CLI used by hooks)
- `cmd/memmem-mcp/main.go` → `bin/memmem-mcp` (MCP server)

`bash scripts/build-binaries.sh` builds both locally. Release builds use the goreleaser matrix (`.goreleaser.yaml`) to cross-compile per-platform binaries.

Go links sqlite-vec (via the `ncruces` WASM SQLite driver in tests / sqlite-vec at runtime) and the ONNX runtime via CGO; the ORT lib and `tokenizer.json` are `go:embed`'d and extracted to `~/.config/memmem/runtime/` on first run, and `libtokenizers.a` is statically linked at build time from `poc/lib/`.

## Configuration

`~/.config/memmem/config.json` may configure rate limits:

```json
{
  "ratelimit": {
    "embedding": { "requestsPerSecond": 5, "burstSize": 10 }
  }
}
```

Archive sync and `read` do not require an LLM provider configuration. Memory extraction during indexing does require a configured LLM provider; without one, spans are skipped and no memory rows are created for those spans.

Storage locations:

- Database: `~/.config/memmem/conversation-index/conversations.db`
- Archive: `~/.config/memmem/conversation-archive/`
- Logs: `~/.config/memmem/logs/`

## Testing

- Test files are co-located with source (`*_test.go`) and run with `go test`.
- Integration tests use in-memory SQLite (`:memory:`) where possible.
- Search tests inject a mock `Embedder` (e.g. `constEmbedder`) and insert vectors directly via the `db` package to stay CGO-free and avoid network/model downloads.

## Common Pitfalls

- **Never** call `InitDatabase()` in production code — wipes the database.
- Builds require CGO and staged native assets — a bare `go build` without staged runtime assets and `CGO_LDFLAGS` will fail; use `bash scripts/build-binaries.sh`.
- Modify DB schema requires a migration or rebuild strategy.
- After modifying Go: rebuild with `bash scripts/build-binaries.sh`.

<!-- MANUAL: Project-specific notes below this line are preserved -->
