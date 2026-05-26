# Episodic Memory Port Design

## Goal

Replace memmem's current observation-based memory system with an episodic-memory-style transcript-centric system.

The new system indexes Claude Code and Codex transcripts directly, stores searchable exchanges and tool calls in SQLite, and exposes semantic/text search plus transcript reading through CLI and MCP tools.

This is a breaking redesign. Existing observation data and schema compatibility are not preserved. Users can delete the old database and run `memmem sync` to rebuild the new index.

## Non-goals

- Preserve or migrate existing `pending_events`, `observations`, or `vec_observations` data.
- Keep Stop-hook LLM observation extraction.
- Add a new multilingual embedding model in this phase.
- Add summarization as a required indexing dependency.

## Embedding

Use the existing `Supabase/gte-small` embedding pipeline for this phase.

The index stores an `embedding_version` on each exchange. Any future change to model, dtype, pooling, normalization, truncation, or input formatting must bump the embedding version and trigger stale-row reindexing.

## Architecture

The archive is the source of truth. `sync` discovers source transcripts, copies new or modified files into the archive, then indexes exchange ranges from archived files.

Main modules:

- `core/paths`: resolve config, archive, index, log, Claude, and Codex paths.
- `core/sync`: discover transcript sources, copy changed files atomically, enforce single-instance sync.
- `core/parser`: parse Claude Code JSONL and Codex rollout JSONL into normalized exchanges.
- `core/indexer`: append-only incremental indexing from archive files into SQLite.
- `core/embeddings`: load `gte-small` lazily and embed exchange text.
- `core/search`: vector, text, both, and multi-concept search over exchanges.
- `core/read`: render archived transcript files or line ranges as markdown.
- `cli`: `sync`, `search`, `show`, `stats`, and later `doctor`.
- `mcp`: `search` and `read` tools only.

Remove the existing hook-driven observation flow:

- `pending_events`
- `observations`
- `vec_observations`
- Stop hook batch LLM extraction
- SessionStart observation injection
- MCP `get_observations`

## Transcript sources

`memmem sync` treats Claude Code and Codex as first-class sources.

Claude Code sources:

- `CLAUDE_CONFIG_DIR || ~/.claude` / `projects`
- `CLAUDE_CONFIG_DIR || ~/.claude` / `transcripts`

Codex source:

- `CODEX_HOME || ~/.codex` / `sessions`

Testing may override sources with a dedicated test source directory.

Only existing source directories are scanned. Archive paths include a source-kind prefix before the source-relative path so sources cannot collide:

- `claude-projects/<relative path>`
- `claude-transcripts/<relative path>`
- `codex-sessions/<relative path>`

## Archive behavior

Default archive location remains under memmem's config directory, using a `conversation-archive` subdirectory.

Sync behavior:

- Skip unchanged files by comparing destination mtime with source mtime.
- Copy changed files through a temporary file and atomic rename.
- Do not copy path-excluded files.
- Copy marker-excluded files to the archive, but do not index them.
- Preserve nested source-relative paths under the source-kind prefix to avoid collisions and keep source provenance.
- Run under a lock so concurrent syncs do not corrupt archive or index state.
- Exit successfully when another sync already holds the lock.

A reentrancy guard prevents sync loops from assistant subprocesses or future summarizer flows. The guard variable is `MEMMEM_SYNC_GUARD=1`. Sync exits successfully without doing work when this variable is present in its own environment. Normal Claude and Codex SessionStart hook invocations do not set the guard on the top-level sync process; they set it only on child assistant/summarizer subprocess environments.

## Exclusion rules

Do not index transcripts when any of these apply:

- A top-level or nested path component matches configured excluded projects. Path-excluded files are not copied to the archive.
- The transcript contains `DO NOT INDEX THIS CHAT`. Marker-excluded files are copied to the archive but not indexed.
- The transcript is a generated summarizer/search context conversation that should not become memory. Generated context files are copied only if they came from a normal transcript source; they are never indexed.

## Database schema

Use exchange-centric schema, matching episodic-memory's core model.

### `exchanges`

Each row represents a searchable user/assistant exchange from an archived transcript.

Important columns:

- `id INTEGER PRIMARY KEY`
- `archive_path TEXT NOT NULL`
- `line_start INTEGER NOT NULL`
- `line_end INTEGER NOT NULL`
- `harness TEXT NOT NULL` (`claude` or `codex`)
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
- `is_sidechain INTEGER NOT NULL DEFAULT 0`
- `embedding_version INTEGER NOT NULL DEFAULT 0`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

`timestamp`, `created_at`, and `updated_at` are Unix epoch milliseconds. Date filters convert `YYYY-MM-DD` to local-day UTC boundaries: `after` is inclusive at the start of the day and `before` is inclusive through the end of the day.

Add a unique index on `(archive_path, line_start, line_end)` to make repeated syncs idempotent. `vec_exchanges.id` stores `String(exchanges.id)` and joins with `CAST(exchanges.id AS TEXT)`.

The indexer uses `archive_path` plus `MAX(line_end)` as the high-water mark only when the archived file is append-only. If a source file modification changes existing content, the sync/index flow deletes all rows for that `archive_path` and reindexes the archived file from line 1.

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

Harness values are normalized to `claude` and `codex`.

Codex metadata to preserve:

- harness: `codex`
- session ID, including rollout filename UUID fallback
- cwd and project
- git branch
- model/provider
- reasoning or thinking metadata when present, stored in `metadata_json`

Codex tool calls and outputs are matched by call ID across supported shapes, including function calls, custom tool calls, tool search calls, and local shell calls.

## Indexing behavior

`memmem sync` indexes archived files that need database work, not only files copied during the current run. A file needs indexing when it was newly copied, modified, missing from the `exchanges` table, or has stale embeddings. This lets users delete the database and rebuild from the existing archive with `memmem sync`.

For each archive file:

1. Decide whether the file is append-only by comparing previous indexed line count/content metadata with the refreshed archive.
2. If append-only, determine the high-water mark from `MAX(line_end)` for that `archive_path`.
3. If not append-only, delete existing `exchanges` for that `archive_path`; `tool_calls` cascade and vector rows are removed in the same cleanup transaction.
4. Parse exchanges from the archived file.
5. For append-only files, keep only exchanges with `line_start > maxIndexedLine`; for rewritten files, keep all exchanges.
6. Generate embedding for each exchange's `embedding_text`.
7. Insert exchange row, tool call rows, and vector row in a transaction.
8. Stamp the current `embedding_version`.

Embedding migration runs at the end of `sync` after newly indexed files are processed. It re-embeds rows where `embedding_version` is stale in batches of 100 behind an embedding-migration lock in the index directory. Failures leave rows stale so the next sync can resume.

## Search behavior

The default search mode is `both`.

Supported modes:

- `vector`: KNN search over `vec_exchanges`, ordered by vector distance converted to similarity.
- `text`: SQL `LIKE` search over user and assistant text, ordered by timestamp descending.
- `both`: vector results first, then text results appended with ID de-duplication.

Filters use bound SQL parameters and AND semantics:

- `after` (`YYYY-MM-DD`)
- `before` (`YYYY-MM-DD`)
- `project`
- `session_id`
- `git_branch`

Sidechain exchanges are excluded by default.

Search results are compact cards:

- project and date
- `score` for vector-backed matches, omitted for text-only matches
- `mode`: `vector`, `text`, or `both`
- snippet chosen from the first matching text field; text search prefers the field containing the matched term, vector search prefers assistant text with user text fallback
- archive path
- line range
- concept scores and concept ranges for multi-concept search

## Multi-concept search

A query may be a string array or multiple CLI query arguments.

For each concept:

1. Run vector-only search with a wider candidate limit, such as `limit * 5`.
2. Group candidates by `archive_path`.
3. Keep only transcripts where every concept appears.
4. Rank by average similarity across concepts.
5. Return transcript-level results with per-concept scores and per-concept representative ranges.

The aggregation unit is transcript/archive path, not exchange ID. A multi-concept result includes `concepts: [{ query, score, lineStart, lineEnd, exchangeId }]` rather than a single ambiguous line range.

## CLI surface

Primary commands:

- `memmem sync`
- `memmem search <query...>`
- `memmem show <archive_path>`
- `memmem read <archive_path>`
- `memmem stats`

Search options:

- `--vector`
- `--text`
- `--both`
- `--json`
- `--after YYYY-MM-DD`
- `--before YYYY-MM-DD`
- `--project <name>`
- `--session-id <id>`
- `--git-branch <branch>`
- `--limit <n>`

`show` is an alias for `read`. Both render archived transcripts as markdown and accept `--start-line` and `--end-line`. HTML output is out of scope for this phase.

## MCP surface

Expose two MCP tools.

### `search`

Input:

- `query`: string or string array
- `mode`: `vector`, `text`, or `both`, default `both`
- `limit`
- `after`
- `before`
- `project`
- `session_id`
- `git_branch`

Output:

- JSON search results with compact metadata, snippets, archive path, line range, and multi-concept details when applicable.

MCP search is JSON-only in this phase. Markdown formatting belongs to the CLI.

### `read`

Input:

- `path`: absolute archived transcript path
- `startLine`: omitted to start at the first line
- `endLine`: omitted to read through the final line

Output:

- Markdown-rendered transcript or line range.

## Codex plugin support

Codex is part of the first design, not a later add-on.

Add a `.codex-plugin/plugin.json` that exposes:

- MCP server config through `.mcp.json` with relative `cwd` resolved from the plugin root
- required environment passthrough for config, Codex home, and logging paths
- memory/search skill files
- hook configuration

Keep package version references synchronized across `package.json`, Claude plugin metadata, Codex plugin metadata, and marketplace metadata.

Codex SessionStart hook should run the same background-safe sync command as Claude integration. The command must support `${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}` so the same hook works in Codex and Claude plugin environments. Hook-launched top-level sync must not receive `MEMMEM_SYNC_GUARD=1`; only child assistant/summarizer subprocess environments receive it.

Codex support requires doctor checks for:

- minimum `codex-cli` version
- `plugins` feature enabled
- `plugin_hooks` feature enabled
- MCP server registration
- sessions directory exists
- hook trust state: trusted, untrusted, modified, not found, or unknown
- sync log path and database path

## Testing strategy

Use `bun test` for this project.

Required tests:

- Claude transcript parser fixtures.
- Codex rollout parser fixtures.
- Source discovery for Claude and Codex paths.
- Sync idempotency and atomic copy behavior.
- Single-instance sync lock behavior.
- Reentrancy guard behavior.
- Exclusion by path and transcript marker.
- Append-only incremental indexing by `MAX(line_end)`.
- `tool_calls` cascade delete.
- Embedding version stale-row reindexing.
- Search mode behavior for vector, text, and both.
- Multi-concept transcript-level aggregation.
- MCP `search` and `read` schema/handler behavior.
- Codex plugin manifest and doctor checks.

Optional live E2E tests can cover Claude Code and Codex plugin behavior, but unit and integration fixtures should prove the core behavior without requiring live tools.

## Rollout

This is a breaking local data change.

Implementation should remove the old observation path and replace it with the transcript path in one feature branch. Release notes should clearly tell users to delete the old memmem database and run `memmem sync`.

The first implementation plan should be split into these milestones:

1. Schema and parser replacement.
2. Sync/archive/index flow.
3. Search/read CLI.
4. MCP search/read replacement.
5. Codex plugin and doctor support.
6. Removal of old observation hooks and tests.
