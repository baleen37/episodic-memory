# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# memmem

## Purpose

Persistent conversation memory across Claude Code and Codex sessions using archived transcripts.
Memmem syncs local transcripts into an archive and runs them through a mem0 v2 style extraction
and hybrid search pipeline (ported from mem0 v2.0.17), exposing memory search through CLI and MCP.

## Memory Architecture Principles

- Transcript archive is the source of truth for what gets synced and re-extracted.
- The persisted and searchable unit is a flat `MemoryItem` (`id`, `memory`, `hash`, `metadata`,
  `created_at`, `updated_at`) — not a turn-level transcript object, and provenance
  (`archive_path`/`line_start`/`line_end`) is no longer a required field.
- Consolidation is ADD-only: new extracted facts are deduplicated by an md5 hash of their text.
  There is no LLM-arbitrated UPDATE or DELETE of existing memories (mem0 v2 removed that step).
- Extraction is bounded, idempotent-by-hash, schema-validated, and failure-tolerant: a failed LLM
  call raises `LLMError` rather than silently returning no memories, and unparsable responses are
  rejected rather than partially trusted.
- Storage language is English. `use_input_language` (mem0's option to store memories in the
  input's language) stays off — extracted memory text is normalized to English regardless of the
  source conversation's language.
- Token efficiency is a product requirement: default outputs must be compact, deduplicated, and bounded.

## Commands

```bash
bun test                        # Run all tests
bun test path/to/file.test.ts   # Run single test file
bun test --watch                # Watch mode
bun run build                   # Bundle with Bun.build (scripts/build.mjs)
bun run typecheck               # tsc --noEmit
bun run cli <sync|search|stats|verify>   # Run built CLI (dist/cli-internal.mjs)
```

**CRITICAL**: Always use `bun` — this project uses `bun:sqlite` (built-in) and `bun test`.

## Key Files

| File | Description |
| ---- | ----------- |
| `src/core/db.ts` | Legacy database schema (`memory_records`, `vec_memory_records`, `extraction_state`, `archive_index_state`) — `openDatabase()`/`initDatabase()`. Still the source of `archive_index_state` (per-file sync mtime tracking) used by `sync.ts`; `memory_records`/`vec_memory_records`/`extraction_state` are otherwise dead — see note below |
| `src/core/memory/schema.ts` | mem0 v2 schema (`memories`, `history`, `entities`, `vec_memories`, `vec_entities`, `fts_memories`) and `MemoryItem`/`HistoryRow` types — `openMemoryDb()` |
| `src/core/memory/add.ts` | `addMemories()` — the 8-phase batch ingestion pipeline |
| `src/core/memory/extract.ts` | Single-LLM-call extraction + response parsing; throws `LLMError` on provider/parse failure |
| `src/core/memory/prompts.ts` | `ADDITIVE_EXTRACTION_PROMPT` (verbatim mem0 v2 prompt) and message/prompt builders |
| `src/core/memory/store.ts` | `insertMemories()` (md5 dedup + batch insert into `memories`/`vec_memories`/`fts_memories`), `recordHistory()`, `upsertEntities()` |
| `src/core/memory/scoring.ts` | Port of mem0's `scoring.py` — BM25 sigmoid normalization, additive semantic+BM25+entity scoring with adaptive divisor, `scoreAndRank()` |
| `src/core/memory/search.ts` | `searchMemories()` — hybrid vector + FTS5 BM25 + entity-boost search over `memories` |
| `src/core/memory/filters.ts` | Metadata filter operators (`eq`/`ne`/`in`/`nin`/`gt(e)`/`lt(e)`/`contains`/`icontains`, `AND`/`OR`/`NOT`) and scoping-key enforcement |
| `src/core/sources/types.ts` | Source adapter and transcript span types |
| `src/core/sources/claude.ts` | Claude Code transcript adapters and JSONL parser |
| `src/core/sources/codex.ts` | Codex transcript adapter and rollout parser |
| `src/core/sources/index.ts` | Built-in source adapter exports |
| `src/core/embeddings.ts` | Xenova/multilingual-e5-small embeddings (384-dim) with passage/query prefix routing |
| `src/core/ratelimiter.ts` | Token bucket rate limiter (singleton, configurable) |
| `src/core/llm/config.ts` | LLM config loading + `createProvider()` factory; supports single-provider and `providers[]` round-robin modes |
| `src/core/llm/{gemini,zai}-provider.ts` | Provider implementations behind the `LLMProvider` interface (`src/core/llm/types.ts`) |
| `src/core/llm/round-robin-provider.ts` | Rotates across multiple `(apiKey, model)` entries to spread rate limits |
| `src/cli/sync.ts` | CLI sync command: copy transcripts to archive, then run each unindexed span through `addMemories()`, bounded by `EXTRACTION_BUDGET_PER_SYNC` per run |
| `src/cli/search.ts` | CLI search command (`--after`/`--before` currently throw — not yet supported on the mem0 v2 surface) |
| `src/cli/stats.ts` | CLI stats command — counts over `memories`/`vec_memories` |
| `src/cli/verify.ts` | CLI verify command — missing/orphan vector checks over `memories`/`vec_memories` |
| `src/cli/main.ts` | CLI router exposing `sync`, `search`, `stats`, `verify`, `doctor`, and `mcp` |
| `src/cli-graceful.mjs` | Bun CLI graceful wrapper built to `bin/memmem` (imports `dist/cli-internal.mjs`) |
| `src/mcp/server.ts` | MCP server exposing the `search` tool only |
| `src/mcp/handlers.ts` | MCP handler for `search`, delegating to `searchMemories()` |
| `src/mcp/schemas.ts` | MCP input schema for `search` (`query`, `limit`, `threshold`, `explain`) |
| `src/mcp/tools.ts` | MCP tool definition for `search` |
| `hooks/hooks.json` | SessionStart hook configuration for `memmem sync` |
| `src/cli/mcp.ts` | `memmem mcp` subcommand: ensures deps/build, then spawns the MCP server bundle |
| `scripts/build.mjs` | Bun.build bundling script |

**Known transitional state**: `sync.ts` still opens the database via `db.ts`'s `openDatabase()`
(for `archive_index_state`, the per-file mtime bookkeeping that keeps re-sync incremental) and
then calls `createMemorySchema()` on the same connection to add the mem0 v2 tables. `memory_records`,
`vec_memory_records`, and `extraction_state` in `db.ts` are dead — nothing in the live code path
reads or writes them anymore. They have not yet been deleted.

## Architecture Overview

### Data Flow

```text
SessionStart hook → bin/memmem sync → src/cli/sync.ts
sync              → source adapters discover Claude/Codex JSONL transcripts
sync              → copy changed transcripts into conversation-archive/<source_kind>/<relative path>
sync              → parse changed archive files into transcript spans (per source adapter)
sync              → each span's messages go through addMemories() (8-phase batch pipeline):
                      Phase 0  session context: last 10 messages
                      Phase 1  one vector search over the whole batch → existing memories (top 10)
                      Phase 2  remap existing-memory UUIDs to small integers for the prompt
                      Phase 3  one LLM call (ADDITIVE_EXTRACTION_PROMPT) → extracted facts
                      Phase 4  batch-embed extracted facts
                      Phase 5  md5-hash dedup against memories.hash
                      Phase 6  batch insert into memories/vec_memories/fts_memories
                      Phase 7  batch insert into history (event = 'ADD')
                      entities are folded into the same extraction call, not a separate phase
sync              → mark the archive file's mtime indexed, bounded by EXTRACTION_BUDGET_PER_SYNC
CLI/MCP           → searchMemories(): hybrid vector + BM25 + entity-boost search over memories
```

Sync scopes every span to mem0 filters via `mapSourceToFilters()`: `user_id` is always the fixed
local machine identifier, `agent_id` is the source kind (`claude-projects`, `codex-sessions`, …),
and `run_id` is the archive file's basename — so search/`addMemories()` filters are always scoped
by at least `user_id`, satisfying mem0's scoping requirement (`assertScoped`).

Extraction is ADD-only. There is no LLM-arbitrated UPDATE or DELETE of existing memories — the
"existing memories" retrieved in Phase 1 are shown to the LLM only as context to avoid restating
facts already known; consolidation happens purely through Phase 5's md5 dedup on exact-text match.

### Database Schema

Primary tables in `~/.config/memmem/conversation-index/conversations.db` (`openMemoryDb()`):

- **`memories`**: `MemoryItem` rows — `id` (UUID), `memory` (text), `hash` (md5 of `memory`, unique),
  `metadata` (JSON blob holding scoping keys and promoted payload keys), `created_at`, `updated_at`.
  `score` is never persisted — it is computed per-query.
- **`history`**: append-only log of memory mutations (`memory_id`, `old_memory`, `new_memory`,
  `event`, `created_at`, `is_deleted`). In this port every event is `'ADD'`.
- **`entities`**: entities folded out of extraction (`id`, `data`, `entity_type`,
  `linked_memory_ids`, `created_at`).
- **`vec_memories`** / **`vec_entities`**: 384-dimensional float embeddings (`sqlite-vec` virtual
  tables), keyed by `memories.rowid` / `entities.rowid` — not by the UUID `id` column.
- **`fts_memories`**: FTS5 virtual table (`tokenize='unicode61'`) over lemmatized memory text, used
  for the BM25 term of hybrid search. `unicode61` (not `trigram`) because trigram tokenization can't
  index short Korean tokens; the tradeoff is fine because storage is English-normalized anyway.

Legacy tables `memory_records`, `vec_memory_records`, `extraction_state`, and `archive_index_state`
still live in `src/core/db.ts` (`openDatabase()`); see the transitional-state note above the Key
Files table. `archive_index_state` is still load-bearing (sync's per-file mtime cache); the other
three are unused dead schema.

### Search

`searchMemories()` (`src/core/memory/search.ts`) implements mem0 v2's hybrid ranking:

1. Embed the query and run a `vec_memories` KNN search (`internal_limit = max(limit*4, 60)`
   candidates), joined back to `memories` by rowid.
2. Run the same query (lemmatized: lowercase + whitespace-collapsed — the sanctioned deviation
   from mem0's spaCy lemmatizer) through `fts_memories` BM25, sigmoid-normalized to `[0,1]` via
   `getBm25Params`/`normalizeBm25` (query-length-adaptive midpoint/steepness) so raw unbounded BM25
   scores don't swamp the semantic term.
3. Entity boosts (`ENTITY_BOOST_WEIGHT = 0.5`) are wired into `scoreAndRank()` but always empty in
   this port — populating them needs query-time entity extraction, which was dropped when entities
   were folded into the batch extraction call. The `max_possible` divisor still adapts correctly
   when the boost map is empty.
4. `scoreAndRank()` combines the terms additively (`semantic + bm25 + entityBoost`), gates on the
   raw semantic score against `threshold` *before* combining (a below-threshold candidate is
   dropped even if BM25/entity would have rescued it — this matches upstream behavior), then
   divides by the adaptive `max_possible` (1.0, +1.0 if BM25 ran, +0.5 if entity boosts ran) and
   clamps to `1.0`.
5. `explain: true` attaches `score_details` (semantic/bm25/entity/raw/max_possible/final/threshold)
   to each result.

Filters must include at least one of `user_id`/`agent_id`/`run_id` (`assertScoped`); the CLI and
MCP surfaces always supply `user_id`. Metadata filter operators (`eq`, `ne`, `in`, `nin`, `gt(e)`,
`lt(e)`, `contains`, `icontains`, `AND`/`OR`/`NOT`) are in `src/core/memory/filters.ts`.

Search results are flat memory records (`id`, `memory`, `hash`, `metadata`, `score`, `created_at`,
`updated_at`, plus promoted metadata keys like `user_id`/`agent_id`/`run_id`/`role`). There is no
raw-transcript read path in this architecture — provenance (`archive_path`/`line_start`/`line_end`)
is not carried into `memories.metadata`, so results cannot be traced back to a transcript line range.

### Source Adapters

Built-in adapters:

- `claude-projects`: Claude Code project transcripts under the Claude config directory.
- `claude-transcripts`: Claude transcript directory when present.
- `codex-sessions`: Codex session JSONL transcripts under `CODEX_HOME`.

Adapters discover roots, detect JSONL files, parse transcript spans for extraction, and preserve source-specific metadata where available.

### LLM Provider Layer

`src/core/llm/` is the only LLM-dependent subsystem; it is used by `src/core/memory/add.ts` and
`extract.ts` to turn a batch of transcript messages into extracted memory facts. Everything behind
the `LLMProvider` interface (`types.ts`).

- `loadConfig()` reads the `llm` section of `~/.config/memmem/config.json`; returns `null` when
  unconfigured, which is why sync works (transcripts still get archived) without any provider —
  extraction is simply skipped and no memory rows are created.
- `createProvider(config)` is the single factory. Two configuration shapes:
  - **Single provider**: `{ provider: 'gemini' | 'zai', apiKey, model }`.
  - **Round-robin**: `{ providers: [{ provider, apiKey, model }, ...] }` → `RoundRobinProvider` rotates across entries to spread per-key rate limits.
- `extract.ts` makes exactly one LLM call per span (`extractMemories()`); a provider error or
  unparsable/malformed JSON response raises `LLMError` rather than returning an empty result, so
  callers can distinguish "LLM down" from "no facts found."

When adding a provider: implement `LLMProvider`, export it from `index.ts`, and wire it into `createProvider()` and the `LLMProviderType` union in `config.ts`.

### MCP Surface

MCP exposes only:

- **`search`**: `query` (required string), `limit` (default 20, max 50), `threshold` (minimum
  semantic score 0-1, default 0.1), `explain` (attach `score_details`, default false). Always
  scoped to the local `user_id`. Returns flat memory records (`id`, `memory`, `hash`, `metadata`,
  `score`, `created_at`, `updated_at`, plus any promoted metadata keys).

There is no `fetch` tool, no multi-query/array `query` support, no omitted-query recency listing,
and no `after`/`before` filtering on the MCP surface — all of these existed in the pre-mem0v2
architecture and were removed. There is no summary detail or graph layer in the target architecture.

### Build Output

Bun.build outputs bundles to `dist/` and the entrypoint executable to `bin/`:

- `src/cli/main.ts` → `dist/cli-internal.mjs` (CLI bundle)
- `src/mcp/server.ts` → `dist/mcp-server.mjs` (MCP server bundle)
- `src/cli-graceful.mjs` → `bin/memmem` (graceful wrapper executable, bun shebang, chmod 0755)

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

Archive sync does not require an LLM provider configuration — transcripts are still copied into the archive. Memory extraction during sync does require a configured LLM provider; without one, spans are skipped and no memory rows are created for those spans.

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
