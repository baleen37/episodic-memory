---
name: remembering-conversations
description: Use when user asks 'how should I...' or 'what's the best approach...' after exploring code, when work is stuck, when a workflow is unfamiliar, or when user references past work.
---

# Remembering Conversations

**Core principle:** Search before reinventing. Searching costs little; repeating past mistakes is expensive.

## Decision Rule

Use this skill after you understand the current task well enough to search for the right thing. Do not use memory as a substitute for reading the current repo state.

Search memory when:

- User asks "how should I..." or "what's the best approach..."
- You've explored the current codebase and need architectural context
- You're stuck after investigating a problem
- You need to follow an unfamiliar workflow or process
- User references past work: "last time", "before", "we discussed", "do you remember"

Skip memory when:

- Current files, tests, or runtime state can answer the question directly
- The answer is already present in the current conversation
- You cannot yet name a concrete topic, decision, error, file, or workflow to search for

## Preferred Workflow

Use the `search-conversation` agent when your environment supports it.

Announce: "Searching past conversations for [topic]."

In Claude Code, dispatch the Task tool with `subagent_type: "search-conversation"`:

```text
Task tool:
  description: "Search past conversations for [topic]"
  prompt: "Search for [specific query or topic]. Focus on [decisions, patterns, gotchas, code examples]."
  subagent_type: "search-conversation"
```

Ask the agent to:

1. Search indexed event/fact memory records with `search`. Use `read` with the returned archive path and line range when raw transcript evidence is needed.
2. Read archived transcript lines with `read` only when memory records are not enough.
3. Synthesize concise findings.
4. Return actionable insights with `archive_path:line_start-line_end` sources.

## Direct MCP Fallback

If the `search-conversation` agent is unavailable, delegation is not allowed, or you need exact control over filters, call the memmem MCP tools directly. This is a fallback, not a failure.

Use the tool names exposed in the current environment; the API shape is:

### Search

```typescript
{
  query: "React Router authentication errors",
  limit: 10,
  after: "2026-05-01",
  source_kind: "claude-projects"
}
```

### Read

Use `archive_path`, `line_start`, and `line_end` from search results:

```typescript
{
  path: "/path/from/search/result.jsonl",
  startLine: 100,
  endLine: 140
}
```

## Search Strategy

1. Start broad, then narrow with additional query terms.
2. Put exact IDs, error codes, and file names directly in the query.
3. Use `after` / `before` for date ranges.
4. Use `source_kind` to limit results to a transcript source.
5. Read only the most promising transcript ranges.
6. Synthesize decisions, gotchas, and reusable patterns.

## Important Notes

- Cite conversation paths and line ranges for every memory-derived claim.
- Treat memory as historical evidence, not current truth. Verify drift-prone facts against the repo, runtime, or live system when cheap.
- If you answer from memory without current verification, say that briefly and note when it may be stale.
- Search results are usually enough. Use `read` for missing rationale, exact wording, or surrounding context.
- If search returns nothing, broaden terms once before concluding there is no useful memory.

## Further Reading

- [MCP-TOOLS.md](./MCP-TOOLS.md) - MCP tools API reference
- [search-conversation agent](../../agents/search-conversation.md) - Agent implementation details
