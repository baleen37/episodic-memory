// Package embeddings produces 384-dim multilingual-e5-small embeddings.
//
// It ports src/core/embeddings-model.ts: the lazy-loaded in-process embedding
// pipeline (prefix routing query:/passage: -> tokenize -> ONNX run ->
// mask-weighted mean pooling -> L2 normalize -> 384-dim). The proven Phase 0
// pipeline in poc/main.go is the reference implementation; this package
// graduates it into a real library with the gaps from poc/README.md fixed:
// UTF-16 truncation parity, a single reused ORT session, errors instead of
// os.Exit, and tested mask-weighting/truncation paths.
//
// This is CGO code: it links yalue/onnxruntime_go (against libonnxruntime, the
// Homebrew onnxruntime 1.26 dylib) and daulet/tokenizers (against the prebuilt
// libtokenizers.a). Build/test with the tokenizer static lib on the linker
// path, e.g. from the repo root:
//
//	CGO_ENABLED=1 CGO_LDFLAGS="-L$(pwd)/poc/lib" go test ./internal/core/embeddings/...
//
// (poc/lib/libtokenizers.a is the prebuilt daulet v1.27.0 lib the Phase 0 PoC
// validated; it is gitignored and re-downloadable per poc/README.md. Tests skip
// when the .cache model/tokenizer or the onnxruntime dylib are absent.)
//
// In production the default model (defaultModel -> ProductionConfig) resolves
// these assets via internal/core/runtime: the onnxruntime dylib + tokenizer are
// extracted from the binary (go:embed) and the model is downloaded on first run.
// Tests use NewModel with an explicit Config (or the MEMMEM_MODEL_PATH env
// override) so they never trigger the download.
//
// Not ported here: the rate limiter and disable-flag wrapper from
// src/core/embeddings.ts. Those live in embeddings.ts only as a thin wrapper
// around the model; the rate limiter is a separate Phase 2 item.
package embeddings

import (
	"github.com/baleen37/memmem/internal/core/db"
)

// Dim is the embedding dimension. It reuses db.EmbeddingDim (mirrors
// EMBEDDING_DIM in src/core/constants.ts) so there is a single source of truth.
const Dim = db.EmbeddingDim

// MaxContentChars mirrors MAX_CONTENT_CHARS in embeddings-model.ts: text is
// truncated to this many UTF-16 code units before the prefix is prepended.
const MaxContentChars = 8000

// MaxTokens mirrors the tokenizer's model_max_length for
// Xenova/multilingual-e5-small: inputs are truncated to 512 tokens.
const MaxTokens = 512

// Kind selects the e5 prompt prefix. multilingual-e5 requires "query: " for
// search queries and "passage: " for stored documents.
type Kind string

const (
	Query   Kind = "query"
	Passage Kind = "passage"
)

var prefix = map[Kind]string{
	Query:   "query: ",
	Passage: "passage: ",
}

// Embed mirrors generateEmbeddingFromModel(kind, text) in embeddings-model.ts.
// It truncates text to MaxContentChars UTF-16 code units, prepends the e5 prefix
// for kind, runs the shared ONNX session, mask-weighted mean pools, L2
// normalizes, and returns a Dim-length vector.
//
// The model is lazy-loaded on first call (see Init). Callers that want to
// control load timing or paths can call Init first.
func Embed(kind Kind, text string) ([]float32, error) {
	m, err := defaultModel()
	if err != nil {
		return nil, err
	}
	return m.Embed(kind, text)
}

// EmbedPassage embeds text to be stored as a retrievable vector.
// Mirrors embedPassage in embeddings.ts.
func EmbedPassage(text string) ([]float32, error) { return Embed(Passage, text) }

// EmbedQuery embeds a user search query. Mirrors embedQuery in embeddings.ts.
func EmbedQuery(text string) ([]float32, error) { return Embed(Query, text) }

// Init eagerly loads the default model (idempotent). Mirrors initModel().
func Init() error {
	_, err := defaultModel()
	return err
}
