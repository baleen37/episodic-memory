# Scripts Directory

Build and asset scripts for the memmem Go binaries.

## Overview

memmem ships two Go binaries: `memmem` (CLI) and `memmem-mcp` (MCP server). The
binaries embed native runtime assets (the ONNX Runtime shared library and the
tokenizer) via `go:embed`; these assets are large and gitignored, so they are
fetched/staged before building.

## Files

### build-binaries.sh

The single entry point for a local build. On a dev host it "just works":

1. fetches the gitignored native assets if missing (`fetch-dev-assets.sh`),
2. stages the `go:embed` runtime assets (`stage-runtime-assets.sh`),
3. builds `bin/memmem` and `bin/memmem-mcp` with the CGO static-link path for
   `libtokenizers.a`.

```bash
bash scripts/build-binaries.sh
```

### fetch-dev-assets.sh

Downloads the gitignored native build assets (darwin/arm64) if they are missing.
Idempotent — each asset is fetched only when absent.

- ORT shared lib: official Microsoft self-contained ONNX Runtime 1.26.0
- `libtokenizers.a`: daulet/tokenizers v1.27.0 prebuilt static archive (CGO link)
- `tokenizer.json`: Xenova/multilingual-e5-small

CI/goreleaser does NOT use this script; it provisions assets per-platform and
sets `MEMMEM_ORT_LIB_SRC` instead.

### stage-runtime-assets.sh

Copies the native assets into `internal/core/runtime/embedded/` so the
`go:embed` directives have real files at build time. Platform-aware (stages the
`.dylib` on darwin, the `.so` on linux). CI/goreleaser calls this before any
build via the goreleaser `before` hook.

### verify-update-versions-workflow.test.sh

Bash test that checks the version-bump workflow keeps the plugin manifests and
release workflows in sync.
