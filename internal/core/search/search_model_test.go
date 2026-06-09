//go:build cgo

package search

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/baleen37/memmem/internal/core/embeddings"
)

// TestSearchEndToEndWithModel exercises the only model-dependent path: embedding
// a real query string with the default embedder (embeddings.EmbedQuery), then
// retrieving a record whose passage vector was produced by the same model.
//
// The default embedder resolves the model from cwd-relative ./.cache, so this
// test chdir's to the repo root (where .cache lives). It skips when the
// model/tokenizer/onnxruntime assets are absent so `go test ./...` stays green
// without the downloaded model; with CGO_LDFLAGS + the .cache model it passes.
func TestSearchEndToEndWithModel(t *testing.T) {
	root := repoRootDir(t)
	cfg := embeddings.DefaultConfig()
	for _, p := range []string{
		filepath.Join(root, cfg.ModelPath),
		filepath.Join(root, cfg.TokenizerPath),
		cfg.ORTSharedLibraryPath,
	} {
		if _, err := os.Stat(p); err != nil {
			t.Skipf("model asset missing (%s); skipping model end-to-end test", p)
		}
	}

	// Point the default embedder's runtime provisioning at the local .cache model
	// + tokenizer and the homebrew dylib so it uses the local assets and never
	// triggers the 235MB first-run download (MEMMEM_MODEL_PATH is the bypass).
	t.Setenv("MEMMEM_MODEL_PATH", filepath.Join(root, cfg.ModelPath))
	t.Setenv("MEMMEM_TOKENIZER_PATH", filepath.Join(root, cfg.TokenizerPath))
	t.Setenv("MEMMEM_ORT_LIB_PATH", cfg.ORTSharedLibraryPath)

	d := newTestDB(t)
	// Store a passage vector produced by the real model.
	passage, err := embeddings.EmbedPassage("The transcript archive is the source of truth.")
	if err != nil {
		t.Skipf("model init/embed failed (%v); skipping", err)
	}
	id := insertRecord(t, d, memory(withText("The transcript archive is the source of truth."), withDedupe("e2e")))
	insertVector(t, d, id, passage)

	// Default embedder (no Embedder override) -> embeddings.EmbedQuery.
	results, err := Search(context.Background(), "what is the source of truth",
		Options{DB: d, Limit: 5})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(results) == 0 || results[0].ID != id {
		t.Fatalf("expected top result id=%d, got %v", id, ids(results))
	}
	if results[0].Score == nil {
		t.Fatal("vector result must carry a score")
	}
}

func repoRootDir(t *testing.T) string {
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
