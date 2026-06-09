//go:build linux

package runtime

import _ "embed"

// Embedded native assets (Linux).
//
// Mirror of embed_darwin.go for linux-amd64/arm64. On Linux the ONNX Runtime
// shared library is libonnxruntime.so (NOT .dylib): the official Microsoft
// self-contained ORT 1.26.0 linux tarball (onnxruntime-linux-{x64,aarch64}-
// 1.26.0.tgz) ships lib/libonnxruntime.so. scripts/stage-runtime-assets.sh
// stages the per-platform .so into embedded/libonnxruntime.so before build.
//
// The embeddings package loads this via SetSharedLibraryPath (dlopen at
// runtime), so the extracted file MUST be a real linux ELF .so with the .so
// name — extracting a darwin .dylib here (the original cross-platform bug)
// would make ORT fail to load on linux.
//
// tokenizer.json and the first-run model download are platform-independent.

//go:embed embedded/libonnxruntime.so
var embeddedLib []byte

//go:embed embedded/tokenizer.json
var embeddedTokenizer []byte

// embeddedLibName is the on-disk filename the embedded ORT shared library is
// extracted to. Linux uses the .so extension.
const embeddedLibName = "libonnxruntime.so"
