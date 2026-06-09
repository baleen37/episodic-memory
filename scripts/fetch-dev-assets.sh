#!/usr/bin/env bash
# Fetch the large native build assets that are gitignored (too big to commit) so
# a local `go build` "just works". Idempotent: each asset is downloaded only if
# missing. CI/goreleaser does NOT use this — it provisions assets per-platform
# and sets MEMMEM_ORT_LIB_SRC; this script is the local-dev convenience path.
#
# Provenance must match poc/packaging/README.md and scripts/stage-runtime-assets.sh:
#   - ORT shared lib: official Microsoft self-contained ORT 1.26.0
#   - libtokenizers.a: daulet/tokenizers v1.27.0 prebuilt static archive (CGO link)
#   - tokenizer.json: Xenova/multilingual-e5-small
#
# darwin/arm64 only (the local host target). Other platforms build in CI.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

GOOS="$(go env GOOS)"
GOARCH="$(go env GOARCH)"
if [[ "$GOOS" != "darwin" || "$GOARCH" != "arm64" ]]; then
  echo "ERROR: fetch-dev-assets.sh supports darwin/arm64 only (host is $GOOS/$GOARCH)." >&2
  echo "Other platforms are provisioned by CI per-platform." >&2
  exit 1
fi

ORT_LIB="$REPO_ROOT/poc/packaging/embedded/libonnxruntime.dylib"
TOK_LIB="$REPO_ROOT/poc/lib/libtokenizers.a"
TOK_JSON="$REPO_ROOT/.cache/Xenova/multilingual-e5-small/tokenizer.json"

# 1. libtokenizers.a — build-time CGO link archive (daulet/tokenizers v1.27.0).
if [[ -f "$TOK_LIB" ]]; then
  echo "skip libtokenizers.a (present)"
else
  echo "fetch libtokenizers.a ..."
  mkdir -p "$REPO_ROOT/poc/lib"
  gh release download v1.27.0 --repo daulet/tokenizers \
    --pattern 'libtokenizers.darwin-arm64.tar.gz' --dir "$REPO_ROOT/poc/lib" --clobber
  tar -xzf "$REPO_ROOT/poc/lib/libtokenizers.darwin-arm64.tar.gz" -C "$REPO_ROOT/poc/lib"
  test -f "$TOK_LIB" || { echo "ERROR: extraction did not produce $TOK_LIB" >&2; exit 1; }
fi

# 2. ORT self-contained dylib (official Microsoft 1.26.0). Staged into the PoC
#    embedded dir, which stage-runtime-assets.sh reads as its local fallback.
if [[ -f "$ORT_LIB" ]]; then
  echo "skip libonnxruntime.dylib (present)"
else
  echo "fetch libonnxruntime.dylib ..."
  mkdir -p "$REPO_ROOT/poc/packaging/embedded"
  TMP="$(mktemp -d)"
  gh release download v1.26.0 --repo microsoft/onnxruntime \
    --pattern 'onnxruntime-osx-arm64-1.26.0.tgz' --dir "$TMP" --clobber
  tar -xzf "$TMP/onnxruntime-osx-arm64-1.26.0.tgz" -C "$TMP"
  cp "$TMP/onnxruntime-osx-arm64-1.26.0/lib/libonnxruntime.1.26.0.dylib" "$ORT_LIB"
  rm -rf "$TMP"
  test -f "$ORT_LIB" || { echo "ERROR: did not stage $ORT_LIB" >&2; exit 1; }
fi

# 3. tokenizer.json (Xenova/multilingual-e5-small).
if [[ -f "$TOK_JSON" ]]; then
  echo "skip tokenizer.json (present)"
else
  echo "fetch tokenizer.json ..."
  mkdir -p "$(dirname "$TOK_JSON")"
  curl -fsSL \
    "https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/tokenizer.json" \
    -o "$TOK_JSON"
  test -s "$TOK_JSON" || { echo "ERROR: tokenizer.json download was empty" >&2; exit 1; }
fi

echo "dev assets ready:"
echo "  $ORT_LIB"
echo "  $TOK_LIB"
echo "  $TOK_JSON"
