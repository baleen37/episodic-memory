//go:build cgo

package indexer

import "github.com/baleen37/memmem/internal/core/embeddings"

// defaultEmbedder is the production embedder: it calls embeddings.EmbedPassage,
// which lazy-loads the multilingual-e5-small ONNX model (CGO). Only compiled
// with cgo enabled; the !cgo stub keeps the package buildable CGO-free so tests
// inject a fake embedder via Options.Embedder and never reach this function.
func defaultEmbedder(text string) ([]float32, error) {
	return embeddings.EmbedPassage(text)
}
