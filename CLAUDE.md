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
bun test                        # Run all tests
bun test path/to/file.test.ts   # Run single test file
bun test --watch                # Watch mode
bun run build                   # Bundle with Bun.build (scripts/build.mjs)
bun run typecheck               # tsc --noEmit
```

**CRITICAL**: Always use `bun` — this project uses `bun:sqlite` (built-in) and `bun test`.

## Key Files

| File | Description |
| ---- | ----------- |
| `src/core/db.ts` | Memory database schema — use `openDatabase()` in production, `initDatabase()` only in tests |
| `src/core/sources/types.ts` | Source adapter and transcript span types |
| `src/core/sources/claude.ts` | Claude Code transcript adapters and JSONL parser |
| `src/core/sources/codex.ts` | Codex transcript adapter and rollout parser |
| `src/core/sources/index.ts` | Built-in source adapter exports |
| `src/core/indexer.ts` | Archive indexing into memory records and vectors |
| `src/core/search.ts` | Hybrid vector-first + text fallback memory search |
| `src/core/read.ts` | Archived transcript line reading/rendering |
| `src/core/embeddings.ts` | Xenova/multilingual-e5-small embeddings (384-dim) with passage/query prefix routing |
| `src/core/ratelimiter.ts` | Token bucket rate limiter (singleton, configurable) |
| `src/cli/sync.ts` | CLI sync command: copy transcripts to archive and index changed files |
| `src/cli/search.ts` | CLI search command |
| `src/cli/read.ts` | CLI read command |
| `src/cli/stats.ts` | CLI stats command |
| `src/cli/verify.ts` | CLI verify command |
| `src/cli/main.ts` | CLI router exposing `sync`, `search`, `read`, `stats`, and `verify` |
| `src/cli-graceful.mjs` | Bun CLI wrapper copied to `dist/cli.mjs` |
| `src/mcp/server.ts` | MCP server exposing search and read tools |
| `src/mcp/handlers.ts` | MCP handlers for memory search/read |
| `src/mcp/schemas.ts` | MCP input schemas for search/read |
| `src/mcp/tools.ts` | MCP tool definitions for search/read |
| `hooks/hooks.json` | SessionStart hook configuration for `memmem sync` |
| `scripts/mcp-server-wrapper.mjs` | Bun MCP wrapper that ensures dependencies/build before launching server |
| `scripts/build.mjs` | Bun.build bundling script |

## Architecture Overview

### Data Flow

```text
SessionStart hook → hooks/run.sh sync → src/cli/sync.ts
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

`openDatabase()` opens/creates and preserves data. `initDatabase()` wipes and recreates — tests only.

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

### MCP Surface

MCP exposes only:

- **`search`**: returns compact memory records with `kind`, `text`, `archive_path`, `line_start`, `line_end`, `source_kind`, `project`, `timestamp`, and optional `score`.
- **`read`**: renders archived transcript content for an archive path and optional line range.

There is no summary detail, observation detail, or graph layer in the target architecture.

### Build Output

Bun.build outputs/copies to `dist/`:

- `src/cli/main.ts` → `dist/cli-internal.mjs`
- `src/cli-graceful.mjs` → `dist/cli.mjs` (Bun wrapper)
- `src/mcp/server.ts` → `dist/mcp-server.mjs`
- `scripts/mcp-server-wrapper.mjs` → `dist/mcp-wrapper.mjs`
- `scripts/lib/check-dependencies.mjs` → `dist/lib/check-dependencies.mjs`

External (not bundled): `@huggingface/transformers`, `bun:sqlite`, `sqlite-vec`, `onnxruntime-node`, `sharp`.

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

- Test files are co-located with source (`**/*.test.ts`) and use `bun test`.
- Integration tests use in-memory SQLite (`:memory:`) where possible.
- Mock embeddings with `__setModelForTests()` to avoid network/model downloads in targeted tests.

## Common Pitfalls

- **Never** call `initDatabase()` in production code — wipes the database.
- **Never** run runtime entrypoints with Node — CLI and MCP bundles import `bun:sqlite` and must run with Bun.
- Modify DB schema requires a migration or rebuild strategy.
- After modifying TypeScript or runtime wrappers: rebuild with `bun run build`.

<!-- MANUAL: Project-specific notes below this line are preserved -->
