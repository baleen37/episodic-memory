---
name: remembering-conversations
description: Use when user asks 'how should I...' or 'what's the best approach...' after exploring code, OR when you've tried to solve something and are stuck, OR for unfamiliar workflows, OR when user references past work. Searches past Claude Code and Codex conversations (hybrid keyword and semantic search).
version: 2.0.0
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

1. Run `search` to find matching conversation turns.
2. Run `read` on the most relevant `archive_path:start-end` results for detail.
3. Return a concise synthesis, citing `archive_path:start-end` for each claim.

## When to Use

Search after you understand the task in these situations:

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

```json
{ "query": "React Router authentication errors", "limit": 10, "project": "my-repo", "after": "2026-01-01" }
```

Then open a result with `read`, passing the result's `archive_path` as `path`
and its line range as `startLine` / `endLine`:

```json
{ "path": "/home/me/.config/episodic-memory/conversation-archive/claude-code-projects/x/abc.jsonl", "startLine": 120, "endLine": 148 }
```

## Search Strategy

1. Start broad, then narrow with more specific terms.
2. Put exact error codes, file names, and identifiers in the query.
3. Pass 2-5 concepts as an array for a strict AND search across a conversation.
4. Narrow with `project`, `after`, `before` (`YYYY-MM-DD`) when the scope is known.
5. `read` a result's line range before relying on its snippet.

## Important Notes

- Cite `archive_path:start-end` for the sources you relied on.
- Past decisions may not apply directly; explain context before recommending reuse.
- A leading note in search output means the semantic model is still loading and only keyword ranking was used.

## Further Reading

- [MCP-TOOLS.md](./MCP-TOOLS.md) - MCP tools API reference
- [search-conversation agent](../../agents/search-conversation.md) - Agent implementation details
