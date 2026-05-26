# Episodic Memory Port Design

## Goal

Replace memmem's current observation-based memory system with an episodic-memory-style transcript-centric system.

The new system indexes transcripts through source adapters, stores searchable exchanges and tool calls in SQLite, and exposes search plus transcript reading through CLI and MCP tools. Claude Code and Codex are the first built-in adapters; future harnesses should plug in without changing the index/search schema.

This is a breaking redesign. Existing observation data and schema compatibility are not preserved. Users can delete the old database and run `memmem sync` to rebuild the new index.

## Non-goals

- Preserve or migrate existing `pending_events`, `observations`, or `vec_observations` data.
- Keep Stop-hook LLM observation extraction.
- Add a new multilingual embedding model in this phase.
- Add summarization as a required indexing dependency.
- Recreate episodic-memory's full doctor/plugin trust surface in this phase.
- Expose separate vector/text/both mode flags in this phase.

## Embedding

Use the existing `Supabase/gte-small` embedding pipeline for this phase.

The index stores an `embedding_version` on each exchange. Any future change to model, dtype, pooling, normalization, truncation, or input formatting must bump the embedding version and trigger stale-row reindexing.

## Architecture

The archive is the source of truth. `sync` discovers source transcripts, copies new or modified files into the archive, then indexes exchange ranges from archived files.

Main modules:

- `core/sources`: source adapter interface plus built-in Claude Code and Codex adapters.
- `core/sync`: discover transcripts through adapters and copy changed files atomically.
- `core/parser`: dispatch archived files to the matching adapter parser and return normalized exchanges.
- `core/indexer`: index archived files into SQLite; reindex a file from scratch when needed.
- `core/embeddings`: load `gte-small` lazily and embed exchange text.
- `core/search`: default hybrid search over exchanges.
- `core/read`: render archived transcript files or line ranges as markdown.
- `cli`: `sync`, `search`, and `read`.
- `mcp`: `search` and `read` tools only.

Remove the existing hook-driven observation flow:

- `pending_events`
- `observations`
- `vec_observations`
- Stop hook batch LLM extraction
- SessionStart observation injection
- MCP `get_observations`

## Transcript sources

Sources are adapters. Each adapter declares:

- `kind`: stable source namespace used in archive paths, such as `claude-projects`, `claude-transcripts`, or `codex-sessions`
- `roots`: directories to scan
- `detect(file)`: whether the adapter can parse a file
- `parse(file)`: normalized exchange extraction

Built-in adapters:

- Claude Code projects: `CLAUDE_CONFIG_DIR || ~/.claude` / `projects`
- Claude Code transcripts: `CLAUDE_CONFIG_DIR || ~/.claude` / `transcripts`
- Codex sessions: `CODEX_HOME || ~/.codex` / `sessions`

Only existing roots are scanned. Archive paths are always `<kind>/<relative path>` so future harnesses can be added without path collisions or schema changes.

## Archive behavior

Default archive location remains under memmem's config directory, using a `conversation-archive` subdirectory.

Sync behavior:

- Skip unchanged files by comparing destination mtime with source mtime.
- Copy changed files through a temporary file and atomic rename.
- Preserve nested source-relative paths under the adapter `kind` prefix.
- Use a single sync lock; if another sync is running, exit successfully.

Exclusion is intentionally minimal in this phase: if a transcript contains `DO NOT INDEX THIS CHAT`, archive it but do not index it. Project/path exclusion lists and generated-summary special cases are out of scope for the first implementation.

## Database schema

Use exchange-centric schema, matching episodic-memory's core model.

### `exchanges`

Each row represents a searchable user/assistant exchange from an archived transcript.

Important columns:

- `id INTEGER PRIMARY KEY`
- `archive_path TEXT NOT NULL`
- `line_start INTEGER NOT NULL`
- `line_end INTEGER NOT NULL`
- `source_kind TEXT NOT NULL`
- `session_id TEXT`
- `project TEXT`
- `cwd TEXT`
- `git_branch TEXT`
- `model TEXT`
- `provider TEXT`
- `metadata_json TEXT`
- `timestamp INTEGER`
- `user_text TEXT NOT NULL`
- `assistant_text TEXT NOT NULL`
- `embedding_text TEXT NOT NULL`
- `embedding_version INTEGER NOT NULL DEFAULT 0`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

`timestamp`, `created_at`, and `updated_at` are Unix epoch milliseconds. Date filters convert `YYYY-MM-DD` to local-day UTC boundaries: `after` is inclusive at the start of the day and `before` is inclusive through the end of the day.

Add a unique index on `(archive_path, line_start, line_end)` to make repeated syncs idempotent. `vec_exchanges.id` stores `String(exchanges.id)` and joins with `CAST(exchanges.id AS TEXT)`.

The indexer keeps the implementation simple: when an archived file needs indexing, delete existing rows for that `archive_path` and reindex the file from line 1. Append-only high-water indexing is an optimization to add later only if needed.

### `tool_calls`

Tool events are normalized and attached to exchanges.

Important columns:

- `id INTEGER PRIMARY KEY`
- `exchange_id INTEGER NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE`
- `tool_name TEXT`
- `call_id TEXT`
- `input TEXT`
- `output TEXT`
- `status TEXT`
- `created_at INTEGER NOT NULL`

Cascade delete is required so cleanup or reindexing cannot leave orphan tool calls.

### `vec_exchanges`

Vector table for semantic search:

- `id TEXT PRIMARY KEY`
- `embedding float[384]`

The string `id` is `String(exchanges.id)`. All joins cast `exchanges.id` to text explicitly.

## Parser behavior

### Claude Code JSONL

The parser detects Claude-style transcripts from valid JSONL entries.

A user message starts a new exchange. Assistant messages and tool-use content are accumulated until the next user message. Exchanges without assistant content are discarded.

The parser records line ranges so search results can point back to exact transcript sections.

### Codex rollout JSONL

The parser detects Codex rollout files from records such as:

- `session_meta`
- `turn_context`
- `response_item`
- `event_msg`
- `compacted`

Adapters preserve their `source_kind`.

Codex metadata to preserve:

- source kind: `codex-sessions`
- session ID, including rollout filename UUID fallback
- cwd and project
- git branch
- model/provider
- reasoning or thinking metadata when present, stored in `metadata_json`

Codex tool calls and outputs are matched by call ID across supported shapes, including function calls, custom tool calls, tool search calls, and local shell calls.

## Indexing behavior

`memmem sync` indexes archived files that need database work, not only files copied during the current run. A file needs indexing when it was newly copied, modified, missing from the `exchanges` table, or has stale embeddings. This lets users delete the database and rebuild from the existing archive with `memmem sync`.

For each archive file that needs indexing:

1. Delete existing `exchanges` for that `archive_path`; `tool_calls` cascade and vector rows are removed in the same cleanup transaction.
2. Ask the matching source adapter to parse normalized exchanges.
3. Generate embedding for each exchange's `embedding_text`.
4. Insert exchange row, tool call rows, and vector row in a transaction.
5. Stamp the current `embedding_version`.

Embedding migration is simple in this phase: rows with stale `embedding_version` are treated as needing reindex for their `archive_path`. Batch migration locks can be added later if the full-file reindex becomes too slow.

## Search behavior

Search has one default behavior in this phase: hybrid search. It runs vector search first, then appends text matches with ID de-duplication. Separate `vector`, `text`, and `both` user-facing flags are out of scope until there is a proven need.

Filters use bound SQL parameters and AND semantics:

- `after` (`YYYY-MM-DD`)
- `before` (`YYYY-MM-DD`)
- `source_kind`

Additional metadata filters such as project, session, and branch are out of scope for the first implementation.

Search results are compact cards:

- project and date
- score when the result came from vector search
- short snippet
- archive path
- line range

Multi-concept search is out of scope for the first implementation. A later version can add it on top of the same `archive_path` and line-range metadata without changing the schema.

## CLI surface

Primary commands:

- `memmem sync`
- `memmem search <query>`
- `memmem read <archive_path>`

Search options:

- `--after YYYY-MM-DD`
- `--before YYYY-MM-DD`
- `--source-kind <kind>`
- `--limit <n>`

`read` renders archived transcripts as markdown and accepts `--start-line` and `--end-line`. `show`, JSON output, HTML output, and mode flags are out of scope for this phase.

## MCP surface

Expose two MCP tools.

### `search`

Input:

- `query`: string
- `limit`
- `after`
- `before`
- `source_kind`

Output:

- JSON search results with compact metadata, snippets, archive path, and line range.

MCP search is JSON-only in this phase. Markdown formatting belongs to the CLI.

### `read`

Input:

- `path`: absolute archived transcript path
- `startLine`: omitted to start at the first line
- `endLine`: omitted to read through the final line

Output:

- Markdown-rendered transcript or line range.

## Adapter and plugin support

Codex is included because it is one of the first built-in source adapters, not because the core should become Codex-specific.

The first implementation needs adapter tests for Claude Code and Codex. Plugin manifests, hook trust checks, and doctor commands are out of scope for this phase. They can be added later without changing the archive, parser, index, search, or MCP contracts.

## Testing strategy

Use `bun test` for this project.

Required tests:

- Source adapter discovery for Claude Code and Codex.
- Claude transcript parser fixtures.
- Codex rollout parser fixtures.
- Sync idempotency and atomic copy behavior.
- Single-instance sync lock behavior.
- Marker exclusion with `DO NOT INDEX THIS CHAT`.
- Full-file reindex when an archived file needs indexing.
- `tool_calls` cascade delete.
- Stale `embedding_version` triggers archive-path reindex.
- Default hybrid search behavior.
- MCP `search` and `read` schema/handler behavior.

Optional live E2E tests can cover Claude Code and Codex plugin behavior later, but unit and integration fixtures should prove the core behavior without requiring live tools.

## Rollout

This is a breaking local data change.

Implementation should remove the old observation path and replace it with the transcript path in one feature branch. Release notes should clearly tell users to delete the old memmem database and run `memmem sync`.

The first implementation plan should be split into these milestones:

1. Schema and source adapter interfaces.
2. Claude Code and Codex parser adapters.
3. Sync/archive/full-file index flow.
4. Default search and read CLI.
5. MCP search/read replacement.
6. Removal of old observation hooks and tests.
