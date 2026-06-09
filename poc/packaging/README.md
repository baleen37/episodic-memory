# Phase 0 Track B — Single-binary packaging measurement

Goal: decide how the Go port of memmem ships as **one file** to the user, given
the embedding pipeline (proven in Track A) depends on a CGO-linked tokenizer
static lib, a runtime-loaded `libonnxruntime` dylib, and ~250MB of model data.

Two candidate approaches were measured on **darwin-arm64, Go 1.26.3**:

- **Method 1** — `//go:embed` self-extraction
- **Method 2** — fully static linking (`-extldflags "-static"`)

All numbers below are **measured**, not estimated. The `embedded/` artifacts are
gitignored (large binaries); reproduce them with the steps at the end.

---

## TL;DR recommendation

**Use Method 1 (go:embed self-extraction). Embed the dylib + tokenizer; DOWNLOAD
the model on first run (do NOT embed it).**

- Method 2 is **impossible on macOS** — proven below with the real linker error.
  macOS has no static libc/`crt0.o` and Apple's `ld` rejects `-static`. And ORT
  is not even available as a static `.a` from brew or the official release.
- Method 1 works end-to-end: extracted artifacts reproduce the Track A vector
  bit-for-bit (cosine = 1.0000000000).
- Embedding the model pushes the binary to **316 MB**, over the plan's ~300MB
  escape-hatch threshold. Without the model the binary is **78.85 MB**.

| Build | Binary size | First-run extraction |
| --- | --- | --- |
| Method 1, **no model** (dylib + tokenizer embedded) | **78.85 MB** | ~0.05 s (54.4 MB written) |
| Method 1, **model embedded** | **316.1 MB** | ~0.2 s (289.7 MB written) |

(Sizes use the **official Microsoft** self-contained ORT dylib, 37.3 MB — see
"Which dylib to embed" below. With brew's smaller 18.5 MB dylib the numbers are
59.86 MB / 297 MB, but brew's dylib is NOT shippable — it links 20 brew dylibs.)

---

## Method 1 — go:embed self-extraction (WORKS)

`main.go` + `embed_base.go` + `embed_model_{on,off}.go`.

What gets embedded and why:

| Artifact | Embedded? | Reason |
| --- | --- | --- |
| `libonnxruntime.dylib` | **yes** | Loaded at **runtime by path** (`ort.SetSharedLibraryPath`). Embed → extract → point ORT at the extracted path. Natural fit. |
| `tokenizer.json` (17 MB) | **yes** | Read at runtime by path. |
| `model_fp16.onnx` (235 MB) | **gated** (`-tags embedmodel`) | Read at runtime by path. Gated so we can measure both sizes; recommended NOT embedded (see escape hatch). |
| `libtokenizers.a` (39 MB) | **NO** | **Static archive linked at BUILD time** via `CGO_LDFLAGS -L.../lib`. It is compiled into the executable's machine code; it is never a separate runtime file, so it needs no embed/extract. Confirmed against the Track A link line. |

On first run the program extracts the embedded bytes to
`~/.config/memmem/runtime/` (idempotent: skip if present with matching size),
then loads ORT from the **extracted** dylib and runs one real embedding,
comparing to the committed Track A baseline.

### Measured results

Both variants PASS (`cosine vs Track A baseline = 1.0000000000`), proving the
extracted artifacts drive the exact validated pipeline:

```
# no model embedded (default build) — official self-contained dylib
binary: 78,847,954 bytes  (78.85 MB)
first-run extraction: 0.056 s for 54.4 MB (dylib 37.3MB + tokenizer 17.1MB)

# model embedded (-tags embedmodel)
binary: 316,056,514 bytes (316.1 MB)
first-run extraction: ~0.2 s for 289.7 MB (dylib 37.3MB + tokenizer 17.1MB + model 235.3MB)
```

Extraction is ~0.2s even for 290MB because go:embed data already lives in
the binary's mapped pages — it is a memory-to-disk copy, not a decompress.

### Build complexity

Low and robust. Per target platform:

1. Place the platform's `libtokenizers.a` where `CGO_LDFLAGS -L` points (already
   the Track A flow).
2. Place the platform's self-contained ORT dylib + `tokenizer.json`
   (+ optionally the model) into `embedded/`.
3. `CGO_ENABLED=1 CGO_LDFLAGS="-L.../lib" go build [-tags embedmodel]`.

Fragility is in the **inputs** (you must stage the right per-platform native
artifacts), not the mechanism. go:embed itself is a single standard directive.

### Which dylib to embed (important finding)

`brew install onnxruntime` gives an 18.5 MB dylib that **dynamically links ~20
brew dylibs** (abseil, onnx, protobuf, re2) via `/opt/homebrew/...` paths
(`otool -L` confirms). Embedding/extracting only that file would produce a
binary that breaks on any machine without those exact brew kegs — NOT a single
binary for end users.

The **official Microsoft release** `onnxruntime-osx-arm64-1.26.0.tgz` ships a
37.3 MB dylib that depends **only on macOS system frameworks and `/usr/lib`**
(self-contained). That is the artifact the port must embed. The measured 78.85 /
316.1 MB numbers above use it.

---

## Method 2 — static linking (INFEASIBLE on macOS)

Attempted exactly as the plan specifies:

```bash
CGO_ENABLED=1 CGO_LDFLAGS="-L.../poc/lib" \
  go build -ldflags '-extldflags "-static"' -o /tmp/memmem-static .
```

Real failure:

```
ld: library 'crt0.o' not found
clang: error: linker command failed with exit code 1
```

This is a hard **platform** limitation, not a tooling gap. Confirmed three ways:

1. A trivial C program also fails: `cc -static -o /tmp/t /tmp/t.c` →
   `error: unknown option '-static'` (Apple's `ld-1167.5` has no full-static
   mode).
2. There is **no `crt0.o`** anywhere in the macOS SDK — only `libSystem*.tbd`
   dynamic stubs. Apple ships libSystem only as a dynamic library; there is no
   static libc on macOS, and Apple does not support statically linking it.
3. So a "genuinely standalone fully-static executable" cannot be produced on
   macOS at all.

### Is a static onnxruntime even available?

No — independent of the libSystem issue:

- `brew install onnxruntime` ships **only** `libonnxruntime.*.dylib`. No `.a`.
- The **official** `onnxruntime-osx-arm64-1.26.0.tgz` ships **only** the dylib
  (+ dSYM). No `.a`.

A static `libonnxruntime.a` would require **building ONNX Runtime from source**
with a static-lib CMake config — a very large, slow, fragile build (ORT pulls
abseil/onnx/protobuf/re2/etc.). **Not attempted** per the task; noted as a cost.

Even if a static ORT `.a` existed, Method 2 would still fail on macOS at the
libSystem/`crt0.o` step above. Method 2 is a dead end on darwin.

---

## Model: embed vs download-on-first-run

Measured: embedding the 235MB model takes the binary from **78.85 MB → 316.1
MB** (+237 MB). That is over the plan's ~300MB threshold.

**Recommendation: do NOT embed the model — download it on first run.** Keep
code + dylib + tokenizer as the one shipped binary (~79 MB), fetch
`model_fp16.onnx` into `~/.config/memmem/runtime/` on first use (same dir the
extractor already writes to). Rationale:

- 316 MB is an unpleasant download/update for a CLI plugin; every version bump
  re-ships the immutable 235MB model.
- The model is a stable, separately-cacheable artifact (HuggingFace), naturally
  suited to fetch-once.
- The mechanism already exists: this PoC's default (no-`embedmodel`) build loads
  the model from disk; swapping "read from .cache" for "download if missing" is
  a small, contained change.
- 79 MB is a reasonable single-binary size for a CGO+ORT tool.

(If a fully offline/air-gapped distribution were a hard requirement, embedding
the model at 316 MB is viable — extraction is still <0.2s — but it is not the
default recommendation.)

---

## Cross-compile implications (observed)

CGO cross-compile from darwin/arm64 → linux/amd64 fails:

```
# runtime/cgo
gcc_amd64.S: error: unknown token in expression  pushq %rbx
```

The host clang cannot assemble x86-64. CGO needs a **per-platform C toolchain**
AND **per-platform native artifacts** (`libtokenizers.a` + ORT dylib for each
OS/arch). So the port cannot cross-compile all targets from one machine — each
OS/arch needs its own build runner (CI matrix). This applies regardless of
Method 1 vs 2; it is inherent to the CGO dependency from Track A.

---

## Reproduce

```bash
# 1. tokenizer static lib (build-time link) — same as Track A
mkdir -p poc/lib
gh release download v1.27.0 --repo daulet/tokenizers \
  --pattern 'libtokenizers.darwin-arm64.tar.gz' --dir poc/lib --clobber
tar -xzf poc/lib/libtokenizers.darwin-arm64.tar.gz -C poc/lib   # -> poc/lib/libtokenizers.a

# 2. stage embedded artifacts (gitignored)
mkdir -p poc/packaging/embedded
#   official self-contained ORT dylib (NOT brew's):
gh release download v1.26.0 --repo microsoft/onnxruntime \
  --pattern 'onnxruntime-osx-arm64-1.26.0.tgz' --dir /tmp/ort --clobber
tar -xzf /tmp/ort/onnxruntime-osx-arm64-1.26.0.tgz -C /tmp/ort
cp /tmp/ort/onnxruntime-osx-arm64-1.26.0/lib/libonnxruntime.1.26.0.dylib \
   poc/packaging/embedded/libonnxruntime.dylib
cp .cache/Xenova/multilingual-e5-small/tokenizer.json        poc/packaging/embedded/
cp .cache/Xenova/multilingual-e5-small/onnx/model_fp16.onnx  poc/packaging/embedded/   # only needed for -tags embedmodel

# 3. Method 1 — no model
cd poc/packaging
CGO_ENABLED=1 CGO_LDFLAGS="-L$(pwd)/../lib" go build -o /tmp/memmem-pkg .
stat -f %z /tmp/memmem-pkg            # binary size
/tmp/memmem-pkg                       # run from poc/packaging (uses ../baseline.json)

# 4. Method 1 — model embedded
CGO_ENABLED=1 CGO_LDFLAGS="-L$(pwd)/../lib" go build -tags embedmodel -o /tmp/memmem-pkg-model .
stat -f %z /tmp/memmem-pkg-model

# 5. Method 2 — static link (will fail with crt0.o on macOS)
cd ../  # poc/
CGO_ENABLED=1 CGO_LDFLAGS="-L$(pwd)/lib" \
  go build -ldflags '-extldflags "-static"' -o /tmp/memmem-static .
```
