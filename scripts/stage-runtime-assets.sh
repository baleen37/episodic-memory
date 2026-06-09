#!/usr/bin/env bash
# Stage the large native assets that internal/core/runtime embeds via //go:embed.
#
# These two files are gitignored (large binaries) and MUST be present before
# `go build` of any package that imports internal/core/runtime. CI/goreleaser
# calls this (or its per-platform equivalent) before building.
#
# Provenance (must match poc/packaging/README.md):
#   - libonnxruntime.dylib: the OFFICIAL Microsoft self-contained ORT 1.26.0
#     dylib (onnxruntime-osx-arm64-1.26.0.tgz). NOT brew's — brew's dylib
#     dynamically links ~20 brew kegs and is not shippable.
#   - tokenizer.json: Xenova/multilingual-e5-small tokenizer.json.
#
# This local/dev version copies from the in-repo Phase 0 staging area
# (poc/packaging/embedded) and the .cache. A CI build on a clean checkout would
# instead `gh release download` the MS ORT tgz and fetch the tokenizer from
# HuggingFace (same bytes), per poc/packaging/README.md "Reproduce".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMBED_DIR="$REPO_ROOT/internal/core/runtime/embedded"
mkdir -p "$EMBED_DIR"

DYLIB_SRC="$REPO_ROOT/poc/packaging/embedded/libonnxruntime.dylib"
TOKENIZER_SRC="$REPO_ROOT/.cache/Xenova/multilingual-e5-small/tokenizer.json"

if [[ ! -f "$DYLIB_SRC" ]]; then
  echo "ERROR: missing $DYLIB_SRC" >&2
  echo "Stage the official Microsoft ORT dylib first (see poc/packaging/README.md 'Reproduce')." >&2
  exit 1
fi
if [[ ! -f "$TOKENIZER_SRC" ]]; then
  echo "ERROR: missing $TOKENIZER_SRC" >&2
  exit 1
fi

cp "$DYLIB_SRC" "$EMBED_DIR/libonnxruntime.dylib"
cp "$TOKENIZER_SRC" "$EMBED_DIR/tokenizer.json"

echo "Staged embed assets into $EMBED_DIR:"
ls -la "$EMBED_DIR/libonnxruntime.dylib" "$EMBED_DIR/tokenizer.json"
