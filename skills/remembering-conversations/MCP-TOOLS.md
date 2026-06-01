# MCP Tools API Reference

This document provides the memmem MCP tool reference for indexed event/fact memory record search.

**Warning:** Direct MCP tool usage can waste context. Prefer the `search-conversation` agent unless you need manual control.

## Overview

The current flow is:

1. `search()` indexed event/fact memory records.
2. `read()` archived transcript lines for selected results when more context is needed.
3. Synthesize findings and cite archive paths with line ranges.

---

## search

Search indexed event/fact memory records. Use `read` with the returned archive path and line range when raw transcript evidence is needed.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | Yes | - | Search query |
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

### Result Shape

Search results include:

```json
{
  "id": "123",
  "archive_path": "/Users/user/.config/memmem/conversation-archive/claude-projects/project/session.jsonl",
  "line_start": 10,
  "line_end": 18,
  "source_kind": "claude-projects",
  "project": "my-project",
  "timestamp": 1780000000000,
  "kind": "event",
  "text": "The user decided to use source-linked event/fact memory records.",
  "score": 0.82
}
```

Use `archive_path`, `line_start`, and `line_end` with `read` when more context is needed.

### Search Tips

- Start with broad natural-language queries.
- Include exact IDs, error codes, or file names directly in `query`.
- Use date filters to constrain large histories.
- Use `source_kind` when you only want one transcript source.

---

## read

Read archived transcript lines.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | `string` | Yes | - | `archive_path` from search results |
| `startLine` | `number` | No | `1` | Starting line (1-indexed) |
| `endLine` | `number` | No | - | Ending line |

### Basic Usage

```json
{
  "path": "/Users/user/.config/memmem/conversation-archive/claude-projects/project/session.jsonl",
  "startLine": 10,
  "endLine": 18
}
```

Expand the line range if the matching memory record needs surrounding context or raw transcript evidence:

```json
{
  "path": "/path/from/search/result.jsonl",
  "startLine": 5,
  "endLine": 25
}
```

### Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| No conversations found | No search matches | Try broader query or remove filters |
| Invalid date format | Date is not YYYY-MM-DD | Use YYYY-MM-DD |
| File not found | Bad `path` | Use `archive_path` from search results |
| Invalid line range | Bad `startLine` / `endLine` | Ensure line numbers are positive and ordered |

---

## Recommended Direct Workflow

```typescript
// Step 1: Search event/fact memory records
{ query: "authentication", limit: 10 }

// Step 2: Read a promising result if the memory record is not enough
{
  path: result.archive_path,
  startLine: result.line_start,
  endLine: result.line_end
}

// Step 3: Synthesize and cite source
// Source: `${result.archive_path}:${result.line_start}-${result.line_end}`
```

## Why Use the Agent Instead?

| Aspect | Direct Tools | search-conversation Agent |
|--------|--------------|---------------------------|
| Context usage | Manual management | Reads only what is needed |
| Workflow | Manual search then read | Automatic search/read/synthesis |
| Sources | Must track manually | Included in response |
| Output | Raw memory records/transcript lines | Curated insights |

## See Also

- [SKILL.md](./SKILL.md) - High-level usage guide
- [README.md](../../README.md) - Plugin documentation
- [search-conversation agent](../../agents/search-conversation.md) - Recommended workflow
