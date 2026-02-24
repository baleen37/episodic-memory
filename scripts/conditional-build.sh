#!/bin/bash
# Build if source files are newer than dist (make-style)
set -e

PLUGIN_ROOT="${PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SRC_DIR="$PLUGIN_ROOT/src"
DIST_DIR="$PLUGIN_ROOT/dist"

# If dist doesn't exist, build
if [ ! -d "$DIST_DIR" ]; then
  echo "dist/ not found, building..."
  cd "$PLUGIN_ROOT"
  npm run build
  exit 0
fi

# Find the most recently modified source file
LATEST_SRC=$(find "$SRC_DIR" -type f -name "*.ts" -exec stat -f %m {} \; 2>/dev/null | sort -rn | head -1)

# Find the oldest dist file
EARLIEST_DIST=$(find "$DIST_DIR" -type f -exec stat -f %m {} \; 2>/dev/null | sort -n | head -1)

# If no src files found, skip
if [ -z "$LATEST_SRC" ]; then
  echo "No source files found, skipping build"
  exit 0
fi

# If no dist files but dist dir exists, rebuild
if [ -z "$EARLIEST_DIST" ]; then
  echo "dist/ is empty, building..."
  cd "$PLUGIN_ROOT"
  npm run build
  exit 0
fi

# Compare timestamps - rebuild if any source is newer than dist
if [ "$LATEST_SRC" -gt "$EARLIEST_DIST" ]; then
  echo "Source files changed, rebuilding..."
  cd "$PLUGIN_ROOT"
  npm run build
else
  echo "dist/ is up to date, skipping build"
fi
