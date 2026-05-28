#!/bin/sh
# Hook runner - resolves plugin root and executes CLI command.
# Workaround for CLAUDE_PLUGIN_ROOT not being set for local installs.
# See: https://github.com/anthropics/claude-code/issues/9354
#
# Uses a temp file to preserve stdin exactly, avoiding echo "$VAR" corruption
# of special characters (newlines, backslashes, etc.) in JSON payloads.

PLUGIN_ROOT="$(CLAUDE_PLUGIN_ROOT="" sh "$HOME/.claude/cpr.sh" memmem@baleen-marketplace)"
TMPFILE=$(mktemp)
cat > "$TMPFILE"
bun "$PLUGIN_ROOT/dist/cli.mjs" "$@" < "$TMPFILE"
EXIT=$?
rm -f "$TMPFILE"
exit $EXIT
