# Scripts Directory

Build and dependency-check helpers for the memmem plugin.

## Files

### build.mjs

Main Bun build script that bundles the CLI and MCP server, and produces the `bin/memmem` entrypoint executable.

**Usage:**

```bash
bun run build
# or directly:
bun scripts/build.mjs
```

**Output:**

- `dist/cli-internal.mjs` — Bundled CLI implementation
- `dist/mcp-server.mjs` — Bundled MCP server
- `bin/memmem` — Graceful wrapper executable (bun shebang, chmod 0755), copied from `src/cli-graceful.mjs`

**External Dependencies (not bundled):**

These packages/runtime modules are marked external and must be available at runtime:

- `@huggingface/transformers` — Embedding model
- `bun:sqlite` — SQLite database access from the Bun runtime
- `sharp` — Image processing dependency used by transformer tooling
- `onnxruntime-node` — ONNX runtime for ML models
- `sqlite-vec` — Vector similarity search

### lib/check-dependencies.mjs

Shared dependency-checking logic imported at runtime by `bin/memmem` (built from `src/cli-graceful.mjs`) and by the `memmem mcp` subcommand (`src/cli/mcp.ts`).

**Exports:**

```javascript
// Check if dependencies are installed
checkDependencies() -> { installed: boolean, missing: string[], error?: string }

// Check if build is needed
checkBuildNeeded() -> { needsBuild: boolean, reason: string }

// Install dependencies with Bun (returns Promise)
installDependencies(silent: boolean) -> Promise<void>

// Run build with Bun (returns Promise)
runBuild() -> Promise<void>

// Analyze Bun/runtime errors and suggest fixes
analyzeError(error: Error) -> { cause: string, fix: string }
```

## Single Entrypoint

`bin/memmem` is the single entrypoint for the plugin. It is a graceful wrapper executable (built from `src/cli-graceful.mjs`) that checks dependencies, then dispatches into the bundled CLI (`dist/cli-internal.mjs`).

- **Hooks** call `${CLAUDE_PLUGIN_ROOT}/bin/memmem sync`.
- **MCP** calls `./bin/memmem mcp` with `cwd: "."` from `.mcp.json`. The `mcp` subcommand (`src/cli/mcp.ts`) ensures dependencies are installed and the build is current, then spawns the MCP server bundle (`dist/mcp-server.mjs`) with Bun and forwards termination signals to it.

The runtime still respects `CLAUDE_PLUGIN_ROOT` when a host provides it, and otherwise falls back to the executable's own location.

### Error Analysis

`analyzeError()` translates common Bun/runtime errors into actionable fixes:

| Error Code | Cause | Suggested Fix |
| ---------- | ----- | ------------- |
| EACCES | Permission denied | Check project directory and Bun cache permissions |
| ENOSPC | Disk space full | Free up disk space or clear Bun cache |
| ETIMEDOUT | Network error | Check internet connection or registry/proxy access |
| ECONNRESET | Network error | Check internet connection or registry/proxy access |
| ENOTFOUND | Network error | Check internet connection or registry/proxy access |
