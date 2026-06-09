//go:build cgo

package indexer

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/baleen37/memmem/internal/core/db"
	"github.com/baleen37/memmem/internal/core/embeddings"
	"github.com/baleen37/memmem/internal/core/sources"
)

// repoRootE2E walks up to the module root (where go.mod / .cache live).
func repoRootE2E(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not locate repo root")
		}
		dir = parent
	}
}

// realModel builds the actual ONNX embedding model with absolute paths, skipping
// when the model/tokenizer/onnxruntime assets are absent.
func realModel(t *testing.T) *embeddings.Model {
	t.Helper()
	root := repoRootE2E(t)
	cfg := embeddings.DefaultConfig()
	cfg.ModelPath = filepath.Join(root, cfg.ModelPath)
	cfg.TokenizerPath = filepath.Join(root, cfg.TokenizerPath)
	for _, p := range []string{cfg.ModelPath, cfg.TokenizerPath} {
		if _, err := os.Stat(p); err != nil {
			t.Skipf("model asset missing (%s); skipping e2e", p)
		}
	}
	if _, err := os.Stat(cfg.ORTSharedLibraryPath); err != nil {
		t.Skipf("onnxruntime shared library missing (%s); skipping e2e", cfg.ORTSharedLibraryPath)
	}
	m, err := embeddings.NewModel(cfg)
	if err != nil {
		t.Fatalf("new model: %v", err)
	}
	return m
}

// TestReindexEndToEndRealModel runs the full extract -> embed (real CGO model)
// -> insert -> vector path and verifies a real 384-dim vector is stored.
func TestReindexEndToEndRealModel(t *testing.T) {
	model := realModel(t)
	database := newTestDB(t)
	archivePath := writeArchive(t, "transcript content")

	parser := func(_ string, ctx sources.ParseContext) []sources.TranscriptSpan {
		return []sources.TranscriptSpan{spanAt(ctx.ArchivePath, ctx.SourceKind, 1,
			"User prefers durable memory records over exchange indexing.")}
	}
	provider := &fakeProvider{fn: func(int) (string, error) {
		return recordsJSON(t, []map[string]any{
			{"kind": "fact", "text": "The user prefers durable memory records.", "confidence": 0.9},
		}), nil
	}}

	embed := func(text string) ([]float32, error) {
		return model.Embed(embeddings.Passage, text)
	}

	result, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, provider,
		Options{Embedder: embed, GitReader: noGitReader{}})
	if err != nil {
		t.Fatal(err)
	}
	if result.MemoryRecordsIndexed != 1 {
		t.Fatalf("result = %+v", result)
	}
	if c := countRows(t, database, "SELECT COUNT(*) FROM vec_memory_records"); c != 1 {
		t.Fatalf("vectors = %d", c)
	}
	// Sanity: the stored embedding dimension matches.
	if db.EmbeddingDim != embeddings.Dim {
		t.Fatalf("dim mismatch %d != %d", db.EmbeddingDim, embeddings.Dim)
	}
}
