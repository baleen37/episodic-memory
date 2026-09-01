#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/episodic-memory-conditional-build-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p "$TEST_ROOT/src" "$TEST_ROOT/dist" "$TEST_ROOT/bin"
touch -t 202001010000 "$TEST_ROOT/src/source.ts"
touch -t 202001010001 "$TEST_ROOT/dist/output.mjs"

real_stat="$(command -v stat)"
if [ "$(uname -s)" = "Darwin" ]; then
  real_stat_args='-f %m'
else
  real_stat_args='-c %Y'
fi
cat > "$TEST_ROOT/bin/uname" <<'EOF'
#!/usr/bin/env bash
echo Linux
EOF
cat > "$TEST_ROOT/bin/stat" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "-c" ]; then
  shift 2
  "$real_stat" $real_stat_args "\$1"
  exit 0
fi
echo "Inodes: Total: 26083328 Free: 25552367"
EOF
chmod +x "$TEST_ROOT/bin/uname" "$TEST_ROOT/bin/stat"

output="$(PLUGIN_ROOT="$TEST_ROOT" PATH="$TEST_ROOT/bin:$PATH" bash "$REPO_ROOT/scripts/conditional-build.sh" 2>&1)"
printf '%s\n' "$output"

if printf '%s\n' "$output" | grep -Eq 'integer (expression )?expected'; then
  echo 'FAIL: conditional-build used an incompatible stat format'
  exit 1
fi
printf '%s\n' "$output" | grep -Fq 'dist/ is up to date, skipping build'
echo 'PASS: conditional-build uses the host stat format'
