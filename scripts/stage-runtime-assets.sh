#!/usr/bin/env bash
# Stage the large native assets that internal/core/runtime embeds via //go:embed.
#
# These files are gitignored (large binaries) and MUST be present before
# `go build` of any package that imports internal/core/runtime. CI/goreleaser
# calls this before building.
#
# Platform-aware: the embedded ORT shared library is named per-platform to match
# the build-tagged embed (embed_{darwin,linux}.go):
#   - macOS: embedded/libonnxruntime.dylib  (//go:build darwin)
#   - linux: embedded/libonnxruntime.so     (//go:build linux)
# Extracting the wrong-platform lib (e.g. a darwin .dylib on linux) makes ORT
# fail to dlopen at runtime, so this script stages the lib matching the GOOS it
# is building for.
#
# Provenance (must match poc/packaging/README.md):
#   - ORT shared lib: the OFFICIAL Microsoft self-contained ORT 1.26.0 lib
#     (onnxruntime-osx-{arm64,x86_64}-1.26.0.tgz on macOS,
#      onnxruntime-linux-{x64,aarch64}-1.26.0.tgz on linux). NOT brew's — brew's
#     dylib dynamically links ~20 kegs and is not shippable.
#   - tokenizer.json: Xenova/multilingual-e5-small tokenizer.json.
#
# Source resolution:
#   - The ORT lib source may be set explicitly via MEMMEM_ORT_LIB_SRC (CI sets
#     this to the per-platform MS lib it just downloaded/extracted).
#   - Otherwise it falls back to the in-repo Phase 0 staging area
#     (poc/packaging/embedded), which only contains the darwin-arm64 dylib.
#   - The tokenizer source may be set via MEMMEM_TOKENIZER_SRC; otherwise it
#     falls back to the local .cache.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMBED_DIR="$REPO_ROOT/internal/core/runtime/embedded"
mkdir -p "$EMBED_DIR"

# Determine the target GOOS (honor an explicit GOOS env, else use the host).
TARGET_GOOS="${GOOS:-$(go env GOOS)}"
case "$TARGET_GOOS" in
  darwin) LIB_NAME="libonnxruntime.dylib" ;;
  linux)  LIB_NAME="libonnxruntime.so" ;;
  *)
    echo "ERROR: unsupported GOOS '$TARGET_GOOS' (only darwin/linux are shippable)" >&2
    exit 1
    ;;
esac

# Resolve the ORT lib source.
if [[ -n "${MEMMEM_ORT_LIB_SRC:-}" ]]; then
  LIB_SRC="$MEMMEM_ORT_LIB_SRC"
else
  # Local/dev fallback: the in-repo darwin-arm64 dylib from Phase 0.
  LIB_SRC="$REPO_ROOT/poc/packaging/embedded/libonnxruntime.dylib"
  if [[ "$TARGET_GOOS" != "darwin" ]]; then
    echo "ERROR: no MEMMEM_ORT_LIB_SRC set and the in-repo fallback is a darwin" >&2
    echo "dylib; cannot stage a linux .so. Set MEMMEM_ORT_LIB_SRC to the MS" >&2
    echo "onnxruntime-linux lib (CI does this per-platform)." >&2
    exit 1
  fi
fi

# Resolve the tokenizer source.
TOKENIZER_SRC="${MEMMEM_TOKENIZER_SRC:-$REPO_ROOT/.cache/Xenova/multilingual-e5-small/tokenizer.json}"

if [[ ! -f "$LIB_SRC" ]]; then
  echo "ERROR: missing ORT lib source $LIB_SRC" >&2
  echo "Stage the official Microsoft ORT lib first (see poc/packaging/README.md 'Reproduce')." >&2
  exit 1
fi
if [[ ! -f "$TOKENIZER_SRC" ]]; then
  echo "ERROR: missing tokenizer source $TOKENIZER_SRC" >&2
  exit 1
fi

cp "$LIB_SRC" "$EMBED_DIR/$LIB_NAME"
cp "$TOKENIZER_SRC" "$EMBED_DIR/tokenizer.json"

echo "Staged embed assets into $EMBED_DIR (GOOS=$TARGET_GOOS):"
ls -la "$EMBED_DIR/$LIB_NAME" "$EMBED_DIR/tokenizer.json"
