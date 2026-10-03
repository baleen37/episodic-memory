---
name: doctor
description: Diagnose the health of the episodic-memory plugin. Invoke when episodic-memory search returns nothing, after upgrades, or when the user asks to check that episodic-memory is working.
---

# Doctor

Run:

```bash
"${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/bin/episodic-memory" doctor
```

Each line is `[ok]`, `[warn]` or `[fail]` followed by `name: detail`. Exit code 1 means at least one `fail`. Doctor only reads state; it never starts the daemon or creates the database.

Report every `warn` and `fail` line to the user with its cause and remedy.

| Line | Meaning | Remedy |
|---|---|---|
| `binary` warn, unsupported platform | Only Apple Silicon macOS and Linux (x86_64, aarch64) are supported | Nothing to fix; use a supported machine |
| `daemon` warn, not running | The daemon starts at SessionStart and exits after 10 idle minutes | Start a new session, then run doctor again |
| `daemon` warn, version differs | An old daemon survived an upgrade | Wait for it to idle out (10 minutes) or end the old `episodic-memory daemon` process |
| `db` warn, not created yet | No sync has ever run | Start a new session and wait for the first sync |
| `db` fail | The database file cannot be opened | Check permissions on the path shown; if corrupt, move it aside so the next sync rebuilds it from the archive |
| `embeddings` warn | Exchanges are waiting for embedding; search is keyword-only for them | Wait; if it persists, check `model` |
| `model` warn, loading | First run downloads the embedding model | Wait for the download to finish, then run doctor again |
| `model` warn, unknown | The daemon is not running, so the model state is unknown | Start a new session |
| `model` fail | The model failed to download or load | Check the network and disk space, then read the newest file in `~/.config/episodic-memory/logs/` |
| `source-roots` fail | None of the three transcript directories exist | Check `CLAUDE_CONFIG_DIR` and `CODEX_HOME` |
| `last-sync` warn, never | No sync has completed | Start a new session and wait |
| `last-sync` warn, last error | The most recent sync hit an error (the message is shown) | Read the logs directory for details; fix the file or condition named in the message |

If everything is `ok` and search is still empty, the query may simply not match anything indexed; try other wording.
