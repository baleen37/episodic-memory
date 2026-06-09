package runtime

import _ "embed"

// Embedded native assets.
//
// These two files are staged into embedded/ at build time and are gitignored
// (see .gitignore and embedded/.gitkeep) because they are large native binaries
// (~37MB dylib + ~17MB tokenizer). Stage them locally or in CI with
// scripts/stage-runtime-assets.sh before building. //go:embed requires the
// files to exist at compile time, so a build without staging will fail loudly
// with a clear "no matching files found" error rather than producing a broken
// binary.
//
// Provenance (must match the Phase 0 PoC — see poc/packaging/README.md):
//   - libonnxruntime.dylib: the OFFICIAL Microsoft self-contained ORT 1.26.0
//     dylib (onnxruntime-osx-arm64-1.26.0.tgz), NOT brew's. Brew's dylib
//     dynamically links ~20 brew kegs and is not shippable. The MS dylib
//     depends only on macOS system frameworks + /usr/lib.
//   - tokenizer.json: .cache/Xenova/multilingual-e5-small/tokenizer.json.
//
// The model (model_fp16.onnx, 235MB) is intentionally NOT embedded — it is
// downloaded on first run (see runtime.go) to keep the binary ~79MB.

//go:embed embedded/libonnxruntime.dylib
var embeddedDylib []byte

//go:embed embedded/tokenizer.json
var embeddedTokenizer []byte
