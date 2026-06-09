//go:build cgo

package search

import "github.com/baleen37/memmem/internal/core/embeddings"

// defaultEmbedder is the production embedder: it calls embeddings.EmbedQuery,
// which lazy-loads the multilingual-e5-small ONNX model (CGO). This file is only
// compiled with cgo enabled; the !cgo stub keeps the rest of the package (and
// its tests) buildable CGO-free, so tests inject a mock embedder via
// Options.Embedder and never reach this function.
func defaultEmbedder(text string) ([]float32, error) {
	return embeddings.EmbedQuery(text)
}
