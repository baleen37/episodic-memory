# Memmem

Memmem - Persistent conversation memory across Claude Code and Codex sessions.

## Purpose

memmem syncs local Claude Code and Codex transcripts into an archive, extracts source-linked event/fact memory records, and exposes compact memory search plus archive line reading through CLI and MCP. It is based on [@obra/episodic-memory](https://github.com/obra/episodic-memory),
integrated into the Claude Code and Codex plugin ecosystems.

## Features

- **Transcript Sync**: Copies Claude Code and Codex transcripts into a local archive
- **Memory Search**: Searches indexed event/fact memory records
- **Semantic Search**: Vector embeddings for intelligent similarity matching
- **Text Search**: Fast exact-text matching for specific terms
- **Source Filtering**: Filter by source kind and date range
- **Archive Reading**: Archived transcript retrieval with line ranges
- **Inline Exclusion Markers**: Exclude sensitive conversations with `DO NOT INDEX THIS CHAT`
- **CLI Interface**: Direct CLI access for manual operations

## Agents

### `search-conversation`

Search indexed event/fact memory records. Use `read` with the returned archive path and line range when raw transcript evidence is needed.
Saves context by searching first and reading archive lines only when needed.

**The agent automatically:**

1. Searches event/fact memory records
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

Search indexed event/fact memory records. Use `read` with the returned archive path and line range when raw transcript evidence is needed.

**Parameters:**

- `query` (string, required): Search query
- `limit` (number, optional): Maximum results to return (1-50, default: 10)
- `before` (string, optional): Only memories before this date (YYYY-MM-DD)
- `after` (string, optional): Only memories after this date (YYYY-MM-DD)
- `source_kind` (string, optional): Filter to a source kind such as `claude-code-projects` or `codex-sessions`

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
3. Provides MCP tools for memory search and archive reading

## Runtime compatibility

memmem ships one shared runtime payload for Claude Code and Codex:

- `skills/`, `agents/`, and `hooks/`
- `.mcp.json`
- `bin/memmem`
- `dist/`

Runtime-specific metadata stays separate:

- Claude Code: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Codex: `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`

Claude Code and Codex update differently. In Claude Code, marketplace refresh and installed plugin update are part of the Claude plugin system, and plugin `version` is the update boundary. In Codex, `codex plugin marketplace upgrade` refreshes marketplace snapshots; installed plugin cache and enabled state are separate.

Maintainers should run the local compatibility preflight before release:

```bash
bun run compat:preflight
```

## How It Works

### Transcript Sync (SessionStart Hook)

When each Claude Code session starts (startup or resume), the hook (`hooks/hooks.json`) runs:

```bash
memmem sync
```

This:

1. Copies Claude Code and Codex transcripts into `~/.config/memmem/conversation-archive/`
2. Extracts source-linked event/fact memory records from changed archive files
3. Generates embeddings using Transformers.js
4. Stores memory record metadata and vectors in SQLite
5. Runs in background

### Storage Structure

```text
~/.config/memmem/
├── conversation-archive/     # Copied source transcripts
├── conversation-index/
│   └── conversations.db      # SQLite database with memory record embeddings
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

Archive sync and `read` do not require an LLM provider configuration. Memory extraction during indexing does require a configured LLM provider; without one, spans are skipped and no memory rows are created for those spans.

## Development

### Build

```bash
bun run build
```

Bundles:

- `src/cli/main.ts` → `dist/cli-internal.mjs` (CLI implementation)
- `src/mcp/server.ts` → `dist/mcp-server.mjs` (MCP server)
- `src/cli-graceful.mjs` → `bin/memmem` (graceful wrapper executable; routes `mcp`/`sync`/etc. into the CLI bundle)

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

# Search indexed event/fact memory records
memmem search "what did we decide about memory records?"
```

Expected output example:

```md
## [event, claude-code-projects, 2026-06-01] memmem
The user decided to remove exchange as the primary concept and use event/fact memory records.
Source: /path/to/archive.jsonl:120-124
```

```bash
# Read archived transcript lines
memmem read /path/to/archive.jsonl --start-line 1 --end-line 20

# Print memory index statistics
memmem stats

# Verify memory index integrity
memmem verify
```

### Project Structure

```text
plugins/memmem/
├── .claude-plugin/
│   ├── marketplace.json         # Marketplace release metadata
│   └── plugin.json              # Claude Code plugin metadata
├── .codex-plugin/
│   └── plugin.json              # Codex plugin metadata and MCP registration
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
│   │   ├── read.ts              # Read command
│   │   ├── stats.ts             # Stats command
│   │   ├── verify.ts            # Verify command
│   │   ├── doctor.ts            # Doctor command
│   │   └── mcp.ts               # MCP subcommand (spawns MCP server)
│   └── mcp/
│       └── server.ts            # MCP server (search, read tools)
├── bin/
│   └── memmem                   # Graceful wrapper executable (entrypoint)
├── dist/
│   ├── cli-internal.mjs         # Bundled CLI implementation
│   └── mcp-server.mjs           # Bundled MCP server
├── scripts/
│   ├── build.mjs                # Bun.build config
│   └── lib/
│       └── check-dependencies.mjs  # Shared dependency-check logic
├── package.json
├── tsconfig.json
└── README.md
```

## Dependencies

### Runtime

- Bun runtime with `bun:sqlite` for SQLite access
- `@modelcontextprotocol/sdk`: MCP protocol implementation
- `@huggingface/transformers`: Xenova/multilingual-e5-small embeddings
- `sqlite-vec`: Vector similarity search extension
- `zod`: Schema validation
- `marked`: Markdown rendering

### Development Dependencies

- `typescript`: Type checking
- `bun-types`: Bun runtime and test types

## Upgrading to the memory record index

**IMPORTANT**: This release is a breaking local index change. The pre-memory-record database is not compatible
with the memory record schema. Delete the old database before rebuilding the index.

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

The plugin automatically installs dependencies on first run using Bun. If you encounter errors:

#### Permission Denied (EACCES)

**Symptoms:** Error messages containing "EACCES" or "permission denied"

**Fix:** Check permissions for the project directory and Bun cache, then retry:

```bash
cd plugins/memmem
bun install
```

Then restart Claude Code.

#### Network Errors (ETIMEDOUT, ECONNRESET, ENOTFOUND)

**Symptoms:** Timeout or connection errors during dependency installation

**Fix:**

1. Check your internet connection.
2. If behind a corporate firewall, configure registry or proxy access in your environment.
3. Try installing manually:

   ```bash
   cd plugins/memmem
   bun install
   ```

#### Disk Space Full (ENOSPC)

**Symptoms:** Error messages containing "ENOSPC"

**Fix:**

1. Check available disk space: `df -h`.
2. Free up disk space or clear Bun's cache if needed.
3. Reinstall dependencies:

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
- **Embedding Model**: `Xenova/multilingual-e5-small`
  - 384 dimensions
  - Loaded through `@huggingface/transformers`
  - Uses query/passage prefix routing for search and indexed memory records
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
