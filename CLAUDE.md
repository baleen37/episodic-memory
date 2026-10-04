# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

# episodic-memory

## Purpose

Persistent conversation memory across Claude Code and Codex sessions. A Rust binary archives
local transcripts, indexes them per conversation turn (exchange), and serves hybrid
BM25 + vector search and archive reading over MCP. Shipped as a plugin; a bash wrapper downloads
the release binary. Design spec: `docs/superpowers/specs/2026-10-03-rust-episodic-memory-design.md`.

## Commands

```bash
source ~/.cargo/env              # if cargo is not on PATH
cargo test                       # unit + integration tests (no model download)
cargo test -- --ignored          # embedding tests (downloads e5-small; set FASTEMBED_CACHE_DIR)
cargo build --release            # release binary at target/release/episodic-memory
cargo fmt --check
cargo clippy --all-targets -- -D warnings
bats tests/wrapper.bats          # bash wrapper tests (stubbed uname/curl, no network)
```

## Key Files

| File | Description |
| ---- | ----------- |
| `src/main.rs` | CLI entry: subcommands `sync`, `mcp`, `daemon`, `doctor` |
| `src/paths.rs` | Data dir, archive/db/log/socket paths, source roots (reads env values once) |
| `src/db.rs` | SQLite schema (`files`, `exchanges`, `fts_exchanges`, `vec_exchanges`, `meta`), `delete_exchanges_from` |
| `src/archive.rs` | Append-only archive copy, rewrite detection, generations, import of existing archive |
| `src/parse/{mod,claude,codex}.rs` | Transcript parsers: exchange boundaries, exclusion rules, tools, DO NOT INDEX |
| `src/project.rs` | project name = git common-dir parent directory name |
| `src/terms.rs` | FTS terms and query building (Hangul bigrams, quoting) |
| `src/sync.rs` | Sync orchestration per file, then embedding pass |
| `src/embed.rs` | fastembed multilingual-e5-small (384-dim), passage/query prefixes |
| `src/search.rs` | BM25 + KNN (cosine floor `MIN_VECTOR_SIMILARITY`), weighted RRF (K=60, 0.4/0.6), absolute 0-1 scores, array AND query |
| `src/read.rs` | Archive line reader (markdown render, 4KB per item, 60KB cap, continue marker) |
| `src/mcp.rs` | MCP JSON-RPC tools `search` and `read` |
| `src/host.rs` | Session id of the Claude Code / Codex process behind an MCP connection (search excludes it) |
| `src/daemon.rs` | Singleton daemon: unix socket, model, sync jobs, idle exit |
| `src/client.rs` | `sync` hook client and `mcp` stdio-to-socket bridge; starts daemon if absent |
| `src/doctor.rs` | `doctor`: read-only health checks (daemon via `{"client":"status"}`, DB opened read-only), `[ok]/[warn]/[fail]` lines, exit 1 on fail |
| `src/log.rs` | Logging to `<data>/logs/` |
| `bin/episodic-memory` | Bash wrapper: finds or downloads the versioned binary, then execs it |
| `scripts/sync-versions.sh` | Writes the release version into Cargo.toml, Cargo.lock, both plugin.json |
| `hooks/hooks.json` | SessionStart (`startup\|resume\|clear\|compact`) runs `episodic-memory sync` |
| `.github/workflows/release.yml` | semantic-release, then per-target build and asset upload, then marketplace notify |

## Data Flow

```text
SessionStart hook -> bin/episodic-memory sync -> daemon (started detached if absent), exit 0
MCP client        -> bin/episodic-memory mcp  -> unix socket -> daemon (search, read)
daemon sync job   -> discover *.jsonl under source roots (stat size only)
                  -> append new bytes to conversation-archive/<source_kind>/<rel path>
                  -> parse archive from reparse_line into exchanges (FTS terms inline)
                  -> embed pending exchanges (8 per batch) into vec_exchanges
```

- The archive is the source of truth; `read` renders archive text, never the host transcript.
- Source roots: `$CLAUDE_CONFIG_DIR/projects`, `$CLAUDE_CONFIG_DIR/transcripts`, `$CODEX_HOME/sessions`
  (`CLAUDE_CONFIG_DIR` defaults to `~/.claude`, `CODEX_HOME` to `~/.codex`).
- A rewritten source starts a new archive generation (`<name>.gen-N.jsonl`); the old file is kept.
- One daemon per version (`daemon-{VER}.sock/.lock`); one sync at a time (`sync.lock`).
- Before the model is ready, search is BM25-only and says so.

## Pitfalls

- Never commit real transcripts or content copied from them. Test fixtures are synthetic.
- The archive is append-only. Never rewrite, truncate (except to `offset` for crash repair), or delete archive files.
- `delete_exchanges_from` in `src/db.rs` is the only way to delete exchanges. It clears `fts_exchanges` and `vec_exchanges` first because virtual tables have no FKs.
- Env vars are limited to three: `EPISODIC_MEMORY_DIR` (data dir, tests), `EPISODIC_MEMORY_DISABLE=1` (sync no-op), `EPISODIC_MEMORY_BIN` (wrapper override). Do not add more.
- Tests must not mutate process env; pass values as parameters.
- `sync` always exits 0; errors go to `logs/`.
- Do not touch `~/.config/episodic-memory` from tests; use `EPISODIC_MEMORY_DIR` with a temp dir.
- The wrapper reads the version from `.claude-plugin/plugin.json`; release bumps it via `scripts/sync-versions.sh`.
