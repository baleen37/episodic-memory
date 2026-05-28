# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# memmem

## Purpose

Persistent conversation memory across Claude Code and Codex sessions using archived transcript exchange search.
Memmem syncs local transcripts into an archive, indexes user/assistant exchanges with embeddings, and exposes search/read through CLI and MCP.

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
| `src/core/db.ts` | Exchange database schema — use `openDatabase()` in production, `initDatabase()` only in tests |
| `src/core/sources/types.ts` | Source adapter and parsed exchange types |
| `src/core/sources/claude.ts` | Claude Code transcript adapters and JSONL parser |
| `src/core/sources/codex.ts` | Codex transcript adapter and rollout parser |
| `src/core/sources/index.ts` | Built-in source adapter exports |
| `src/core/indexer.ts` | Full-file archive reindexing into exchanges, tool calls, and vectors |
| `src/core/search.ts` | Hybrid vector-first + text fallback exchange search |
| `src/core/read.ts` | Archived transcript line reading/rendering |
| `src/core/embeddings.ts` | gte-small embeddings (384-dim, fp16) |
| `src/core/ratelimiter.ts` | Token bucket rate limiter (singleton, configurable) |
| `src/cli/sync.ts` | CLI sync command: copy transcripts to archive and index changed files |
| `src/cli/search.ts` | CLI search command |
| `src/cli/read.ts` | CLI read command |
| `src/cli/main.ts` | CLI router exposing only `sync`, `search`, and `read` |
| `src/cli-graceful.mjs` | Bun CLI wrapper copied to `dist/cli.mjs` |
| `src/mcp/server.ts` | MCP server exposing search and read tools |
| `src/mcp/handlers.ts` | MCP handlers for transcript search/read |
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
indexer           → reindex changed archive files into exchanges + tool_calls + vec_exchanges
CLI/MCP           → search transcript exchanges, then read archive line ranges when needed
```

The archive is the source of truth. Index rows for an archive file are deleted and rebuilt whenever that file is reindexed.

### Database Schema

Primary tables in `~/.config/memmem/conversation-index/conversations.db`:

- **`exchanges`**: Indexed user/assistant transcript exchanges with source metadata, archive path, line range, text, and embedding version.
- **`tool_calls`**: Tool calls associated with an exchange; rows cascade when their exchange is deleted.
- **`vec_exchanges`**: 384-dimensional float embeddings for exchange search (`sqlite-vec` virtual table).

`openDatabase()` opens/creates and preserves data. `initDatabase()` wipes and recreates — tests only.

### Search and Read

Search is hybrid:

1. Generate a query embedding.
2. Search `vec_exchanges` joined to `exchanges` by vector distance.
3. Supplement with text matches on `user_text` and `assistant_text`.
4. Deduplicate and return up to the requested limit.

Public MCP/CLI filters: `after`, `before`, and `source_kind`.
Internal compatibility options may also support project/file filtering in code paths, but do not document them as primary MCP surface unless the schemas expose them.

Use `read` with `archive_path`, `line_start`, and `line_end` from search results to inspect raw transcript context.

### Source Adapters

Built-in adapters:

- `claude-projects`: Claude Code project transcripts under the Claude config directory.
- `claude-transcripts`: Claude transcript directory when present.
- `codex-sessions`: Codex session JSONL transcripts under `CODEX_HOME`.

Adapters discover roots, detect JSONL files, parse normalized exchanges, and preserve source-specific metadata where available.

### MCP Surface

MCP exposes only:

- **`search`**: returns exchange summaries with `archive_path`, `line_start`, `line_end`, `source_kind`, `project`, `timestamp`, `snippet`, and optional score.
- **`read`**: renders archived transcript content for an archive path and optional line range.

There is no observation detail/get layer in the current architecture.

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

Transcript indexing/search does not require an LLM provider configuration.

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
- Modify DB schema requires a migration strategy.
- After modifying TypeScript or runtime wrappers: rebuild with `bun run build`.

<!-- MANUAL: Project-specific notes below this line are preserved -->
