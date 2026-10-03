# MCP Tools API Reference

episodic-memory exposes two read-only MCP tools: `search` and `read`.

## search

Hybrid keyword (BM25) and semantic search over past Claude Code and Codex
conversation turns. Each result is one turn: a user message, the assistant
reply, and tool names.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string \| string[]` | Yes | - | String for normal search, or 2-5 strings for strict AND search |
| `limit` | `number` | No | `10` | Max results, from 1 to 50 |
| `after` | `string` | No | - | Only turns on or after this date (`YYYY-MM-DD`, local time) |
| `before` | `string` | No | - | Only turns on or before this date (`YYYY-MM-DD`, local time) |
| `project` | `string` | No | - | Exact project name (git repository directory name) |

### Usage

```json
{ "query": "authentication patterns", "limit": 10, "project": "my-repo" }
```

Array queries return only conversations in which every concept matched, ranked
by the mean of the best per-concept scores, one turn per conversation. An empty
intersection returns no results; there is no OR fallback.

```json
{ "query": ["React Router", "authentication", "JWT"], "limit": 10 }
```

### Result Card

Each result shows the project, date, score (0-1, relative to the top hit), the
first 200 characters of the user message and of the reply, and a location at the
end:

```text
<archive_path>:<start>-<end>
```

Pass that path and line range to `read`. If the semantic model is not ready
yet, the first line of the output says results are keyword-only.

## read

Show archived transcript text (user messages, replies, tool calls with input
and result) for a file and line range.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | Archive file path, as given in a search result |
| `startLine` | `number` | No | First line, 1-based |
| `endLine` | `number` | No | Last line |

- Paths outside the archive directory are rejected.
- Tool inputs and results are truncated to 4KB each.
- Output blocks are prefixed `L<line>`. Output is capped at 60KB; when cut, the
  last line gives the `startLine` to continue from.

## Recommended Workflow

1. `search` with a specific query.
2. `read` the best one or two `archive_path:start-end` hits (widen the range a
   little if the context is cut).
3. Synthesize and cite `archive_path:start-end`.

## Why Use the Agent Instead?

| Aspect | Direct Tool | search-conversation Agent |
|-------|-------------|---------------------------|
| Context usage | Manual management | Curated synthesis |
| Workflow | Search, read, interpret manually | Search, read, summarize automatically |
| Sources | Track locations manually | Cited as `archive_path:start-end` |

## See Also

- [SKILL.md](./SKILL.md) - High-level usage guide
- [README.md](../../README.md) - Plugin documentation
- [search-conversation agent](../../agents/search-conversation.md) - Recommended workflow
