---
name: remembering-conversations
description: Use when user asks 'how should I...' or 'what's the best approach...' after exploring code, OR when you've tried to solve something and are stuck, OR for unfamiliar workflows, OR when user references past work. Searches conversation history using indexed event/fact memory records.
version: 1.0.0
---

# Remembering Conversations

**Core principle:** Search before reinventing. Searching costs little; repeating past mistakes is expensive.

## Mandatory: Use the Search Agent

**YOU MUST dispatch the search-conversation agent for historical conversation search.**

Announce: "Dispatching search agent to find [topic]."

Then use the Task tool with `subagent_type: "search-conversation"`:

```text
Task tool:
  description: "Search past conversations for [topic]"
  prompt: "Search for [specific query or topic]. Focus on [decisions, patterns, gotchas, code examples]."
  subagent_type: "search-conversation"
```

The agent will:

1. Search indexed event/fact memory records with `search`. Use `read` with the returned archive path and line range when raw transcript evidence is needed.
2. Read archived transcript lines with `read` only when memory records are not enough.
3. Synthesize concise findings.
4. Return actionable insights with `archive_path:line_start-line_end` sources.

## When to Use

Search memory after you understand the task in these situations:

- User asks "how should I..." or "what's the best approach..."
- You've explored the current codebase and need architectural context
- You're stuck after investigating a problem
- You need to follow an unfamiliar workflow or process
- User references past work: "last time", "before", "we discussed", "do you remember"

## Don't Search First

- For current codebase structure; use file search/read tools first.
- For information already present in the current conversation.
- Before understanding what the user is asking.

## Direct Tool Access (Discouraged)

Prefer the search-conversation agent. If direct MCP access is necessary:

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

- Always cite conversation paths and line ranges.
- Past decisions may not apply directly; explain context before recommending reuse.
- Search results are usually enough; use `read` for missing rationale or surrounding context.

## Further Reading

- [MCP-TOOLS.md](./MCP-TOOLS.md) - MCP tools API reference
- [search-conversation agent](../../agents/search-conversation.md) - Agent implementation details
