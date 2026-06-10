#!/bin/sh
# MCP server launcher - resolves plugin root and starts the server.
# Workaround for: https://github.com/anthropics/claude-code/issues/9354

# Resolve plugin root via the shared resolver (handles CLAUDE_PLUGIN_ROOT,
# installed_plugins.json prefix match, and directory fallback).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(sh "$SCRIPT_DIR/resolve-plugin-root.sh")"

exec node "$PLUGIN_ROOT/scripts/mcp-server-wrapper.mjs"
