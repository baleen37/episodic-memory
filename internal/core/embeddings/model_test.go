package embeddings

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// repoRoot walks up from the package dir to the module root (where go.mod and
// .cache live) so tests can find the model regardless of CWD.
func repoRoot(t *testing.T) string {
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
			t.Fatal("could not locate repo root (go.mod)")
		}
		dir = parent
	}
}

// testConfig returns a Config pointing at the repo .cache, or skips the test if
// the model/tokenizer files are not present (so `go test ./...` does not hard
// fail for someone without the downloaded model).
func testConfig(t *testing.T) Config {
	t.Helper()
	root := repoRoot(t)
	cfg := DefaultConfig()
	cfg.ModelPath = filepath.Join(root, cfg.ModelPath)
	cfg.TokenizerPath = filepath.Join(root, cfg.TokenizerPath)
	for _, p := range []string{cfg.ModelPath, cfg.TokenizerPath} {
		if _, err := os.Stat(p); err != nil {
			t.Skipf("model asset missing (%s); skipping model-dependent test", p)
		}
	}
	if _, err := os.Stat(cfg.ORTSharedLibraryPath); err != nil {
		t.Skipf("onnxruntime shared library missing (%s); skipping", cfg.ORTSharedLibraryPath)
	}
	return cfg
}

func cosine(a []float32, b []float64) float64 {
	var dot, na, nb float64
	for i := range a {
		av := float64(a[i])
		dot += av * b[i]
		na += av * av
		nb += b[i] * b[i]
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}

// TestAccuracyAgainstBaseline is the non-negotiable gate: the ported pipeline
// must reproduce the transformers.js baseline vectors to cosine >= 0.9999.
func TestAccuracyAgainstBaseline(t *testing.T) {
	cfg := testConfig(t)
	root := repoRoot(t)

	raw, err := os.ReadFile(filepath.Join(root, "poc", "baseline.json"))
	if err != nil {
		t.Skipf("baseline.json missing: %v", err)
	}
	var baseline map[string][]float64
	if err := json.Unmarshal(raw, &baseline); err != nil {
		t.Fatalf("parse baseline: %v", err)
	}

	m, err := NewModel(cfg)
	if err != nil {
		t.Fatalf("NewModel: %v", err)
	}
	defer m.Close()

	samples := []struct {
		kind Kind
		text string
	}{
		{Query, "한국어와 영어가 섞인 검색 쿼리 테스트"},
		{Passage, "memmem stores atomic fact and event memory records with provenance."},
	}

	const gate = 0.9999
	for _, s := range samples {
		vec, err := m.Embed(s.kind, s.text)
		if err != nil {
			t.Fatalf("Embed(%s): %v", s.kind, err)
		}
		if len(vec) != Dim {
			t.Fatalf("%s: dim=%d want %d", s.kind, len(vec), Dim)
		}
		base, ok := baseline[string(s.kind)]
		if !ok || len(base) != Dim {
			t.Fatalf("%s: bad baseline", s.kind)
		}
		cos := cosine(vec, base)
		t.Logf("%s cosine vs baseline = %.10f (1-cos=%.3e)", s.kind, cos, 1-cos)
		if cos < gate {
			t.Errorf("%s cosine %.10f below gate %.4f", s.kind, cos, gate)
		}
	}
}

// TestSessionReused proves the model uses one session across many Embed calls
// (graduation gap #2): repeated calls succeed and are deterministic.
func TestSessionReused(t *testing.T) {
	cfg := testConfig(t)
	m, err := NewModel(cfg)
	if err != nil {
		t.Fatalf("NewModel: %v", err)
	}
	defer m.Close()

	first, err := m.Embed(Passage, "stability check")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		v, err := m.Embed(Passage, "stability check")
		if err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
		for d := range v {
			if v[d] != first[d] {
				t.Fatalf("call %d: non-deterministic at dim %d (%v vs %v)", i, d, v[d], first[d])
			}
		}
	}
}

// TestConcurrentEmbed fires N concurrent Embed calls against one shared Model
// and checks every call returns the same vector as a serial baseline. It backs
// the thread-safety claim for the reused session (the mutex in Model.run). Run
// under `go test -race` to detect data races on the shared session/tokenizer.
func TestConcurrentEmbed(t *testing.T) {
	cfg := testConfig(t)
	m, err := NewModel(cfg)
	if err != nil {
		t.Fatalf("NewModel: %v", err)
	}
	defer m.Close()

	const goroutines = 8
	const perGoroutine = 4

	inputs := []struct {
		kind Kind
		text string
	}{
		{Query, "concurrent query one 한국어"},
		{Passage, "concurrent passage two with provenance"},
	}

	// Serial baselines to compare every concurrent result against.
	want := make([][]float32, len(inputs))
	for i, in := range inputs {
		v, err := m.Embed(in.kind, in.text)
		if err != nil {
			t.Fatalf("baseline Embed: %v", err)
		}
		want[i] = v
	}

	var wg sync.WaitGroup
	errs := make(chan error, goroutines*perGoroutine)
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for j := 0; j < perGoroutine; j++ {
				idx := (g + j) % len(inputs)
				in := inputs[idx]
				v, err := m.Embed(in.kind, in.text)
				if err != nil {
					errs <- err
					return
				}
				for d := range v {
					if v[d] != want[idx][d] {
						errs <- &mismatchError{idx: idx, dim: d, got: v[d], want: want[idx][d]}
						return
					}
				}
			}
		}(g)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent Embed: %v", err)
	}
}

type mismatchError struct {
	idx, dim int
	got      float32
	want     float32
}

func (e *mismatchError) Error() string {
	return "result mismatch under concurrency"
}

// TestOver512Tokens confirms the >512-token truncation path runs and produces a
// valid normalized vector. The tokenizer is configured with MaxTokens=512 to
// mirror transformers.js's model_max_length; a much longer input must not error
// or change output dimensionality.
func TestOver512Tokens(t *testing.T) {
	cfg := testConfig(t)
	m, err := NewModel(cfg)
	if err != nil {
		t.Fatalf("NewModel: %v", err)
	}
	defer m.Close()

	// ~3000 whitespace-separated tokens, far above 512.
	long := strings.Repeat("memory record provenance archive ", 750)
	vec, err := m.Embed(Passage, long)
	if err != nil {
		t.Fatalf("Embed long: %v", err)
	}
	if len(vec) != Dim {
		t.Fatalf("long input dim=%d want %d", len(vec), Dim)
	}
	var nrm float64
	for _, v := range vec {
		nrm += float64(v) * float64(v)
	}
	if math.Abs(math.Sqrt(nrm)-1.0) > 1e-4 {
		t.Fatalf("long input not normalized: norm=%v", math.Sqrt(nrm))
	}

	// Truncation parity: a 512-token prefix of the SAME repeated content should
	// embed identically to the full long input (both truncate to the same first
	// 512 tokens). Use enough repeats to comfortably exceed 512 tokens.
	shorter := strings.Repeat("memory record provenance archive ", 600)
	vec2, err := m.Embed(Passage, shorter)
	if err != nil {
		t.Fatalf("Embed shorter: %v", err)
	}
	for d := range vec {
		if math.Abs(float64(vec[d]-vec2[d])) > 1e-5 {
			t.Fatalf("512-truncation not stable across inputs at dim %d: %v vs %v", d, vec[d], vec2[d])
		}
	}
}

// TestErrorsNotFatal confirms library failure paths return errors rather than
// os.Exit (graduation gap #3): a bad model path is reported, not crashed on.
func TestErrorsNotFatal(t *testing.T) {
	cfg := Config{
		ModelPath:            filepath.Join(t.TempDir(), "missing.onnx"),
		TokenizerPath:        filepath.Join(t.TempDir(), "missing.json"),
		ORTSharedLibraryPath: DefaultConfig().ORTSharedLibraryPath,
	}
	if _, err := NewModel(cfg); err == nil {
		t.Fatal("expected error for missing model/tokenizer, got nil")
	}

	// Unknown kind must error, not panic/exit.
	cfg2 := testConfig(t)
	m, err := NewModel(cfg2)
	if err != nil {
		t.Fatalf("NewModel: %v", err)
	}
	defer m.Close()
	if _, err := m.Embed(Kind("bogus"), "x"); err == nil {
		t.Fatal("expected error for unknown kind")
	}
}
