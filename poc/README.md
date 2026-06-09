# Phase 0 Track A — Embedding accuracy PoC

> **Track B (single-binary packaging measurement)** lives in
> [`packaging/README.md`](packaging/README.md) — go:embed vs static linking,
> with measured binary sizes and the recommendation.


Goal: verify that a Go embedding pipeline can reproduce the exact vectors that
the original TS pipeline (transformers.js, `src/core/embeddings-model.ts`)
produced with `Xenova/multilingual-e5-small` fp16 ONNX. This was the gate for the
TS→Go port: if Go couldn't reproduce the vectors, the existing on-disk
`conversations.db` index couldn't stay compatible. (The port is complete; this
document is kept as the Phase 0 record.)

## Result

PASS. Cosine similarity vs the full 384-dim baseline:

| sample  | cosine        | 1 − cosine |
| ------- | ------------- | ---------- |
| query   | 1.00000000000 | −6.66e-16  |
| passage | 1.00000000000 | 0.000e+00  |

The vectors are bit-for-bit identical to the transformers.js output (the
`1 − cos` values are just float64 rounding noise around an exact 1.0). The
"ONNX-in-Go + daulet tokenizers" approach is confirmed.

## Stack that worked

- **onnxruntime**: `brew install onnxruntime` → 1.26.0 at
  `/opt/homebrew/opt/onnxruntime/lib/libonnxruntime.dylib`
- **ORT Go binding**: `github.com/yalue/onnxruntime_go@v1.31.0`
- **Tokenizer**: `github.com/daulet/tokenizers@v1.27.0`, using the **prebuilt**
  `libtokenizers.darwin-arm64` static lib (no cargo build needed)

## Model tensor names (verified against the actual .onnx, not assumed)

- Inputs: `input_ids`, `attention_mask`, `token_type_ids` — all INT64, dims `[-1,-1]`.
  `token_type_ids` IS required (this is a BertModel export); it is passed as all-zeros.
- Output: `last_hidden_state`, FLOAT, dims `[-1,-1,384]`.

## Gotcha: ORT 1.26 graph optimizer crash on this fp16 model

With default (`ORT_ENABLE_ALL`) graph optimization, ORT 1.26.0 throws during
session init:

```
SimplifiedLayerNormFusion ... Attempting to get index by a name which does not exist:
InsertedPrecisionFreeCast_/encoder/layer.11/output/LayerNorm/Constant_output_0
```

Fix: `SetGraphOptimizationLevel(GraphOptimizationLevelDisableAll)`. The accuracy
result above is with optimizations disabled. For the real port this should be
re-checked when pinning an ORT version (a different ORT build or opt level may
avoid the crash), but it does not affect output accuracy.

## Pipeline (matches embeddings-model.ts exactly)

1. `input = prefix + text[:8000]`, prefix = `"query: "` / `"passage: "`
2. tokenize (`AddSpecialTokens=true`; 512-token truncation to mirror `model_max_length`)
3. ORT run → `last_hidden_state`
4. mask-weighted mean pooling
5. L2 normalize → 384-dim

## Reproduce

```bash
# 1. native deps
brew install onnxruntime

# 2. prebuilt tokenizer static lib
mkdir -p lib
gh release download v1.27.0 --repo daulet/tokenizers \
  --pattern 'libtokenizers.darwin-arm64.tar.gz' --dir lib --clobber
tar -xzf lib/libtokenizers.darwin-arm64.tar.gz -C lib   # -> lib/libtokenizers.a

# 3. poc/baseline.json is committed (the reference embedding vector). It was
#    originally generated from the now-removed TS pipeline; the Go embeddings
#    package (internal/core/embeddings) is the live implementation and its tests
#    assert against this same baseline.

# 4. build, then run with CWD = repo root (all paths are repo-relative:
#    ./.cache/... and poc/baseline.json)
cd <repo-root>
CGO_ENABLED=1 CGO_LDFLAGS="-L$(pwd)/poc/lib" go build -C poc -o /tmp/memmem-poc .
/tmp/memmem-poc
```

Model + tokenizer files are read from the repo `.cache/Xenova/multilingual-e5-small/`
(gitignored, already on disk).

`lib/libtokenizers.a` and the tarball are gitignored (re-download via step 2).

## Known gaps to fix when porting

These divergences exist in this PoC and must NOT be silently carried into the
real Go port. The cosine=1.0 result does not exercise any of them, because both
test samples are short single sentences far under the limits.

1. **Char truncation uses byte length, not UTF-16 code units.** `main.go` does
   `len(truncated) > 8000` (UTF-8 byte count), but the TS pipeline's
   `text.substring(0, 8000)` operates on UTF-16 code units. These differ for
   multilingual text (Korean = 3 UTF-8 bytes vs 1 UTF-16 unit), so a long
   Korean/multilingual input would be truncated at a different point and produce
   a different vector. Since on-disk index compatibility is the entire point of
   Track A, the port must reproduce UTF-16-unit truncation and add a long-text
   (>8000 chars) multilingual test asserting parity with TS.

2. **ORT session is created per-sample.** `embed()` builds a new
   `NewAdvancedSession` on every call. The port should create the session once
   and reuse it across calls (likely `NewDynamicAdvancedSession`, which allows
   varying input shapes without rebuilding the session).

3. **`fatal()` / `os.Exit` on every error.** Acceptable for a single-shot PoC
   `main`, but once `embed()` becomes library code these must become
   `return err`.

4. **ORT graph optimization is disabled** (`GraphOptimizationLevelDisableAll`,
   see "Gotcha" above). Must be re-validated under whatever ORT version and
   optimization level the port pins — a different ORT build may not need it, or
   may behave differently.

5. **Mask-weighting, 8000-char truncation, and >512-token truncation are
   functionally untested.** Both samples are short single sentences with no
   padding, so mask-weighted mean pooling is arithmetically identical to a plain
   mean here, and neither truncation path is hit. The port needs a
   batched/padded multi-input test (mixed lengths → real padding → non-trivial
   attention masks) plus an over-512-token input to actually exercise these
   code paths.
