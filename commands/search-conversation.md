---
name: search-conversation
description: Search through past conversations using indexed transcript exchanges
argument-hint: [<query>]
---

You are helping the user search conversation history with the memmem transcript index.

## How This Command Works

1. Call `mcp__plugin_memmem_memmem__search` with the user's query.
2. Review the returned snippets and source metadata.
3. If more context is needed, call `mcp__plugin_memmem_memmem__read` with the returned `archive_path`, `line_start`, and `line_end`.
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
- `snippet`
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

- Present the most relevant matches with date, project/source kind, snippet, and archive line range.
- Summarize patterns, decisions, gotchas, and recommendations.
- Cite sources as `archive_path:line_start-line_end`.
- If no results are found, suggest broader terms or removing filters.
