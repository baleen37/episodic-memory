# Episodic Memory

Episodic Memory - Persistent conversation memory across Claude Code and Codex sessions.

## Purpose

Episodic Memory syncs local Claude Code and Codex transcripts into an archive, extracts event/fact memory records, and exposes scoped memory search through CLI and MCP. It is based on [@obra/episodic-memory](https://github.com/obra/episodic-memory),
integrated into the Claude Code and Codex plugin ecosystems.

## Features

- **Transcript Sync**: Copies Claude Code and Codex transcripts into a local archive
- **Memory Search**: Searches indexed event/fact memory records
- **Semantic Search**: Vector embeddings for intelligent similarity matching
- **Text Search**: Fast exact-text matching for specific terms
- **Local Scope**: Keeps CLI and MCP search scoped to this machine's memory
- **Inline Exclusion Markers**: Exclude sensitive conversations with `DO NOT INDEX THIS CHAT`
- **CLI Interface**: Direct CLI access for manual operations

## Agents

### `search-conversation`

Search indexed event/fact memory records. The MCP surface exposes read-only `search` and `read` tools: `search` returns compact cards, and `read` expands selected records.

**The agent automatically:**

1. Searches event/fact memory records
2. Interprets the returned memory text and metadata
3. Synthesizes findings into a concise summary
4. Returns actionable insights with record identifiers

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

### `episodic-memory__search` and `episodic-memory__read`

Search indexed event/fact memory records.

**Parameters:**

- `query` (string | string[], required): Search query. Use a string for normal search, or an array of 2-5 strings for strict AND search; only records matching every query are returned.
- `limit` (number, optional): Maximum results to return (1-50, default: 10)

**Example:**

```javascript
{ query: "React Router authentication errors", limit: 10 }
```

For strict multi-query search, pass 2-5 query strings. The results are the
intersection of the individual searches, ranked by mean score. An empty
intersection returns no results; it does not fall back to OR search.

```javascript
{ query: ["React Router", "authentication", "JWT"], limit: 10 }
```

`search` returns `{ results }` cards with a compact id, text, date, and rounded
score. Use `read` to retrieve selected records, in the requested order:

```javascript
{ ids: ["e_...", "e_..."] }
```

The `read` response is `{ results, missing }`. Canonical UUIDs remain accepted
for direct compatibility, while public search results use compact aliases.

## Installation

```bash
# Install dependencies
cd plugins/episodic-memory
bun install

# Build the plugin
bun run build
```

The plugin automatically:

1. Creates `~/.config/episodic-memory/` directory
2. Syncs and indexes transcripts via the SessionStart hook
3. Provides the MCP memory search tool

## Runtime compatibility

Episodic Memory ships one shared runtime payload for Claude Code and Codex:

- `skills/`, `agents/`, and `hooks/`
- `.mcp.json`
- `bin/episodic-memory`
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
episodic-memory sync
```

This:

1. Copies Claude Code and Codex transcripts into `~/.config/episodic-memory/conversation-archive/`
2. Extracts event/fact memory records from changed archive files
3. Generates embeddings using Transformers.js
4. Stores memory record metadata and vectors in SQLite
5. Runs in background

### Storage Structure

```text
~/.config/episodic-memory/
├── conversation-archive/     # Copied source transcripts
├── conversation-index/
│   └── conversations.db      # SQLite database with memory record embeddings
└── config.json               # User settings (optional)
```

### Exclusion

There are two ways to exclude conversations from indexing:

**1. Directory-level exclusion:**

Create a `.no-episodic-memory` marker file in the conversation directory:

```bash
touch /path/to/conversation/dir/.no-episodic-memory
```

**2. Inline content exclusion:**

Include one of these markers anywhere in the conversation content:

- `DO NOT INDEX THIS CHAT`
- `DO NOT INDEX THIS CONVERSATION`
- `이 대화는 인덱싱하지 마세요` (Korean)
- `이 대화는 검색에서 제외하세요` (Korean)

The entire conversation will be excluded from indexing when any of these markers are detected.

### Configuration

Create `~/.config/episodic-memory/config.json` to customize rate limits:

```json
{
  "ratelimit": {
    "embedding": { "requestsPerSecond": 5, "burstSize": 10 }
  }
}
```

Archive sync does not require an LLM provider configuration. Memory extraction during indexing does require a configured LLM provider; without one, archives are copied but no memory rows are created.

## Development

### Build

```bash
bun run build
```

Bundles:

- `src/cli/main.ts` → `dist/cli-internal.mjs` (CLI implementation)
- `src/mcp/server.ts` → `dist/mcp-server.mjs` (MCP server)
- `src/cli-graceful.mjs` → `bin/episodic-memory` (graceful wrapper executable; routes `mcp`/`sync`/etc. into the CLI bundle)

### Type Check

```bash
bun run typecheck
```

### CLI Usage

The plugin provides a CLI interface for manual operations:

```bash
# Show help
episodic-memory --help

# Copy and index transcripts
episodic-memory sync

# Search indexed event/fact memory records
episodic-memory search "what did we decide about memory records?"
```

Expected output example:

```text
1. [0.82] The user decided to use event/fact memory records.
   id: memory-id
```

```bash
# Print memory index statistics
episodic-memory stats

# Verify memory index integrity
episodic-memory verify
```

### Project Structure

```text
plugins/episodic-memory/
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
│   │   ├── sync-run.ts          # Archive indexing policy
│   │   ├── memory/              # Memory extraction, storage, and search
│   │   ├── constants.ts         # Shared scope and embedding constants
│   │   └── sources/             # Claude Code and Codex adapters
│   ├── cli/                     # CLI commands
│   │   ├── sync.ts              # Sync command
│   │   ├── search.ts            # Search command
│   │   ├── stats.ts             # Stats command
│   │   ├── verify.ts            # Verify command
│   │   ├── doctor.ts            # Doctor command
│   │   └── mcp.ts               # MCP subcommand (spawns MCP server)
│   └── mcp/
│       ├── handlers.ts          # MCP search handler
│       └── server.ts            # MCP server (search tool)
├── bin/
│   └── episodic-memory          # Graceful wrapper executable (entrypoint)
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
cp ~/.config/episodic-memory/conversation-index/conversations.db \
   ~/.config/episodic-memory/conversation-index/conversations.db.backup

# 2. Remove old database
rm ~/.config/episodic-memory/conversation-index/conversations.db

# 3. Reinstall plugin dependencies
cd plugins/episodic-memory
bun install

# 4. Rebuild plugin
bun run build

# 5. Rebuild the local transcript index
episodic-memory sync
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
cd plugins/episodic-memory
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
   cd plugins/episodic-memory
   bun install
   ```

#### Disk Space Full (ENOSPC)

**Symptoms:** Error messages containing "ENOSPC"

**Fix:**

1. Check available disk space: `df -h`.
2. Free up disk space or clear Bun's cache if needed.
3. Reinstall dependencies:

   ```bash
   cd plugins/episodic-memory
   rm -rf node_modules
   bun install
   ```

### Manual Installation

If automatic installation fails repeatedly, install dependencies manually:

```bash
cd plugins/episodic-memory
bun install
bun run build
```

## Architecture Notes

- **Standalone Plugin**: Complete implementation (not a wrapper)
- **Based on @obra/episodic-memory**: Forked and integrated into Claude Code plugin ecosystem
- **Storage Location**: `~/.config/episodic-memory/` (not `.claude/`)
- **Naming**: All public interfaces use `episodic-memory` for clarity
- **Embedding Model**: `Xenova/multilingual-e5-small`
  - 384 dimensions
  - Loaded through `@huggingface/transformers`
  - Uses query/passage prefix routing for search and indexed memory records
  - Stored in `sqlite-vec` virtual tables

## Future Enhancements

- Slash commands: `/episodic-memory search`, `/episodic-memory stats`
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
