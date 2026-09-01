---
name: search-conversation
description: Search indexed event/fact memory records
argument-hint: [<query>]
---

Search indexed event/fact memory records. Use `read` with the returned archive path and line range when raw transcript evidence is needed.

## How This Command Works

1. Call `mcp__plugin_episodic_memory_episodic_memory__search` with the user's query.
2. Review the returned memory records and source metadata.
3. If more context is needed, call `mcp__plugin_episodic_memory_episodic_memory__read` with the returned `archive_path`, `line_start`, and `line_end`.
4. Synthesize findings with clear sources.

## Search

```json
{
  "query": "authentication bug",
  "limit": 10
}
```

Optional filters:

```json
{
  "query": "authentication bug",
  "after": "2026-05-01",
  "before": "2026-06-01",
  "source_kind": "claude-projects",
  "limit": 10
}
```

Search results include:

- `archive_path`
- `line_start`
- `line_end`
- `source_kind`
- `project`
- `timestamp`
- `kind`
- `text`
- `score`

## Read More Context

Use read only for results that need more context:

```json
{
  "path": "/path/from/search/result.jsonl",
  "startLine": 12,
  "endLine": 24
}
```

Use the line range from search results, expanding it slightly when needed.

## Response Guidance

- Present the most relevant matches with date, project/source kind, memory text, and archive line range.
- Summarize patterns, decisions, gotchas, and recommendations.
- Cite sources as `archive_path:line_start-line_end`.
- If no results are found, suggest broader terms or removing filters.
