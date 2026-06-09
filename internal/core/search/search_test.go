package search

import (
	"context"
	"database/sql"
	"math"
	"testing"
	"time"

	"github.com/baleen37/memmem/internal/core/db"
)

// These tests insert vectors directly via the db package (WASM, CGO-free) and
// inject a mock Embedder, so they exercise the vector/text SQL, filters,
// combine/dedupe, and AND-intersection WITHOUT the embedding model. They port
// src/core/search.test.ts.

// constEmbedder returns the same vector for every query (the TS
// __setModelForTests([0.1]*384) pattern).
func constEmbedder(vec []float32) Embedder {
	return func(string) ([]float32, error) { return vec, nil }
}

func fillVec(v float32) []float32 {
	out := make([]float32, db.EmbeddingDim)
	for i := range out {
		out[i] = v
	}
	return out
}

// hotVector mirrors the TS hotVector helper: index hot = 1.0, rest 0.0.
func hotVector(hot int) []float32 {
	out := make([]float32, db.EmbeddingDim)
	out[hot] = 1.0
	return out
}

func observedAt(y int, mo time.Month, d int) *int64 {
	v := time.Date(y, mo, d, 0, 0, 0, 0, time.UTC).UnixMilli()
	return &v
}

func strPtr(s string) *string { return &s }

type memOpt func(*db.MemoryRecordInsert)

func memory(opts ...memOpt) db.MemoryRecordInsert {
	embV := int64(db.CurrentEmbeddingVersion)
	r := db.MemoryRecordInsert{
		Kind:              db.KindFact,
		Text:              "The transcript archive is the source of truth.",
		SourceKind:        "claude-projects",
		ArchivePath:       "/archive/a.jsonl",
		LineStart:         4,
		LineEnd:           8,
		ObservedAt:        observedAt(2026, 6, 1),
		Project:           strPtr("memmem"),
		ProjectName:       nil,
		Status:            db.StatusActive,
		DedupeKey:         "default",
		ExtractionVersion: db.CurrentExtractionVersion,
		EmbeddingVersion:  &embV,
	}
	for _, o := range opts {
		o(&r)
	}
	return r
}

func withText(s string) memOpt        { return func(r *db.MemoryRecordInsert) { r.Text = s } }
func withArchive(s string) memOpt     { return func(r *db.MemoryRecordInsert) { r.ArchivePath = s } }
func withDedupe(s string) memOpt      { return func(r *db.MemoryRecordInsert) { r.DedupeKey = s } }
func withSourceKind(s string) memOpt  { return func(r *db.MemoryRecordInsert) { r.SourceKind = s } }
func withProject(s *string) memOpt    { return func(r *db.MemoryRecordInsert) { r.Project = s } }
func withStatus(s db.MemoryRecordStatus) memOpt {
	return func(r *db.MemoryRecordInsert) { r.Status = s }
}
func withObserved(p *int64) memOpt { return func(r *db.MemoryRecordInsert) { r.ObservedAt = p } }
func withLines(start, end int64) memOpt {
	return func(r *db.MemoryRecordInsert) { r.LineStart, r.LineEnd = start, end }
}

func newTestDB(t *testing.T) *sql.DB {
	t.Helper()
	d, err := db.InitDatabase(":memory:")
	if err != nil {
		t.Fatalf("init db: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func insertRecord(t *testing.T, d *sql.DB, r db.MemoryRecordInsert) int64 {
	t.Helper()
	id, err := db.InsertMemoryRecord(d, r)
	if err != nil {
		t.Fatalf("insert record: %v", err)
	}
	return id
}

func insertVector(t *testing.T, d *sql.DB, id int64, vec []float32) {
	t.Helper()
	if err := db.InsertMemoryRecordVector(d, id, vec); err != nil {
		t.Fatalf("insert vector: %v", err)
	}
}

func ids(results []MemorySearchResult) []int64 {
	out := make([]int64, len(results))
	for i, r := range results {
		out[i] = r.ID
	}
	return out
}

func TestSearchReturnsCompactVectorRecord(t *testing.T) {
	d := newTestDB(t)
	id := insertRecord(t, d, memory())
	insertVector(t, d, id, fillVec(0.1))

	opts := Options{DB: d, Limit: 5, Embedder: constEmbedder(fillVec(0.1))}
	results, err := Search(context.Background(), "source of truth", opts)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) == 0 {
		t.Fatal("no results")
	}
	r := results[0]
	if r.ID != id || r.Kind != "fact" || r.SourceKind != "claude-projects" ||
		r.ArchivePath != "/archive/a.jsonl" || r.LineStart != 4 || r.LineEnd != 8 {
		t.Fatalf("unexpected fields: %+v", r)
	}
	if r.Text != "The transcript archive is the source of truth." {
		t.Fatalf("text = %q", r.Text)
	}
	if r.Project == nil || *r.Project != "memmem" {
		t.Fatalf("project = %v", r.Project)
	}
	if r.ObservedAt == nil || *r.ObservedAt != *observedAt(2026, 6, 1) {
		t.Fatalf("observedAt = %v", r.ObservedAt)
	}
	if r.Score == nil {
		t.Fatal("vector result must have a score")
	}
}

func TestSearchVectorAndTextNoDuplicates(t *testing.T) {
	d := newTestDB(t)
	vectorID := insertRecord(t, d, memory(
		withArchive("/archive/claude-projects/a.jsonl"),
		withText("Semantic memory vector result."),
		withProject(strPtr("alpha")),
		withObserved(observedAt(2026, 5, 26)),
		withDedupe("vector-result"),
	))
	insertVector(t, d, vectorID, fillVec(0.1))

	insertRecord(t, d, memory(
		withArchive("/archive/codex-sessions/b.jsonl"),
		withSourceKind("codex-sessions"),
		withText("Exact phrase search text result."),
		withProject(strPtr("beta")),
		withObserved(observedAt(2026, 5, 27)),
		withDedupe("fallback-result"),
	))

	results, err := Search(context.Background(), "exact phrase",
		Options{DB: d, Limit: 10, Embedder: constEmbedder(fillVec(0.1))})
	if err != nil {
		t.Fatal(err)
	}
	var foundCodex bool
	seen := map[int64]bool{}
	for _, r := range results {
		if r.ArchivePath == "/archive/codex-sessions/b.jsonl" {
			foundCodex = true
		}
		if seen[r.ID] {
			t.Fatalf("duplicate id %d", r.ID)
		}
		seen[r.ID] = true
	}
	if !foundCodex {
		t.Fatal("expected text-fallback codex record in results")
	}
}

func TestSearchFiltersBySourceKindAndDate(t *testing.T) {
	d := newTestDB(t)
	insertRecord(t, d, memory(
		withArchive("/archive/claude-projects/a.jsonl"),
		withText("Filter me old."),
		withObserved(observedAt(2026, 5, 25)),
		withDedupe("old-filter"),
	))
	insertRecord(t, d, memory(
		withArchive("/archive/codex-sessions/b.jsonl"),
		withSourceKind("codex-sessions"),
		withText("Filter me new."),
		withObserved(observedAt(2026, 5, 26)),
		withDedupe("new-filter"),
	))

	results, err := Search(context.Background(), "filter me", Options{
		DB: d, Limit: 10, After: "2026-05-26", SourceKind: "codex-sessions",
		Embedder: constEmbedder(fillVec(0.1)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if results[0].SourceKind != "codex-sessions" {
		t.Fatalf("sourceKind = %q", results[0].SourceKind)
	}
}

func TestSearchFiltersTextByProject(t *testing.T) {
	d := newTestDB(t)
	alphaID := insertRecord(t, d, memory(
		withArchive("/archive/claude-projects/alpha.jsonl"),
		withText("Project text query alpha."),
		withProject(strPtr("alpha")),
		withDedupe("alpha-text"),
	))
	insertRecord(t, d, memory(
		withArchive("/archive/claude-projects/beta.jsonl"),
		withText("Project text query beta."),
		withProject(strPtr("beta")),
		withDedupe("beta-text"),
	))

	results, err := Search(context.Background(), "project text query", Options{
		DB: d, Limit: 10, Projects: []string{"alpha"}, Embedder: constEmbedder(fillVec(0.1)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(results); len(got) != 1 || got[0] != alphaID {
		t.Fatalf("ids = %v, want [%d]", got, alphaID)
	}
}

func TestSearchFiltersVectorByProject(t *testing.T) {
	d := newTestDB(t)
	alphaID := insertRecord(t, d, memory(
		withArchive("/archive/claude-projects/alpha-vector.jsonl"),
		withText("Alpha semantic only."),
		withProject(strPtr("alpha")),
		withDedupe("alpha-vector"),
	))
	insertVector(t, d, alphaID, fillVec(0.1))
	betaID := insertRecord(t, d, memory(
		withArchive("/archive/claude-projects/beta-vector.jsonl"),
		withText("Beta semantic only."),
		withProject(strPtr("beta")),
		withDedupe("beta-vector"),
	))
	insertVector(t, d, betaID, fillVec(0.2))

	results, err := Search(context.Background(), "project-vector-query", Options{
		DB: d, Limit: 10, Projects: []string{"beta"}, Embedder: constEmbedder(fillVec(0.1)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(results); len(got) != 1 || got[0] != betaID {
		t.Fatalf("ids = %v, want [%d]", got, betaID)
	}
}

// mockNormalizer records the prompt and returns a fixed normalization.
type mockNormalizer struct {
	prompt string
	out    string
	err    error
}

func (m *mockNormalizer) Complete(_ context.Context, prompt string) (string, error) {
	m.prompt = prompt
	return m.out, m.err
}

func TestSearchNormalizesQuery(t *testing.T) {
	d := newTestDB(t)
	id := insertRecord(t, d, memory(
		withArchive("/archive/claude-projects/normalized.jsonl"),
		withText("English normalized text fallback."),
		withProject(nil),
		withDedupe("normalized"),
	))

	var embeddedQuery string
	embedder := func(text string) ([]float32, error) {
		embeddedQuery = text
		return fillVec(0.1), nil
	}
	norm := &mockNormalizer{out: "english normalized"}

	results, err := Search(context.Background(), "한국어 질의", Options{
		DB: d, Limit: 10, QueryNormalizer: norm, Embedder: embedder,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !contains(norm.prompt, "한국어 질의") {
		t.Fatalf("prompt did not contain raw query: %q", norm.prompt)
	}
	if embeddedQuery != "english normalized" {
		t.Fatalf("embedded query = %q, want normalized", embeddedQuery)
	}
	if got := ids(results); len(got) != 1 || got[0] != id {
		t.Fatalf("ids = %v, want [%d]", got, id)
	}
}

func TestSearchLikeWildcardsLiteral(t *testing.T) {
	d := newTestDB(t)
	literalID := insertRecord(t, d, memory(
		withArchive("/archive/claude-projects/literal.jsonl"),
		withText("Literal 100% match."),
		withProject(nil),
		withDedupe("literal-percent"),
	))
	insertRecord(t, d, memory(
		withArchive("/archive/claude-projects/wildcard.jsonl"),
		withText("Literal 100abc match."),
		withProject(nil),
		withDedupe("wildcard-percent"),
	))

	results, err := Search(context.Background(), "100%",
		Options{DB: d, Limit: 10, Embedder: constEmbedder(fillVec(0.1))})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(results); len(got) != 1 || got[0] != literalID {
		t.Fatalf("ids = %v, want [%d] (literal only)", got, literalID)
	}
}

func TestSearchFiltersVectorOutsideTopK(t *testing.T) {
	d := newTestDB(t)
	for i := 0; i < 2; i++ {
		id := insertRecord(t, d, memory(
			withArchive("/archive/claude-projects/closer.jsonl"),
			withText("Closer unrelated."),
			withDedupe("closer-"+string(rune('a'+i))),
		))
		insertVector(t, d, id, fillVec(0.1))
	}
	codexID := insertRecord(t, d, memory(
		withArchive("/archive/codex-sessions/filtered.jsonl"),
		withSourceKind("codex-sessions"),
		withText("Codex semantic only match."),
		withDedupe("codex-filtered-vector"),
	))
	insertVector(t, d, codexID, fillVec(0.2))

	results, err := Search(context.Background(), "vector-filter-query", Options{
		DB: d, Limit: 2, SourceKind: "codex-sessions", Embedder: constEmbedder(fillVec(0.1)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(results); len(got) != 1 || got[0] != codexID {
		t.Fatalf("ids = %v, want [%d]", got, codexID)
	}
}

func TestSearchExcludesSupersededVectorInTopK(t *testing.T) {
	d := newTestDB(t)
	supersededID := insertRecord(t, d, memory(
		withArchive("/archive/claude-projects/superseded-vector.jsonl"),
		withText("Superseded semantic only memory."),
		withStatus(db.StatusSuperseded),
		withDedupe("superseded-vector-top-k"),
	))
	insertVector(t, d, supersededID, fillVec(0.1))
	activeID := insertRecord(t, d, memory(
		withArchive("/archive/claude-projects/active-vector.jsonl"),
		withText("Active semantic only memory."),
		withDedupe("active-vector-after-superseded"),
	))
	insertVector(t, d, activeID, fillVec(0.2))

	results, err := Search(context.Background(), "vector-only-query",
		Options{DB: d, Limit: 1, Embedder: constEmbedder(fillVec(0.1))})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(results); len(got) != 1 || got[0] != activeID {
		t.Fatalf("ids = %v, want [%d] (active, superseded excluded)", got, activeID)
	}
}

func TestSearchPreservesNullProjectAndObserved(t *testing.T) {
	d := newTestDB(t)
	insertRecord(t, d, memory(
		withArchive("/archive/claude-projects/nulls.jsonl"),
		withText("Null shape result."),
		withLines(5, 6),
		withObserved(nil),
		withProject(nil),
		withDedupe("null-shape"),
	))

	results, err := Search(context.Background(), "null shape",
		Options{DB: d, Limit: 10, Embedder: constEmbedder(fillVec(0.1))})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if results[0].Project != nil {
		t.Errorf("project should be nil, got %v", *results[0].Project)
	}
	if results[0].ObservedAt != nil {
		t.Errorf("observedAt should be nil, got %v", *results[0].ObservedAt)
	}
	// Text-path result carries no score.
	if results[0].Score != nil {
		t.Errorf("text result should have no score, got %v", *results[0].Score)
	}
}

func TestSearchOmitsSupersededAndTruncatesText(t *testing.T) {
	d := newTestDB(t)
	longText := "long query " + repeat("a", 500)
	activeID := insertRecord(t, d, memory(
		withArchive("/archive/claude-projects/long.jsonl"),
		withText(longText),
		withDedupe("long-active"),
	))
	insertRecord(t, d, memory(
		withArchive("/archive/claude-projects/superseded.jsonl"),
		withText("long query superseded"),
		withStatus(db.StatusSuperseded),
		withDedupe("long-superseded"),
	))

	results, err := Search(context.Background(), "long query",
		Options{DB: d, Limit: 10, Embedder: constEmbedder(fillVec(0.1))})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(results); len(got) != 1 || got[0] != activeID {
		t.Fatalf("ids = %v, want [%d]", got, activeID)
	}
	if r := []rune(results[0].Text); len(r) != 400 {
		t.Fatalf("truncated text rune length = %d, want 400", len(r))
	}
	if !endsWith(results[0].Text, "...") {
		t.Fatalf("expected trailing ..., got %q", results[0].Text)
	}
}

func TestScoreIsInverseDistance(t *testing.T) {
	d := newTestDB(t)
	// Record vector equal to query => distance 0 => score 1/(1+0) = 1.
	id := insertRecord(t, d, memory(withText("exact match"), withDedupe("exact")))
	insertVector(t, d, id, hotVector(0))

	results, err := Search(context.Background(), "q",
		Options{DB: d, Limit: 1, Embedder: constEmbedder(hotVector(0))})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Score == nil {
		t.Fatalf("expected scored result, got %+v", results)
	}
	if math.Abs(*results[0].Score-1.0) > 1e-6 {
		t.Fatalf("score = %f, want ~1.0 (distance 0)", *results[0].Score)
	}
}

func TestGetMemoryRecordLocation(t *testing.T) {
	d := newTestDB(t)
	id := insertRecord(t, d, memory(withLines(11, 22), withArchive("/archive/loc.jsonl"), withDedupe("loc")))

	loc, err := GetMemoryRecordLocation(d, id)
	if err != nil {
		t.Fatal(err)
	}
	if loc == nil || loc.ArchivePath != "/archive/loc.jsonl" || loc.LineStart != 11 || loc.LineEnd != 22 {
		t.Fatalf("loc = %+v", loc)
	}

	// Missing id -> nil.
	missing, err := GetMemoryRecordLocation(d, 99999)
	if err != nil {
		t.Fatal(err)
	}
	if missing != nil {
		t.Fatalf("expected nil for missing id, got %+v", missing)
	}

	// Superseded -> nil.
	supID := insertRecord(t, d, memory(withStatus(db.StatusSuperseded), withDedupe("sup-loc"), withArchive("/archive/sup.jsonl")))
	sup, err := GetMemoryRecordLocation(d, supID)
	if err != nil {
		t.Fatal(err)
	}
	if sup != nil {
		t.Fatalf("superseded location should be nil, got %+v", sup)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func endsWith(s, suf string) bool {
	return len(s) >= len(suf) && s[len(s)-len(suf):] == suf
}
