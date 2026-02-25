# memmem Refactoring Design

Date: 2026-02-25

## Goals

1. Reduce complexity — eliminate redundant layers
2. Clean up terminology — names should reflect domain concepts, not implementation details
3. Unify duplicated types and patterns

## Directory Structure

### Before

```
src/
  cli/     # CLI entry points
  core/    # Business logic
  hooks/   # Hook handlers (thin wrappers called only by CLI)
  mcp/     # MCP server
```

### After

```
src/
  cli/     # CLI entry points + hook logic (hooks/ absorbed here)
  core/    # Business logic
  mcp/     # MCP server
```

Remove `hooks/` directory. Each hook handler (`session-start.ts`,
`post-tool-use.ts`, `stop.ts`) is only called from one CLI file, so
merge directly.

## File Changes

### Deleted (absorbed into new files)

| Deleted | Absorbed into |
|---|---|
| `hooks/session-start.ts` | `cli/recall.ts` |
| `hooks/post-tool-use.ts` | `cli/record.ts` |
| `hooks/stop.ts` | `cli/extract.ts` |
| `core/observations.ts` | `core/db.ts` |

### Renamed / Restructured

| Before | After | Reason |
|---|---|---|
| `cli/index-cli.ts` | `cli/main.ts` | Remove redundant `-cli` suffix |
| `cli/inject-cli.ts` | `cli/recall.ts` | Describes user-facing action |
| `cli/observe-cli.ts` | `cli/record.ts` + `cli/extract.ts` | Split responsibilities |
| `core/compress.ts` | `core/summarize.ts` | Not binary compression |
| `core/llm/batch-extract-prompt.ts` | `core/llm/extractor.ts` | Too implementation-specific |

### New Files

| File | Extracted from |
|---|---|
| `mcp/normalizer.ts` | `mcp/handlers.ts` (query normalizer cache) |

### Test Files (parallel renaming)

| Before | After |
|---|---|
| `hooks/session-start.test.ts` | `cli/recall.test.ts` |
| `hooks/post-tool-use.test.ts` | `cli/record.test.ts` |
| `hooks/stop.test.ts` | `cli/extract.test.ts` |
| `cli/inject-cli.test.ts` | merged into `cli/recall.test.ts` |
| `cli/observe-cli.test.ts` | split into `cli/record.test.ts` + `cli/extract.test.ts` |
| `cli/observe-cli.integration.test.ts` | `cli/record.integration.test.ts` |
| `cli/index-cli.test.ts` | `cli/main.test.ts` |
| `core/compress.test.ts` | `core/summarize.test.ts` |
| `core/llm/batch-extract-prompt.test.ts` | `core/llm/extractor.test.ts` |
| `mcp/query-normalizer.test.ts` | `mcp/normalizer.test.ts` |

## Type Renames

| Before | After | Location |
|---|---|---|
| `ObservationResult` | `Observation` | `core/db.ts` |
| `ObservationData` | `Observation` | (removed with observations.ts) |
| `ObservationOutput` | `Observation` | `mcp/handlers.ts` |
| `CompactObservationResult` | `ObservationSummary` | `core/search.ts` |
| `PendingEvent` | `BufferedEvent` | `core/db.ts` |
| `CompressedEvent` | `EventSummary` | `core/llm/extractor.ts` |
| `compressToolData()` | `summarizeEvent()` | `core/summarize.ts` |

## DB Schema

```sql
-- Rename column in pending_events
ALTER TABLE pending_events RENAME COLUMN compressed TO summary;
```

Migration: added to `createDatabase()` via `pragma_table_info` check
(same pattern as existing `content_original` migration).

## SearchOptions Unification

`db.ts` `searchObservations()` uses timestamp-based `after`/`before`.
`search.ts` uses ISO date strings. These diverged because
`session-start.ts` (→ `recall.ts`) needed a timestamp cutoff.

Fix: remove `searchObservations()` from `db.ts`. `recall.ts` converts
its timestamp cutoff to an ISO date string and calls `search()` from
`core/search.ts` directly.

## CLI Commands

```
memmem recall    # SessionStart hook — inject recent context
memmem record    # PostToolUse hook — buffer tool event
memmem extract   # Stop hook — LLM extraction from buffer
```

Replace `observe --summarize` flag with separate `extract` command.
Update `hooks/hooks.json` accordingly.

## Data Flow (unchanged)

```
PostToolUse → record  → summarizeEvent() → event_buffer table
Stop        → extract → LLM batch extract → observations + embeddings
SessionStart → recall  → search() → inject markdown into session
MCP search   → normalizer → search() → observations
```

## Files Not Changed

- `core/embeddings.ts` — IPC client (works fine)
- `core/embeddings-model.ts` — worker model loader
- `core/archive.ts`, `paths.ts`, `read.ts`, `ratelimiter.ts`, `logger.ts`, `constants.ts`
- `mcp/server.ts`, `mcp/schemas.ts`, `mcp/tools.ts`
- `mcp/embedding-worker.ts`
- `core/llm/types.ts`, `config.ts`, `gemini-provider.ts`, `zai-provider.ts`
