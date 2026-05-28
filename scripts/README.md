# Scripts Directory

Build and wrapper scripts for the memmem plugin.

## Overview

This directory contains scripts for:

- Building the plugin with Bun.build
- Wrapping executables with dependency and build checks

## Files

### build.mjs

Main Bun build script that bundles the CLI and MCP server into standalone files.

**Usage:**

```bash
bun run build
# or directly:
bun scripts/build.mjs
```

**Output:**

- `dist/cli-internal.mjs` - Bundled CLI implementation
- `dist/cli.mjs` - Bun CLI wrapper copied from `src/cli-graceful.mjs`
- `dist/mcp-server.mjs` - Bundled MCP server
- `dist/mcp-wrapper.mjs` - Bun MCP wrapper copied from `scripts/mcp-server-wrapper.mjs`
- `dist/lib/check-dependencies.mjs` - Shared dependency logic

**External Dependencies (not bundled):**

The following packages/runtime modules are marked as external and must be available at runtime:

- `@huggingface/transformers` - Embedding model
- `bun:sqlite` - SQLite database access from the Bun runtime
- `sharp` - Image processing dependency used by transformer tooling
- `onnxruntime-node` - ONNX runtime for ML models
- `sqlite-vec` - Vector similarity search

### mcp-server-wrapper.mjs

Bun wrapper script for the MCP server that ensures dependencies are installed and the build is up-to-date before starting.

**Usage:**

```bash
# Typically invoked via Claude Code MCP configuration:
bun scripts/mcp-server-wrapper.mjs
```

**Behavior:**

1. Checks if dependencies are installed.
2. If missing, runs `bun install` with progress output.
3. Checks if `dist/mcp-server.mjs` exists or is outdated.
4. If needed, runs `bun run build`.
5. Spawns the actual MCP server with Bun (`dist/mcp-server.mjs`).
6. Forwards signals (SIGTERM, SIGINT) to the child process.
7. Exits with the same exit code as the child.

**Error Handling:**

- Provides helpful error messages for common issues:
  - Permission denied -> Check project directory and Bun cache permissions
  - Disk space full -> Free up disk space or clear Bun cache
  - Network errors -> Check registry/proxy access and internet connection

### lib/check-dependencies.mjs

Shared dependency checking logic used by both CLI and MCP wrappers.

**Exports:**

```javascript
// Check if dependencies are installed
checkDependencies() -> { installed: boolean, missing: string[] }

// Check if build is needed
checkBuildNeeded() -> { needsBuild: boolean, reason: string }

// Install dependencies with Bun (returns Promise)
installDependencies(silent: boolean) -> Promise<void>

// Run build with Bun (returns Promise)
runBuild() -> Promise<void>

// Analyze Bun/runtime errors and suggest fixes
analyzeError(error: Error) -> { cause: string, fix: string }
```

**Usage Example:**

```javascript
import { checkDependencies, installDependencies } from './lib/check-dependencies.mjs';

const { installed, missing } = checkDependencies();
if (!installed) {
  await installDependencies(false); // with output
}
```

---

## Two-Layer Wrapper Pattern

The plugin uses a two-layer wrapper pattern for both CLI and MCP server to ensure dependencies are available without surprising startup failures.

### Layer 1: Graceful Wrapper

The outer layer that handles missing dependencies gracefully.

**CLI Wrapper (`src/cli-graceful.mjs` -> `dist/cli.mjs`):**

```text
User runs: cli.mjs (Bun wrapper)
    |
    v
Check dependencies
    |
    +-- Not installed --> Trigger background bun install
    |
    v
Import cli-internal.mjs (actual CLI)
    |
    +-- missing module --> Show helpful error, exit 1
    |
    v
CLI runs normally
```

**Key difference from MCP:** CLI triggers background install and continues. This prevents blocking the user while still ensuring dependencies will be ready for the next run.

### Layer 2: Blocking Wrapper

The inner layer used by MCP server that blocks until ready.

**MCP Wrapper (`scripts/mcp-server-wrapper.mjs` -> `dist/mcp-wrapper.mjs`):**

```text
Claude Code starts MCP server
    |
    v
mcp-wrapper.mjs (Bun blocking wrapper)
    |
    v
Check dependencies
    |
    +-- Not installed --> Run bun install (blocking, with progress)
    |
    v
Check if build needed
    |
    +-- Outdated/missing --> Run bun run build (blocking)
    |
    v
Spawn mcp-server.mjs with Bun (actual MCP server)
    |
    v
Forward signals, exit with child's code
```

**Key difference from CLI:** MCP wrapper blocks until ready because the MCP server must be functional before Claude Code can use it.

### Why Two Patterns?

| Aspect | CLI Wrapper | MCP Wrapper |
| ------ | ----------- | ----------- |
| Blocking | Non-blocking | Blocking |
| Install | Background | Foreground with progress |
| Build check | None | Checks if rebuild needed |
| Error handling | Show error, exit | Detailed error analysis |
| Use case | User commands | Claude Code integration |

**CLI** needs to be responsive. Users typing commands expect immediate feedback even if dependencies are missing.

**MCP** must be fully functional. Claude Code expects the MCP server to work correctly on first call.

### Benefits of the Wrapper Pattern

1. **Zero-Config First Run**: Plugin works after clone without manual `bun install`.
2. **Auto-Rebuild**: MCP wrapper detects when rebuild is needed (for example, after `git pull`).
3. **Cross-Platform**: Works on Windows, macOS, and Linux where Bun is available.
4. **Helpful Errors**: Translates common runtime errors into actionable suggestions.
5. **Graceful Degradation**: CLI continues even with missing dependencies and shows a helpful message.

### Implementation Notes

**Environment Variable:**

Both wrappers respect `CLAUDE_PLUGIN_ROOT` for finding the plugin root directory. This allows wrappers to work when copied to `dist/` for cached plugins.

```javascript
const ROOT = process.env.CLAUDE_PLUGIN_ROOT || resolve(__dirname, '..');
```

**Signal Forwarding:**

The MCP wrapper forwards termination signals to the child process:

```javascript
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
```

This ensures clean shutdown when Claude Code terminates.

**Error Analysis:**

The `analyzeError()` function translates common Bun/runtime errors:

| Error Code | Cause | Suggested Fix |
| ---------- | ----- | ------------- |
| EACCES | Permission denied | Check project directory and Bun cache permissions |
| ENOSPC | Disk space full | Free up disk space or clear Bun cache |
| ETIMEDOUT | Network error | Check internet connection or registry/proxy access |
| ECONNRESET | Network error | Check internet connection or registry/proxy access |
