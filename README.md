# Memmem

Memmem - Conversation memory with transcript search across Claude Code and Codex sessions.

## Purpose

Gives Claude persistent memory across sessions by archiving local transcripts, indexing transcript exchanges,
and providing semantic/text search plus transcript reading. Based on [@obra/episodic-memory](https://github.com/obra/episodic-memory)
with integration into the Claude Code plugin ecosystem.

## Features

- **Transcript Sync**: Copies Claude Code and Codex transcripts into a local archive
- **Exchange Search**: Searches indexed user/assistant transcript exchanges
- **Semantic Search**: Vector embeddings for intelligent similarity matching
- **Text Search**: Fast exact-text matching for specific terms
- **Source Filtering**: Filter by source kind and date range
- **Conversation Reading**: Archived transcript retrieval with line ranges
- **Inline Exclusion Markers**: Exclude sensitive conversations with `DO NOT INDEX THIS CHAT`
- **CLI Interface**: Direct CLI access for manual operations

## Agents

### `search-conversation`

Specialized agent for searching and synthesizing conversation history from indexed transcript exchanges.
Saves context by searching first and reading archive lines only when needed.

**The agent automatically:**

1. Searches transcript exchanges
2. Reads raw transcript lines only if needed
3. Synthesizes findings into a concise summary
4. Returns actionable insights with sources

**Always use the agent instead of MCP tools directly** to avoid wasting context.

See `agents/search-conversation.md` for implementation details.

## Skills

### `remembering-conversations`

A skill that guides Claude to search conversation history before reinventing solutions or repeating mistakes.

**Core principle:** Always dispatch the search-conversation agent. Never use MCP tools directly.

**When to use:**

- User asks "how should I..." or "what's the best approach..."
- You're stuck after investigating a problem
- User references past work ("last time", "we discussed", etc.)
- Need to follow an unfamiliar workflow

**What it does:**

- Forces agent delegation (YOU MUST dispatch search-conversation agent)
- Prevents direct MCP tool usage (wastes context)
- Saves 50-100x context vs. loading raw conversations

See `skills/remembering-conversations/SKILL.md` for complete usage guide.

## MCP Tools

These tools are exposed for advanced usage.

### `memmem__search`

Searches indexed transcript exchanges.

**Parameters:**

- `query` (string, required): Search query
- `limit` (number, optional): Maximum results to return (1-50, default: 10)
- `before` (string, optional): Only conversations before this date (YYYY-MM-DD)
- `after` (string, optional): Only conversations after this date (YYYY-MM-DD)
- `source_kind` (string, optional): Filter to a source kind such as `claude-projects` or `codex-sessions`

**Example:**

```javascript
{ query: "React Router authentication errors", after: "2026-05-01" }
```

### `memmem__read`

Reads archived transcript lines.

**Parameters:**

- `path` (string, required): Archive path from search results
- `startLine` (number, optional): Starting line number (1-indexed)
- `endLine` (number, optional): Ending line number (1-indexed)

## Installation

```bash
# Install dependencies
cd plugins/memmem
bun install

# Build the plugin
bun run build
```

The plugin automatically:

1. Creates `~/.config/memmem/` directory
2. Syncs and indexes transcripts via the SessionStart hook
3. Provides MCP tools for transcript search and reading

## How It Works

### Transcript Sync (SessionStart Hook)

When each Claude Code session starts (startup or resume), the hook (`hooks/hooks.json`) runs:

```bash
memmem sync
```

This:

1. Copies Claude Code and Codex transcripts into `~/.config/memmem/conversation-archive/`
2. Reindexes changed archive files into transcript exchanges
3. Generates embeddings using Transformers.js
4. Stores exchange metadata and vectors in SQLite
5. Runs in background

### Storage Structure

```text
~/.config/memmem/
├── conversation-archive/     # Copied source transcripts
├── conversation-index/
│   └── conversations.db      # SQLite database with exchange embeddings
└── config.json               # User settings (optional)
```

### Exclusion

There are two ways to exclude conversations from indexing:

**1. Directory-level exclusion:**

Create a `.no-memmem` marker file in the conversation directory:

```bash
touch /path/to/conversation/dir/.no-memmem
```

**2. Inline content exclusion:**

Include one of these markers anywhere in the conversation content:

- `DO NOT INDEX THIS CHAT`
- `DO NOT INDEX THIS CONVERSATION`
- `이 대화는 인덱싱하지 마세요` (Korean)
- `이 대화는 검색에서 제외하세요` (Korean)

The entire conversation will be excluded from indexing when any of these markers are detected.

### Configuration

Create `~/.config/memmem/config.json` to customize rate limits:

```json
{
  "ratelimit": {
    "embedding": { "requestsPerSecond": 5, "burstSize": 10 }
  }
}
```

Transcript indexing does not require an LLM provider configuration.

## Development

### Build

```bash
bun run build
```

Bundles:

- `src/cli/main.ts` → `dist/cli-internal.mjs` (CLI implementation)
- `src/cli-graceful.mjs` → `dist/cli.mjs` (Bun CLI wrapper)
- `src/mcp/server.ts` → `dist/mcp-server.mjs` (MCP server)
- `scripts/mcp-server-wrapper.mjs` → `dist/mcp-wrapper.mjs` (Bun MCP wrapper)

### Type Check

```bash
bun run typecheck
```

### CLI Usage

The plugin provides a CLI interface for manual operations:

```bash
# Show help
memmem --help

# Copy and index transcripts
memmem sync

# Search indexed transcript exchanges
memmem search "query"

# Read archived transcript lines
memmem read /path/to/archive.jsonl --start-line 1 --end-line 20
```

### Project Structure

```text
plugins/memmem/
├── .claude-plugin/
│   └── plugin.json              # Plugin metadata
├── .mcp.json                     # MCP server registration
├── hooks/
│   └── hooks.json               # Auto-sync on session start (startup|resume)
├── src/
│   ├── core/                    # Core library
│   │   ├── indexer.ts           # Archive file indexing
│   │   ├── search.ts            # Semantic + text search
│   │   ├── db.ts                # SQLite + vector schema
│   │   └── sources/             # Claude Code and Codex adapters
│   ├── cli/                     # CLI commands
│   │   ├── sync.ts              # Sync command
│   │   ├── search.ts            # Search command
│   │   └── read.ts              # Read command
│   └── mcp/
│       └── server.ts            # MCP server (search, read tools)
├── dist/
│   ├── mcp-server.mjs           # Bundled MCP server
│   ├── mcp-wrapper.mjs          # Cross-platform wrapper
│   └── cli.mjs                  # Bundled CLI (for hooks)
├── scripts/
│   ├── build.mjs                # esbuild config
│   └── mcp-server-wrapper.mjs   # Wrapper script
├── package.json
├── tsconfig.json
└── README.md
```

## Dependencies

### Runtime

- Bun runtime with `bun:sqlite` for SQLite access
- `@modelcontextprotocol/sdk`: MCP protocol implementation
- `@huggingface/transformers`: gte-small embeddings
- `sqlite-vec`: Vector similarity search extension
- `zod`: Schema validation
- `marked`: Markdown rendering

### Development Dependencies

- `typescript`: Type checking
- `bun-types`: Bun runtime and test types

## Upgrading to the transcript index

**IMPORTANT**: This release is a breaking local index change. The old observation database is not compatible
with the transcript exchange schema. Delete the old database before rebuilding the index.

### Migration Steps

```bash
# 1. Backup existing database (optional)
cp ~/.config/memmem/conversation-index/conversations.db \
   ~/.config/memmem/conversation-index/conversations.db.backup

# 2. Remove old database
rm ~/.config/memmem/conversation-index/conversations.db

# 3. Reinstall plugin dependencies
cd plugins/memmem
bun install

# 4. Rebuild plugin
bun run build

# 5. Rebuild the local transcript index
memmem sync
```

**First sync timing**:

- Model download happens once and is cached locally
- Reindexing time varies by transcript count
- Initial ONNX runtime warmup can take several seconds

## Troubleshooting

### Installation Errors

The plugin automatically installs dependencies on first run. If you encounter errors:

#### Permission Denied (EACCES)

**Symptoms:** Error messages containing "EACCES" or "permission denied"

**Fix:**

```bash
sudo chown -R $(whoami) ~/.npm
```

Then restart Claude Code.

#### Network Errors (ETIMEDOUT, ECONNRESET, ENOTFOUND)

**Symptoms:** Timeout or connection errors during dependency installation

**Fix:**

1. Check your internet connection
2. If behind a corporate firewall, configure npm proxy:

   ```bash
   npm config set proxy http://your-proxy:port
   npm config set https-proxy http://your-proxy:port
   ```

3. Try installing manually:

   ```bash
   cd plugins/memmem
   bun install
   ```

#### Disk Space Full (ENOSPC)

**Symptoms:** Error messages containing "ENOSPC"

**Fix:**

1. Check available disk space: `df -h`
2. Free up space by cleaning npm cache:

   ```bash
   npm cache clean --force
   ```

3. Remove old node_modules:

   ```bash
   cd plugins/memmem
   rm -rf node_modules
   bun install
   ```

### Manual Installation

If automatic installation fails repeatedly, install dependencies manually:

```bash
cd plugins/memmem
bun install
bun run build
```

## Architecture Notes

- **Standalone Plugin**: Complete implementation (not a wrapper)
- **Based on @obra/episodic-memory**: Forked and integrated into Claude Code plugin ecosystem
- **Storage Location**: `~/.config/memmem/` (not `.claude/`)
- **Naming**: All public interfaces use `memmem` for clarity
- **Embedding Model**: `Supabase/gte-small`
  - 384 dimensions
  - Loaded through `@huggingface/transformers`
  - Stored in `sqlite-vec` virtual tables

## Future Enhancements

- Slash commands: `/memmem search`, `/memmem stats`
- Conversation tagging/categorization
- Export/import functionality
- Web UI for browsing history
- Integration with other plugins (e.g., context-restore)

## References

- Original project: [episodic-memory](https://github.com/obra/episodic-memory)
- MCP Protocol: [Model Context Protocol](https://modelcontextprotocol.io)
- Claude Code: [anthropics/claude-code](https://github.com/anthropics/claude-code)

## License

MIT
