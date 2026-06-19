# MCP Tools API Reference

This document provides the memmem MCP tool reference for indexed event/fact memory record search.

**Warning:** Direct MCP tool usage can waste context. Prefer the `search-conversation` agent unless you need manual control.

## Overview

The current flow is:

1. `search()` indexed event/fact memory records.
2. `fetch(id)` the source transcript for a selected record when more context is needed.
3. Synthesize findings and cite the record `id`s relied on.

---

## search

Search indexed event/fact memory records. Use `fetch` with a returned record `id` when raw transcript evidence is needed.

Omit `query` entirely to list the most recent records in reverse chronological order. Combine with `after`/`before` for time-based recall such as "what did I do today" (no semantic search runs in this mode).

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` \| `string[]` | No | - | Search query. A single string, or an array of 2-5 strings for multi-query AND search (only records matching every query). Omit to list recent records by time. |
| `limit` | `number` | No | `10` | Max results (1-50) |
| `after` | `string` | No | - | Filter results after this date (YYYY-MM-DD) |
| `before` | `string` | No | - | Filter results before this date (YYYY-MM-DD) |
| `source_kind` | `string` | No | - | Filter to a source such as `claude-projects` or `codex-sessions` |

### Basic Usage

```json
{
  "query": "authentication patterns",
  "limit": 10
}
```

### Filtered Search

```json
{
  "query": "React Router authentication",
  "after": "2026-05-01",
  "before": "2026-06-01",
  "source_kind": "claude-projects",
  "limit": 10
}
```

### Time-Based Recall (No Query)

Omit `query` to get the newest records in a date range — used for "오늘 한 일 / what did I do today":

```json
{
  "after": "2026-06-16",
  "before": "2026-06-16",
  "limit": 20
}
```

Results come back sorted by `timestamp` descending and carry no `score`.

### Result Shape

Each search result is a compact card:

```json
{
  "id": "123",
  "kind": "event",
  "text": "The user decided to use source-linked event/fact memory records.",
  "score": 0.82
}
```

`score` is omitted for time-based recall (no `query`). The card carries no archive path or line numbers — pass `id` to `fetch` when more context is needed.

### Search Tips

- Start with broad natural-language queries.
- Include exact IDs, error codes, or file names directly in `query`.
- Use date filters to constrain large histories.
- Use `source_kind` when you only want one transcript source.

---

## fetch

Fetch the full source transcript for a memory record returned by `search`. Renders the original conversation (markdown) for that record's archived line range.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` \| `number` | Yes | - | Memory record `id` from a search result |

### Basic Usage

```json
{
  "id": "16447"
}
```

### Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| No conversations found | No search matches | Try broader query or remove filters |
| Invalid date format | Date is not YYYY-MM-DD | Use YYYY-MM-DD |
| Invalid memory record id | `id` is not an integer | Pass an `id` exactly as returned by `search` |
| Memory record not found | Stale or unknown `id` | Re-run `search` and use a current `id` |

---

## Recommended Direct Workflow

```typescript
// Step 1: Search event/fact memory records
{ query: "authentication", limit: 10 }

// Step 2: Fetch a promising result if the memory card text is not enough
{ id: result.id }

// Step 3: Synthesize and cite source
// Source: memory record `${result.id}`
```

## Why Use the Agent Instead?

| Aspect | Direct Tools | search-conversation Agent |
|--------|--------------|---------------------------|
| Context usage | Manual management | Reads only what is needed |
| Workflow | Manual search then fetch | Automatic search/fetch/synthesis |
| Sources | Must track manually | Included in response |
| Output | Raw memory cards/transcript | Curated insights |

## See Also

- [SKILL.md](./SKILL.md) - High-level usage guide
- [README.md](../../README.md) - Plugin documentation
- [search-conversation agent](../../agents/search-conversation.md) - Recommended workflow
