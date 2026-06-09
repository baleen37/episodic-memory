package indexer

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/baleen37/memmem/internal/core/db"
	"github.com/baleen37/memmem/internal/core/project"
	"github.com/baleen37/memmem/internal/core/sources"
	"github.com/baleen37/memmem/internal/llm"
)

// --- fakes -----------------------------------------------------------------

// fakeProvider returns canned JSON, or an error, on each Complete call. It
// records how many times it was called, mirroring the TS completeCalls counter.
type fakeProvider struct {
	calls int
	fn    func(call int) (string, error)
}

func (p *fakeProvider) Complete(_ context.Context, _ string, _ llm.Options) (llm.Result, error) {
	p.calls++
	text, err := p.fn(p.calls)
	if err != nil {
		return llm.Result{}, err
	}
	return llm.Result{Text: text}, nil
}

func recordsJSON(t *testing.T, recs []map[string]any) string {
	t.Helper()
	b, err := json.Marshal(recs)
	if err != nil {
		t.Fatalf("marshal records: %v", err)
	}
	return string(b)
}

// constEmbedder returns a fixed 384-dim vector.
func constEmbedder(v float32) Embedder {
	return func(string) ([]float32, error) {
		out := make([]float32, db.EmbeddingDim)
		for i := range out {
			out[i] = v
		}
		return out, nil
	}
}

// noGitReader resolves to a deterministic project without shelling out to git.
type noGitReader struct{}

func (noGitReader) ReadRemoteOrgRepo(string) (string, bool) { return "", false }

func testOpts(e Embedder) Options {
	return Options{Embedder: e, GitReader: noGitReader{}}
}

func newTestDB(t *testing.T) *sql.DB {
	t.Helper()
	database, err := db.InitDatabase(":memory:")
	if err != nil {
		t.Fatalf("init db: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	return database
}

func writeArchive(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	archiveDir := filepath.Join(dir, "claude-projects")
	if err := os.MkdirAll(archiveDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	p := filepath.Join(archiveDir, "session.jsonl")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	return p
}

func ptrStr(s string) *string { return &s }
func ptrI64(i int64) *int64   { return &i }

func spanAt(archivePath, sourceKind string, line int64, text string) sources.TranscriptSpan {
	return sources.TranscriptSpan{
		ArchivePath: archivePath,
		LineStart:   line,
		LineEnd:     line,
		SourceKind:  sourceKind,
		SessionID:   ptrStr("s1"),
		Project:     ptrStr("memmem"),
		ObservedAt:  ptrI64(1764115200000),
		Text:        text,
	}
}

func countRows(t *testing.T, database *sql.DB, q string) int {
	t.Helper()
	var n int
	if err := database.QueryRow(q).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// --- backoff / dedupe / exclusion unit tests --------------------------------

func TestComputeRetryAfterExponential(t *testing.T) {
	now := int64(1_000_000)
	cases := []struct {
		attempt int64
		want    int64
	}{
		{1, now + 5*60*1000},
		{2, now + 10*60*1000},
		{3, now + 20*60*1000},
		{4, now + 40*60*1000},
	}
	for _, c := range cases {
		got := ComputeRetryAfter(c.attempt, now)
		if got == nil || *got != c.want {
			t.Fatalf("ComputeRetryAfter(%d) = %v, want %d", c.attempt, got, c.want)
		}
	}
}

func TestComputeRetryAfterCapGivesUp(t *testing.T) {
	now := int64(1_000_000)
	if AttemptCap != 10 {
		t.Fatalf("AttemptCap = %d, want 10", AttemptCap)
	}
	if got := ComputeRetryAfter(AttemptCap, now); got != nil {
		t.Fatalf("ComputeRetryAfter(cap) = %v, want nil", got)
	}
	if got := ComputeRetryAfter(AttemptCap+1, now); got != nil {
		t.Fatalf("ComputeRetryAfter(cap+1) = %v, want nil", got)
	}
}

func TestBaseDelayIs5Minutes(t *testing.T) {
	if BaseDelayMS != 5*60*1000 {
		t.Fatalf("BaseDelayMS = %d", BaseDelayMS)
	}
}

func TestMakeDedupeKeyNormalize(t *testing.T) {
	// lowercase + collapse whitespace + trim, then sha256 of kind:normalized.
	a := makeDedupeKey("fact", "  Hello   World  ")
	b := makeDedupeKey("fact", "hello world")
	if a != b {
		t.Fatalf("normalize mismatch: %q != %q", a, b)
	}
	if makeDedupeKey("event", "hello world") == b {
		t.Fatalf("kind should change the key")
	}
}

// TestMakeDedupeKeyJSParity pins the dedupe_key to values computed by JS/bun
// (createHash('sha256').update(`${kind}:${text.toLowerCase().replace(/\s+/g,' ').trim()}`)).
// This proves U+0085 (NEL) is kept and U+FEFF (BOM) is collapsed, byte-identical
// to the TS index, so the same conversations.db works across TS↔Go.
func TestMakeDedupeKeyJSParity(t *testing.T) {
	nel := string(rune(0x0085))
	bom := string(rune(0xFEFF))
	cases := []struct {
		kind, text, want string
	}{
		// NEL kept (not collapsed) → distinct normalized text.
		{"fact", "a" + nel + "b", "f20b9851a522c2afcba613e558994cc6226997ba3868de0462d4eda8a2379ba6"},
		// BOM collapsed to a single space.
		{"fact", "a" + bom + "b", "36ba52033b8129a536095c5bfbcf1f8632bc04640544a9580923bc31899ae3b1"},
		// Mixed ascii/tab/newline + U+3000, lowercased + trimmed.
		{"fact", "  Hello\t\n World" + string(rune(0x3000)) + "! ", "02e62d51fc56bd24861c136f927d92d971175cfddf3c6cadadfd47819f340461"},
	}
	for _, c := range cases {
		if got := makeDedupeKey(c.kind, c.text); got != c.want {
			t.Errorf("makeDedupeKey(%q, %q) = %s, want %s (JS parity)", c.kind, c.text, got, c.want)
		}
	}
}

func TestGivenUpSpanIsSkipped(t *testing.T) {
	database := newTestDB(t)
	if err := db.UpsertExtractionState(database, db.ExtractionStateInsert{
		SourceKind: "claude-projects", ArchivePath: "/g.jsonl",
		LineStart: 1, LineEnd: 5, SourceHash: "h1", ExtractionVersion: 1,
		Status: db.ExtractionErrored, AttemptCount: AttemptCap, RetryAfter: nil,
	}); err != nil {
		t.Fatal(err)
	}
	pending, err := hasPendingRetryExtractionState(database, "/g.jsonl", 1, 5, "h1", 1, nowMillis())
	if err != nil {
		t.Fatal(err)
	}
	if !pending {
		t.Fatalf("given-up span should be pending(skip)=true")
	}
}

func TestWithinBackoffWindowIsSkipped(t *testing.T) {
	database := newTestDB(t)
	now := nowMillis()
	if err := db.UpsertExtractionState(database, db.ExtractionStateInsert{
		SourceKind: "claude-projects", ArchivePath: "/w.jsonl",
		LineStart: 1, LineEnd: 5, SourceHash: "h1", ExtractionVersion: 1,
		Status: db.ExtractionErrored, AttemptCount: 2, RetryAfter: ptrI64(now + 60_000),
	}); err != nil {
		t.Fatal(err)
	}
	pending, err := hasPendingRetryExtractionState(database, "/w.jsonl", 1, 5, "h1", 1, now)
	if err != nil {
		t.Fatal(err)
	}
	if !pending {
		t.Fatalf("within-backoff span should be skipped")
	}
}

func TestPastBackoffWindowNotSkipped(t *testing.T) {
	database := newTestDB(t)
	now := nowMillis()
	if err := db.UpsertExtractionState(database, db.ExtractionStateInsert{
		SourceKind: "claude-projects", ArchivePath: "/r.jsonl",
		LineStart: 1, LineEnd: 5, SourceHash: "h1", ExtractionVersion: 1,
		Status: db.ExtractionErrored, AttemptCount: 2, RetryAfter: ptrI64(now - 60_000),
	}); err != nil {
		t.Fatal(err)
	}
	pending, err := hasPendingRetryExtractionState(database, "/r.jsonl", 1, 5, "h1", 1, now)
	if err != nil {
		t.Fatal(err)
	}
	if pending {
		t.Fatalf("past-backoff span should be eligible(not skipped)")
	}
}

// --- reindexArchiveFile integration tests -----------------------------------

func TestReindexExtractsAndIndexesVectors(t *testing.T) {
	database := newTestDB(t)
	archivePath := writeArchive(t, "transcript content")

	parser := func(_ string, ctx sources.ParseContext) []sources.TranscriptSpan {
		return []sources.TranscriptSpan{spanAt(ctx.ArchivePath, ctx.SourceKind, 1,
			"User prefers durable memory records over exchange indexing.")}
	}
	provider := &fakeProvider{fn: func(int) (string, error) {
		return recordsJSON(t, []map[string]any{
			{"kind": "fact", "text": "The user prefers durable memory records over exchange indexing.", "confidence": 0.9},
		}), nil
	}}

	result, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, provider, testOpts(constEmbedder(0.5)))
	if err != nil {
		t.Fatal(err)
	}

	if result.MemoryRecordsIndexed != 1 || result.SpansEmpty != 0 || result.SpansErrored != 0 {
		t.Fatalf("result = %+v", result)
	}
	if provider.calls != 1 {
		t.Fatalf("calls = %d, want 1", provider.calls)
	}
	if got := countRows(t, database, "SELECT COUNT(*) FROM memory_records"); got != 1 {
		t.Fatalf("memory_records = %d", got)
	}
	if got := countRows(t, database, "SELECT COUNT(*) FROM vec_memory_records"); got != 1 {
		t.Fatalf("vec_memory_records = %d", got)
	}
	var status string
	if err := database.QueryRow("SELECT status FROM extraction_state").Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "done" {
		t.Fatalf("status = %q, want done", status)
	}
}

func TestReindexProjectResolvedAndVersionsSet(t *testing.T) {
	database := newTestDB(t)
	archivePath := writeArchive(t, "transcript content")

	cwd := "/home/u/dev/repo"
	parser := func(_ string, ctx sources.ParseContext) []sources.TranscriptSpan {
		s := spanAt(ctx.ArchivePath, ctx.SourceKind, 1, "Durable fact.")
		s.Cwd = &cwd
		return []sources.TranscriptSpan{s}
	}
	provider := &fakeProvider{fn: func(int) (string, error) {
		return recordsJSON(t, []map[string]any{{"kind": "fact", "text": "Durable fact.", "confidence": 1}}), nil
	}}

	// noGitReader → ParseOrgRepo fails → project = leaf("repo").
	opts := Options{Embedder: constEmbedder(0.1), GitReader: noGitReader{}}
	if _, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, provider, opts); err != nil {
		t.Fatal(err)
	}

	var proj, projName string
	var extV, embV int64
	if err := database.QueryRow(
		"SELECT project, project_name, extraction_version, embedding_version FROM memory_records",
	).Scan(&proj, &projName, &extV, &embV); err != nil {
		t.Fatal(err)
	}
	wantInfo := project.ResolveProject(cwd, noGitReader{})
	if proj != wantInfo.Project || projName != wantInfo.ProjectName {
		t.Fatalf("project=(%q,%q), want (%q,%q)", proj, projName, wantInfo.Project, wantInfo.ProjectName)
	}
	if extV != db.CurrentExtractionVersion || embV != db.CurrentEmbeddingVersion {
		t.Fatalf("versions ext=%d emb=%d", extV, embV)
	}
}

func TestReindexSkipsCompletedSpans(t *testing.T) {
	database := newTestDB(t)
	archivePath := writeArchive(t, "same transcript content")

	parser := func(_ string, ctx sources.ParseContext) []sources.TranscriptSpan {
		return []sources.TranscriptSpan{spanAt(ctx.ArchivePath, ctx.SourceKind, 1,
			"User prefers durable memory records over exchange indexing.")}
	}
	provider := &fakeProvider{fn: func(int) (string, error) {
		return recordsJSON(t, []map[string]any{{"kind": "fact", "text": "Durable fact.", "confidence": 1}}), nil
	}}
	opts := testOpts(constEmbedder(0.1))

	if _, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, provider, opts); err != nil {
		t.Fatal(err)
	}
	result, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, provider, opts)
	if err != nil {
		t.Fatal(err)
	}

	if result.SpansSkipped != 1 || result.MemoryRecordsIndexed != 0 {
		t.Fatalf("result = %+v", result)
	}
	if provider.calls != 1 {
		t.Fatalf("calls = %d, want 1", provider.calls)
	}
	if got := countRows(t, database, "SELECT COUNT(*) FROM memory_records"); got != 1 {
		t.Fatalf("memory_records = %d", got)
	}
	if got := countRows(t, database, "SELECT COUNT(*) FROM vec_memory_records"); got != 1 {
		t.Fatalf("vectors = %d", got)
	}
}

func TestReindexPrunesStaleSpans(t *testing.T) {
	database := newTestDB(t)
	archivePath := writeArchive(t, "changed transcript content")

	calls := 0
	provider := &fakeProvider{fn: func(call int) (string, error) {
		calls = call
		return recordsJSON(t, []map[string]any{
			{"kind": "fact", "text": "Durable fact " + itoa(call) + ".", "confidence": 1}}), nil
	}}
	opts := testOpts(constEmbedder(0.1))

	first := func(_ string, ctx sources.ParseContext) []sources.TranscriptSpan {
		return []sources.TranscriptSpan{spanAt(archivePath, "claude-projects", 1, "Durable fact 1."), spanAt(archivePath, "claude-projects", 2, "Durable fact 2.")}
	}
	second := func(_ string, ctx sources.ParseContext) []sources.TranscriptSpan {
		return []sources.TranscriptSpan{spanAt(archivePath, "claude-projects", 1, "Durable fact 1.")}
	}

	if _, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", first, provider, opts); err != nil {
		t.Fatal(err)
	}
	result, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", second, provider, opts)
	if err != nil {
		t.Fatal(err)
	}

	if result.SpansSkipped != 1 || result.MemoryRecordsIndexed != 0 {
		t.Fatalf("result = %+v", result)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want 2", calls)
	}
	lines := selectLineStarts(t, database)
	if len(lines) != 1 || lines[0] != 1 {
		t.Fatalf("lineStarts = %v, want [1]", lines)
	}
	if got := countRows(t, database, "SELECT COUNT(*) FROM vec_memory_records"); got != 1 {
		t.Fatalf("vectors = %d", got)
	}
}

func TestReindexReExtractsStalePrunedSpan(t *testing.T) {
	database := newTestDB(t)
	archivePath := writeArchive(t, "changed transcript content")

	calls := 0
	provider := &fakeProvider{fn: func(call int) (string, error) {
		calls = call
		return recordsJSON(t, []map[string]any{
			{"kind": "fact", "text": "Durable fact " + itoa(call) + ".", "confidence": 1}}), nil
	}}
	opts := testOpts(constEmbedder(0.1))

	both := func(_ string, _ sources.ParseContext) []sources.TranscriptSpan {
		return []sources.TranscriptSpan{spanAt(archivePath, "claude-projects", 1, "Durable fact 1."), spanAt(archivePath, "claude-projects", 2, "Durable fact 2.")}
	}
	firstOnly := func(_ string, _ sources.ParseContext) []sources.TranscriptSpan {
		return []sources.TranscriptSpan{spanAt(archivePath, "claude-projects", 1, "Durable fact 1.")}
	}

	if _, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", both, provider, opts); err != nil {
		t.Fatal(err)
	}
	if _, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", firstOnly, provider, opts); err != nil {
		t.Fatal(err)
	}
	result, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", both, provider, opts)
	if err != nil {
		t.Fatal(err)
	}

	if result.SpansSkipped != 1 || result.MemoryRecordsIndexed != 1 {
		t.Fatalf("result = %+v", result)
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3", calls)
	}
	lines := selectLineStarts(t, database)
	if len(lines) != 2 || lines[0] != 1 || lines[1] != 2 {
		t.Fatalf("lineStarts = %v, want [1 2]", lines)
	}
}

func TestReindexEmptyExtractionMarksEmpty(t *testing.T) {
	database := newTestDB(t)
	archivePath := writeArchive(t, "transcript content")

	parser := func(_ string, ctx sources.ParseContext) []sources.TranscriptSpan {
		return []sources.TranscriptSpan{spanAt(ctx.ArchivePath, ctx.SourceKind, 1, "No durable memory here.")}
	}
	provider := &fakeProvider{fn: func(int) (string, error) { return "[]", nil }}

	result, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, provider, testOpts(constEmbedder(0.1)))
	if err != nil {
		t.Fatal(err)
	}
	if result.SpansEmpty != 1 || result.MemoryRecordsIndexed != 0 {
		t.Fatalf("result = %+v", result)
	}
	var status string
	if err := database.QueryRow("SELECT status FROM extraction_state").Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "empty" {
		t.Fatalf("status = %q, want empty", status)
	}
}

func TestReindexKeepsDuplicateFromOtherArchive(t *testing.T) {
	database := newTestDB(t)
	dir := t.TempDir()
	archiveDir := filepath.Join(dir, "claude-projects")
	if err := os.MkdirAll(archiveDir, 0o755); err != nil {
		t.Fatal(err)
	}
	pathA := filepath.Join(archiveDir, "session-a.jsonl")
	pathB := filepath.Join(archiveDir, "session-b.jsonl")
	mustWrite(t, pathA, "same durable fact")
	mustWrite(t, pathB, "same durable fact")

	returnEmpty := false
	provider := &fakeProvider{fn: func(int) (string, error) {
		if returnEmpty {
			return "[]", nil
		}
		return recordsJSON(t, []map[string]any{
			{"kind": "fact", "text": "Shared extracted fact.", "dedupe_key": "shared-fact", "confidence": 1}}), nil
	}}
	parser := func(content string, ctx sources.ParseContext) []sources.TranscriptSpan {
		return []sources.TranscriptSpan{spanAt(ctx.ArchivePath, ctx.SourceKind, 1, content)}
	}
	opts := testOpts(constEmbedder(0.1))

	if _, err := ReindexArchiveFile(context.Background(), database, pathA, "claude-projects", parser, provider, opts); err != nil {
		t.Fatal(err)
	}
	if _, err := ReindexArchiveFile(context.Background(), database, pathB, "claude-projects", parser, provider, opts); err != nil {
		t.Fatal(err)
	}
	returnEmpty = true
	mustWrite(t, pathB, "changed to no extracted memory")
	if _, err := ReindexArchiveFile(context.Background(), database, pathB, "claude-projects", parser, provider, opts); err != nil {
		t.Fatal(err)
	}

	rows, err := database.Query("SELECT archive_path, dedupe_key FROM memory_records ORDER BY archive_path")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type rec struct {
		ap, dk string
	}
	var got []rec
	for rows.Next() {
		var r rec
		if err := rows.Scan(&r.ap, &r.dk); err != nil {
			t.Fatal(err)
		}
		got = append(got, r)
	}
	if len(got) != 1 || got[0].ap != pathA || got[0].dk != "shared-fact" {
		t.Fatalf("rows = %+v, want one row for A with shared-fact", got)
	}
	if c := countRows(t, database, "SELECT COUNT(*) FROM vec_memory_records"); c != 1 {
		t.Fatalf("vectors = %d", c)
	}
}

func TestReindexEmbeddingFailurePreservesExisting(t *testing.T) {
	database := newTestDB(t)
	archivePath := writeArchive(t, "transcript content")

	embeddingCalls := 0
	embed := func(string) ([]float32, error) {
		embeddingCalls++
		if embeddingCalls == 1 {
			out := make([]float32, db.EmbeddingDim)
			for i := range out {
				out[i] = 0.1
			}
			return out, nil
		}
		return nil, nil // signals embedding failed (TS returned null)
	}

	spanText := "Original durable fact."
	parser := func(_ string, ctx sources.ParseContext) []sources.TranscriptSpan {
		s := spanAt(ctx.ArchivePath, ctx.SourceKind, 1, spanText)
		s.ObservedAt = nil
		return []sources.TranscriptSpan{s}
	}
	provider := &fakeProvider{fn: func(int) (string, error) {
		return recordsJSON(t, []map[string]any{{"kind": "fact", "text": spanText, "confidence": 1}}), nil
	}}
	opts := Options{Embedder: embed, GitReader: noGitReader{}}

	if _, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, provider, opts); err != nil {
		t.Fatal(err)
	}
	spanText = "Updated durable fact."
	result, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, provider, opts)
	if err != nil {
		t.Fatal(err)
	}

	if result.SpansErrored != 1 || result.MemoryRecordsIndexed != 0 {
		t.Fatalf("result = %+v", result)
	}
	var text string
	if err := database.QueryRow("SELECT text FROM memory_records").Scan(&text); err != nil {
		t.Fatal(err)
	}
	if text != "Original durable fact." {
		t.Fatalf("text = %q, want Original (rollback preserved old index)", text)
	}
	if c := countRows(t, database, "SELECT COUNT(*) FROM vec_memory_records"); c != 1 {
		t.Fatalf("vectors = %d", c)
	}
}

func TestReindexSkipsErroredBeforeRetryAfter(t *testing.T) {
	database := newTestDB(t)
	archivePath := writeArchive(t, "transcript content")

	parser := func(_ string, ctx sources.ParseContext) []sources.TranscriptSpan {
		s := spanAt(ctx.ArchivePath, ctx.SourceKind, 1, "Retry later fact.")
		s.ObservedAt = nil
		return []sources.TranscriptSpan{s}
	}
	provider := &fakeProvider{fn: func(int) (string, error) {
		return "", errFake("temporary provider failure")
	}}
	opts := testOpts(constEmbedder(0.1))

	first, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, provider, opts)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, provider, opts)
	if err != nil {
		t.Fatal(err)
	}

	if first.SpansErrored != 1 {
		t.Fatalf("first = %+v", first)
	}
	if second.SpansSkipped != 1 || second.SpansErrored != 0 {
		t.Fatalf("second = %+v", second)
	}
	if provider.calls != 1 {
		t.Fatalf("calls = %d, want 1", provider.calls)
	}
}

func TestReindexAccumulatesAttemptCount(t *testing.T) {
	database := newTestDB(t)
	archivePath := writeArchive(t, "transcript content")

	parser := func(_ string, ctx sources.ParseContext) []sources.TranscriptSpan {
		s := spanAt(ctx.ArchivePath, ctx.SourceKind, 1, "Fact to fail on.")
		s.ObservedAt = nil
		return []sources.TranscriptSpan{s}
	}
	provider := &fakeProvider{fn: func(int) (string, error) {
		return "", errFake("provider always fails")
	}}
	opts := testOpts(constEmbedder(0.1))

	first, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, provider, opts)
	if err != nil {
		t.Fatal(err)
	}
	if first.SpansErrored != 1 {
		t.Fatalf("first = %+v", first)
	}
	status, attempt := readState(t, database)
	if status != "errored" || attempt != 1 {
		t.Fatalf("after first: status=%q attempt=%d", status, attempt)
	}

	// Make the span eligible for retry (retry_after in the past).
	if _, err := database.Exec("UPDATE extraction_state SET retry_after = ? WHERE archive_path = ?", nowMillis()-1000, archivePath); err != nil {
		t.Fatal(err)
	}

	second, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, provider, opts)
	if err != nil {
		t.Fatal(err)
	}
	if second.SpansErrored != 1 {
		t.Fatalf("second = %+v", second)
	}
	status, attempt = readState(t, database)
	if status != "errored" || attempt != 2 {
		t.Fatalf("after second: status=%q attempt=%d", status, attempt)
	}
}

func TestReindexExclusionMarkerRemovesIndex(t *testing.T) {
	database := newTestDB(t)
	archivePath := writeArchive(t, "transcript content")

	parser := func(_ string, ctx sources.ParseContext) []sources.TranscriptSpan {
		s := spanAt(ctx.ArchivePath, ctx.SourceKind, 1, "Durable fact.")
		s.SessionID = nil
		s.Project = nil
		s.ObservedAt = nil
		return []sources.TranscriptSpan{s}
	}
	provider := &fakeProvider{fn: func(int) (string, error) {
		return recordsJSON(t, []map[string]any{{"kind": "fact", "text": "Durable fact.", "confidence": 1}}), nil
	}}
	opts := testOpts(constEmbedder(0.1))

	if _, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, provider, opts); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, archivePath, "DO NOT INDEX THIS CONVERSATION")

	result, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, provider, opts)
	if err != nil {
		t.Fatal(err)
	}
	if result != (ReindexArchiveResult{}) {
		t.Fatalf("result = %+v, want zero", result)
	}
	if c := countRows(t, database, "SELECT COUNT(*) FROM memory_records"); c != 0 {
		t.Fatalf("memory_records = %d, want 0", c)
	}
	if c := countRows(t, database, "SELECT COUNT(*) FROM vec_memory_records"); c != 0 {
		t.Fatalf("vectors = %d, want 0", c)
	}
}

func TestReindexNoProviderSkipsAll(t *testing.T) {
	database := newTestDB(t)
	archivePath := writeArchive(t, "transcript content")
	parser := func(_ string, ctx sources.ParseContext) []sources.TranscriptSpan {
		return []sources.TranscriptSpan{
			spanAt(ctx.ArchivePath, ctx.SourceKind, 1, "a"),
			spanAt(ctx.ArchivePath, ctx.SourceKind, 2, "b"),
		}
	}
	result, err := ReindexArchiveFile(context.Background(), database, archivePath, "claude-projects", parser, nil, testOpts(constEmbedder(0.1)))
	if err != nil {
		t.Fatal(err)
	}
	if result.SpansConsidered != 2 || result.SpansSkipped != 2 || result.MemoryRecordsIndexed != 0 {
		t.Fatalf("result = %+v", result)
	}
	if c := countRows(t, database, "SELECT COUNT(*) FROM memory_records"); c != 0 {
		t.Fatalf("memory_records = %d", c)
	}
}

// --- helpers ----------------------------------------------------------------

type errFake string

func (e errFake) Error() string { return string(e) }

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func selectLineStarts(t *testing.T, database *sql.DB) []int64 {
	t.Helper()
	rows, err := database.Query("SELECT line_start FROM memory_records ORDER BY line_start")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var v int64
		if err := rows.Scan(&v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	return out
}

func readState(t *testing.T, database *sql.DB) (string, int64) {
	t.Helper()
	var status string
	var attempt int64
	if err := database.QueryRow("SELECT status, attempt_count FROM extraction_state").Scan(&status, &attempt); err != nil {
		t.Fatal(err)
	}
	return status, attempt
}

func itoa(i int) string { return strconv.Itoa(i) }
