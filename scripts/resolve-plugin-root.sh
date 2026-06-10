#!/bin/sh
# Resolves CLAUDE_PLUGIN_ROOT for local plugin installations.
# Workaround for: https://github.com/anthropics/claude-code/issues/9354
#
# Priority:
# 1. $CLAUDE_PLUGIN_ROOT if already set (future-proof when bug is fixed)
# 2. installPath from ~/.claude/plugins/installed_plugins.json
# 3. Fallback: directory of this script's parent

if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  echo "$CLAUDE_PLUGIN_ROOT"
  exit 0
fi

# Match by plugin name prefix ("memmem@") rather than a hardcoded marketplace,
# so resolution works regardless of which marketplace installed the plugin.
PLUGIN_PREFIX="memmem@"
INSTALLED_PLUGINS="$HOME/.claude/plugins/installed_plugins.json"

INSTALL_PATH=$(python3 -c "
import json
plugins = json.load(open('$INSTALLED_PLUGINS')).get('plugins', {})
for key, entries in plugins.items():
    if key.startswith('$PLUGIN_PREFIX') and entries:
        print(entries[0]['installPath'])
        break
" 2>/dev/null)
if [ -n "$INSTALL_PATH" ]; then
  echo "$INSTALL_PATH"
  exit 0
fi

# Fallback: two levels up from this script (scripts/ -> project root)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "$(dirname "$SCRIPT_DIR")"
