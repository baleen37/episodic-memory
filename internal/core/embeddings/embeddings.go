// Package embeddings produces 384-dim multilingual-e5-small embeddings.
//
// Ports src/core/embeddings.ts and src/core/embeddings-model.ts. The proven
// Phase 0 pipeline in poc/main.go (yalue/onnxruntime_go + daulet/tokenizers)
// graduates here: prefix routing (query:/passage:), tokenization, ORT run,
// mask-weighted mean pooling, L2 normalize.
//
// TODO(phase2): graduate the PoC pipeline; carry the known gaps from
// poc/README.md (UTF-16 truncation, session reuse, error returns instead of
// os.Exit, graph-optimization re-validation).
package embeddings
