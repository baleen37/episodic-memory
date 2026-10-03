# Episodic Memory

Persistent conversation memory across Claude Code and Codex sessions. Search what you and
your agent discussed before, from inside the agent. Based on
[obra/episodic-memory](https://github.com/obra/episodic-memory).

## Install

Install the plugin from the marketplace. On first use the wrapper `bin/episodic-memory`
downloads the matching binary from the GitHub Release, verifies its sha256, and installs it to
`~/.config/episodic-memory/bin/episodic-memory-v<VER>`. No Bun, Node, or other runtime is needed.
Needs `curl`, `tar`, and `shasum` or `sha256sum`.

Supported platforms:

| OS | Arch |
|---|---|
| macOS | arm64 (Apple Silicon) |
| Linux | x86_64, aarch64 |

Intel Macs are not supported. On an unsupported platform the SessionStart hook prints a message
and exits 0; the MCP server fails to start.

## How It Works

- The SessionStart hook runs `episodic-memory sync`, which asks a background daemon to copy new
  transcript bytes into `~/.config/episodic-memory/conversation-archive/` and index them.
  Sources: Claude Code (`$CLAUDE_CONFIG_DIR/projects` and `$CLAUDE_CONFIG_DIR/transcripts`,
  default `~/.claude`) and Codex (`$CODEX_HOME/sessions`, default `~/.codex`).
- The index unit is one turn: a user message, the reply, and tool names.
- The daemon holds the embedding model (multilingual-e5-small) once for all sessions and exits
  after 10 idle minutes.
- Long-running sessions are indexed at the next SessionStart.

### MCP tools

**`search`**: hybrid keyword (BM25) and semantic search.

| Input | Description |
|---|---|
| `query` | string, or 2-5 strings (strict AND per conversation) |
| `limit` | default 10, max 50 |
| `after`, `before` | `YYYY-MM-DD`, interpreted in local time; result dates are local too |
| `project` | exact project name (git repository directory name) |

Ranking fuses keyword and semantic ranks, with a small bonus for the top three keyword hits so
an exact keyword match outranks a purely semantic one. With an array query, each concept
considers its top 300 candidates per side before the per-conversation AND.

Each result ends with `<archive_path>:<start>-<end>`. While the model is still loading, only
keyword ranking is used and the output says so.

**`read`**: `path` (archive file), `startLine`, `endLine`. Shows the archived user messages,
replies, and tool calls for that range. Output is capped at 60KB and ends with a marker giving
the `startLine` to continue from.

Typical flow: `search`, then `read` the best `archive_path:start-end`.

### Agent and skill

- `search-conversation` agent: searches, reads the relevant ranges, and returns a cited summary.
- `remembering-conversations` skill: tells Claude when to dispatch that agent.

### Diagnostics

`episodic-memory doctor` prints one `[ok]`, `[warn]` or `[fail]` line per check (binary, daemon,
DB, embeddings, model, source roots, last sync) and exits 1 if any check fails. It does not start the
daemon or create the database. The `doctor` skill runs it and explains each result.

### Exclusion

Put this in a user message to exclude the whole conversation:

```text
<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>
```

Only user messages are checked. The marker in tool output or replies is ignored, so reading
this file does not exclude your session. Already indexed turns of that conversation are removed
at the next sync. Such a conversation is also hidden from `read` (any generation). There is no masking of other content.

### Environment variables

| Variable | Effect |
|---|---|
| `EPISODIC_MEMORY_DIR` | data directory (default `~/.config/episodic-memory`) |
| `EPISODIC_MEMORY_DISABLE=1` | `sync` exits immediately |
| `EPISODIC_MEMORY_BIN` | wrapper runs this binary instead of the installed one |

### Storage

```text
~/.config/episodic-memory/
├── bin/                  # installed binaries, one per version
├── conversation-archive/ # copied transcripts (append-only)
├── episodic.db           # index
├── models/               # embedding model cache
└── logs/
```

## Codex

The plugin ships one `hooks/hooks.json` for both hosts. Codex Desktop does not load plugin hooks
([openai/codex#16430](https://github.com/openai/codex/issues/16430)); there, merge this into
`~/.codex/hooks.json` by hand (use the real plugin install path):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          { "type": "command", "command": "\"/path/to/episodic-memory/bin/episodic-memory\" sync" }
        ]
      }
    ]
  }
}
```

The MCP server and skills work without it; only automatic indexing needs the hook.

## Upgrading to 4.0.0

4.0.0 is a Rust rewrite. There is no LLM extraction and no setup step.

1. The old `~/.config/episodic-memory/conversation-index/conversations.db` is no longer used.
   You can delete it.
2. The existing `conversation-archive/` is reused as is.
3. On first start the daemon indexes the existing archive in the background and downloads the
   embedding model. Search is keyword-only until the model is ready.
   A large archive can take a while; progress survives restarts.
4. The Stop hook, the `setup` skill, and `config.json` LLM settings are removed. The `doctor`
   skill remains and now runs `episodic-memory doctor`.

## Development

```bash
cargo test                      # tests
cargo build --release           # binary
bats tests/wrapper.bats         # wrapper tests
EPISODIC_MEMORY_BIN=target/release/episodic-memory bin/episodic-memory mcp
```

Releases: semantic-release (conventional commits) bumps `Cargo.toml`, `Cargo.lock`, and both
`plugin.json` files, tags `vX.Y.Z`, then `release.yml` builds the three targets and uploads
`episodic-memory-v<VER>-<target>.tar.gz` and `.sha256` to the Release.

Design: `docs/superpowers/specs/2026-10-03-rust-episodic-memory-design.md`.
