# MCP Tools API Reference

episodic-memory exposes one read-only MCP tool for searching local memory records.

## search

Search indexed event/fact memory records. Results are scoped to the local memory
namespace used by this plugin.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | Yes | - | Search query |
| `limit` | `number` | No | `20` | Max results, from 1 to 50 |
| `threshold` | `number` | No | `0.1` | Minimum semantic score, from 0 to 1 |
| `explain` | `boolean` | No | `false` | Include the score breakdown |

### Basic Usage

```json
{
  "query": "authentication patterns",
  "limit": 10,
  "threshold": 0.2
}
```

### Result Shape

```json
{
  "id": "memory-id",
  "memory": "The stored memory text.",
  "hash": "content-hash",
  "metadata": {
    "user_id": "local",
    "agent_id": "claude-code-projects"
  },
  "score": 0.82,
  "created_at": 1750000000000,
  "updated_at": 1750000000000
}
```

When `explain` is true, results may also include `score_details` with the
semantic, keyword, and entity contributions used for ranking.

### Search Tips

- Start broad, then add exact IDs, error codes, or file names.
- Use `threshold` to remove weak semantic matches.
- Use `explain` when ranking details matter.
- Cite the returned `id` when referring to a memory record.

## Recommended Workflow

```typescript
const result = await search({ query: 'authentication', limit: 10 });
// Synthesize the relevant result.memory values and cite their result.id values.
```

## Why Use the Agent Instead?

| Aspect | Direct Tool | search-conversation Agent |
|-------|-------------|---------------------------|
| Context usage | Manual management | Curated result synthesis |
| Workflow | Search and interpret manually | Search and summarize automatically |
| Sources | Must track record IDs manually | Included in the response |
| Output | Raw memory records | Focused findings |

## See Also

- [SKILL.md](./SKILL.md) - High-level usage guide
- [README.md](../../README.md) - Plugin documentation
- [search-conversation agent](../../agents/search-conversation.md) - Recommended workflow
