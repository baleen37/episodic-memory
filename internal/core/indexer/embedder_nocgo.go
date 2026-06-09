//go:build !cgo

package indexer

import "errors"

// defaultEmbedder under !cgo is a stub: the real embedder links the ONNX/CGO
// model, which is unavailable in CGO-free builds. Callers must supply
// Options.Embedder (as tests do). Reaching this stub means a CGO-free build
// tried to embed with no injected embedder.
func defaultEmbedder(text string) ([]float32, error) {
	return nil, errors.New("indexer: default embedder requires CGO; set Options.Embedder")
}
