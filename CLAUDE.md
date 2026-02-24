# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# memmem

## Purpose

Persistent conversation memory across Claude Code sessions using observation-based semantic search.
Automatically indexes conversations and provides progressive disclosure search through structured observations.

## Commands

```bash
bun test                        # Run all tests
bun test path/to/file.test.ts   # Run single test file
bun test --watch                # Watch mode
bun run build                   # Bundle with bun build (scripts/build.mjs)
bun run typecheck               # tsc --noEmit
```

**CRITICAL**: Always use `bun` — this project uses `bun:sqlite` (built-in) and `bun test`.

## Key Files

| File | Description |
| ---- | ----------- |
| `src/core/db.ts` | Database schema — use `openDatabase()` in production, `initDatabase()` only in tests |
| `src/core/observations.ts` | Observation CRUD (generates embeddings on create) |
| `src/core/search.ts` | Hybrid vector-first + keyword-fallback search |
| `src/core/compress.ts` | Rule-based tool data compression (no LLM) |
| `src/core/embeddings.ts` | gte-small (384-dim, fp16) |
| `src/core/ratelimiter.ts` | Token bucket rate limiter (singleton, configurable) |
| `src/core/llm/` | LLM providers (Gemini, ZAI) + batch extraction prompt |
| `src/hooks/session-start.ts` | SessionStart hook implementation |
| `src/hooks/post-tool-use.ts` | PostToolUse hook implementation |
| `src/hooks/stop.ts` | Stop hook + batch LLM extraction |
| `src/cli/inject-cli.ts` | CLI entrypoint for SessionStart hook |
| `src/cli/observe-cli.ts` | CLI entrypoint for PostToolUse + Stop hooks |
| `src/mcp/server.ts` | MCP server exposing search, get_observations, and read tools |
| `hooks/hooks.json` | Hook configuration (SessionStart, PostToolUse, Stop) |
| `vitest.config.ts` | Test config (max 4 threads, 15s timeout) |

## Architecture Overview

### Data Flow

```
PostToolUse hook → compress (rule-based) → pending_events table
Stop hook        → batch LLM extraction → observations + vec_observations tables
SessionStart     → search recent observations → inject into session context
MCP server       → progressive disclosure search (3 layers)
```

### Database Schema

Three tables in `~/.config/memmem/conversation-index/conversations.db`:

- **`pending_events`**: Temporary storage for compressed tool events within a session
- **`observations`**: Long-term extracted insights (`title` ≤50 chars, `content` ≤200 chars in English, optional `content_original` for other languages)
- **`vec_observations`**: 384-dimensional float embeddings (sqlite-vec virtual table)

`openDatabase()` opens/creates (preserves data). `initDatabase()` wipes and recreates — tests only.

### Three-Layer Progressive Disclosure

| Layer | Tool | Output | Token cost |
|-------|------|--------|-----------|
| 1 | `search()` | Compact summaries (id, title, project, timestamp) | ~30/result |
| 2 | `get_observations()` | Full content | ~200-500/result |
| 3 | `read()` | Raw JSONL transcript | ~500-2000 |

### Search: Vector-First, Keyword Fallback

1. Normalize query to English (optional, via LLM)
2. Vector search via sqlite-vec (`embedding MATCH ? AND k = ?`)
3. If results < limit, supplement with keyword search (`LIKE %query%`)
4. Deduplicate and return

Filter options: `after`/`before` (ISO date), `projects` (array), `files` (substring match in content).

### Batch LLM Extraction (Stop hook)

- Collects all `pending_events` for the session
- Skips if fewer than 3 events
- Splits into batches of 15 (default)
- Each batch sent to LLM with previous 3 observations as deduplication context
- Extracts observations as JSON array `[{title, content, content_original?}]`

### Compression Rules (no LLM, PostToolUse)

Skipped tools (return null, not stored): `Glob`, `LSP`, `TodoWrite`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `NotebookEdit`, `Skill`

Compressed format examples:
- `Read /path/file.ts (245 lines)`
- `Edited /path: old → new` (40-char truncation)
- `Ran \`command\` → exit 0` or `exit 1: error...` (100-char truncation)
- `Searched 'pattern' in /path → 5 matches`

### Build Output

esbuild bundles to `dist/`:
- `src/cli/index-cli.ts` → `dist/cli-internal.mjs`
- `src/mcp/server.ts` → `dist/mcp-server.mjs`
- `src/cli-graceful.mjs` → `dist/cli.mjs` (wrapper with graceful shutdown)

External (not bundled): `@huggingface/transformers`, `better-sqlite3`, `sqlite-vec`, `onnxruntime-node`, `sharp`

## Configuration

`~/.config/memmem/config.json`:
```json
{
  "provider": "gemini",
  "apiKey": "your-key",
  "model": "gemini-2.0-flash",
  "ratelimit": {
    "embedding": { "requestsPerSecond": 5, "burstSize": 10 },
    "llm": { "requestsPerSecond": 2, "burstSize": 4 }
  }
}
```

Without config: indexing/search works, but Stop hook summarization is skipped.

Storage locations:
- Database: `~/.config/memmem/conversation-index/conversations.db`
- Archive: `~/.config/memmem/conversation-archive/`
- Logs: `~/.config/memmem/logs/`

## Testing

- Test files are co-located with source (`**/*.test.ts`)
- `tests/` directory contains CLI integration tests and BATS shell tests
- Integration tests use in-memory SQLite (`:memory:`)
- Mock LLM providers to avoid API calls; real embeddings are generated in tests

## Common Pitfalls

- **Never** call `initDatabase()` in production code — wipes the database
- **Never** use MCP tools directly in agents — use the `search-conversation` skill (saves 50-100x context)
- Modify DB schema requires a migration strategy
- After modifying TypeScript: rebuild with `npm run build`

<!-- MANUAL: Project-specific notes below this line are preserved -->
