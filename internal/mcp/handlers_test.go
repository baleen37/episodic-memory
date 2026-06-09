package mcp

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/baleen37/memmem/internal/core/db"
	gomcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// These tests port src/mcp/handlers.test.ts, src/mcp/server.handler.test.ts, and
// the dispatch/error-envelope cases in src/mcp/server.test.ts. They are CGO-free:
// the db/search/read packages run on the pure-Go wasm sqlite, vectors are
// hand-inserted, and a mock embedder is injected via testEmbedder.

func newTestDB(t *testing.T) *sql.DB {
	t.Helper()
	database, err := db.InitDatabase(":memory:")
	if err != nil {
		t.Fatalf("init db: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	return database
}

func observedAt(y int, mo time.Month, d int) *int64 {
	v := time.Date(y, mo, d, 0, 0, 0, 0, time.UTC).UnixMilli()
	return &v
}

func hotVec(hot int) []float32 {
	out := make([]float32, db.EmbeddingDim)
	out[hot] = 1.0
	return out
}

func insertRecord(t *testing.T, database *sql.DB, kind db.MemoryRecordKind, text, archivePath string, lineStart, lineEnd int64, dedupe string) int64 {
	t.Helper()
	embV := int64(db.CurrentEmbeddingVersion)
	id, err := db.InsertMemoryRecord(database, db.MemoryRecordInsert{
		Kind:              kind,
		Text:              text,
		SourceKind:        "claude-projects",
		ArchivePath:       archivePath,
		LineStart:         lineStart,
		LineEnd:           lineEnd,
		ObservedAt:        observedAt(2026, 5, 26),
		Status:            db.StatusActive,
		DedupeKey:         dedupe,
		ExtractionVersion: db.CurrentExtractionVersion,
		EmbeddingVersion:  &embV,
	})
	if err != nil {
		t.Fatalf("insert record: %v", err)
	}
	return id
}

// --- handleSearch -----------------------------------------------------------

func TestHandleSearch_MapsToCompactCards(t *testing.T) {
	// Ports "maps search results to compact memory cards" / "returns memory
	// search results with string IDs". Uses the text fallback (nil embedding) so
	// no vectors are needed.
	testEmbedder = func(string) ([]float32, error) { return nil, nil }
	t.Cleanup(func() { testEmbedder = nil })

	database := newTestDB(t)
	insertRecord(t, database, db.KindFact, "memory search transcript result",
		"/archive/claude-projects/session.jsonl", 2, 4, "test-memory-search")

	in, err := ParseSearchInput(json.RawMessage(`{"query":"memory search","limit":10}`))
	if err != nil {
		t.Fatal(err)
	}
	results, err := HandleSearch(context.Background(), in, database)
	if err != nil {
		t.Fatalf("HandleSearch: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	got := results[0]
	if got.ID != "1" || got.Kind != "fact" || got.Text != "memory search transcript result" {
		t.Fatalf("unexpected card: %+v", got)
	}
	if got.Score != nil {
		t.Fatalf("text-fallback result must not carry a score: %+v", got)
	}
}

func TestHandleSearch_EmptyResults(t *testing.T) {
	testEmbedder = func(string) ([]float32, error) { return nil, nil }
	t.Cleanup(func() { testEmbedder = nil })

	database := newTestDB(t)
	in, _ := ParseSearchInput(json.RawMessage(`{"query":"absolutely_nonexistent_xyz_query"}`))
	results, err := HandleSearch(context.Background(), in, database)
	if err != nil {
		t.Fatalf("HandleSearch: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("expected empty results, got %d", len(results))
	}
}

func TestHandleSearch_ArrayANDIntersection(t *testing.T) {
	// Ports the AND-intersection handler test: a record with vectors near both
	// queries is kept; a vector-less record is excluded. Score is set (vector
	// path) and rounded.
	testEmbedder = func(text string) ([]float32, error) {
		switch text {
		case "alpha":
			return hotVec(0), nil
		case "beta":
			return hotVec(1), nil
		default:
			return hotVec(2), nil
		}
	}
	t.Cleanup(func() { testEmbedder = nil })

	database := newTestDB(t)
	id2 := insertRecord(t, database, db.KindFact, "both queries record", "/archive/r2.jsonl", 1, 2, "multi-r2")
	intersect := make([]float32, db.EmbeddingDim)
	intersect[0] = 0.7071
	intersect[1] = 0.7071
	if err := db.InsertMemoryRecordVector(database, id2, intersect); err != nil {
		t.Fatal(err)
	}
	id3 := insertRecord(t, database, db.KindFact, "no vector record", "/archive/r3.jsonl", 5, 6, "multi-r3")

	in, _ := ParseSearchInput(json.RawMessage(`{"query":["alpha","beta"],"limit":10}`))
	results, err := HandleSearch(context.Background(), in, database)
	if err != nil {
		t.Fatalf("HandleSearch: %v", err)
	}

	var foundID2, foundID3 bool
	var id2Card SearchResult
	for _, c := range results {
		if c.ID == itoa(id2) {
			foundID2 = true
			id2Card = c
		}
		if c.ID == itoa(id3) {
			foundID3 = true
		}
	}
	if !foundID2 {
		t.Fatal("id2 (matched by both queries) should be in the intersection")
	}
	if foundID3 {
		t.Fatal("id3 (no vector) must be excluded from the AND intersection")
	}
	if id2Card.Score == nil {
		t.Fatal("vector-path card should carry a score")
	}
	// Score must be rounded to 3 decimals.
	if r := *id2Card.Score; r != round3(r) {
		t.Fatalf("score not rounded to 3 decimals: %v", r)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func round3(x float64) float64 {
	return float64(int64(x*1000+0.5)) / 1000
}

// --- handleFetch ------------------------------------------------------------

func writeTranscript(t *testing.T, dir, content string) string {
	t.Helper()
	p := filepath.Join(dir, "session.jsonl")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestHandleFetch_ReturnsTranscript(t *testing.T) {
	database := newTestDB(t)
	dir := t.TempDir()
	archivePath := writeTranscript(t, dir, `{"uuid":"1","type":"user","timestamp":"2026-05-26T00:00:00.000Z","message":{"role":"user","content":"Hello from transcript"}}`+"\n")
	insertRecord(t, database, db.KindFact, "fetchable", archivePath, 1, 1, "fetchable")

	in, _ := ParseFetchInput(json.RawMessage(`{"id":1}`))
	out, err := HandleFetch(in, database)
	if err != nil {
		t.Fatalf("HandleFetch: %v", err)
	}
	if !strings.Contains(out, "# Conversation") || !strings.Contains(out, "Hello from transcript") {
		t.Fatalf("transcript missing expected content: %q", out)
	}
}

func TestHandleFetch_StringID(t *testing.T) {
	database := newTestDB(t)
	dir := t.TempDir()
	archivePath := writeTranscript(t, dir, `{"uuid":"1","type":"user","timestamp":"2026-05-26T00:00:00.000Z","message":{"role":"user","content":"String id transcript"}}`+"\n")
	insertRecord(t, database, db.KindFact, "string id", archivePath, 1, 1, "string-id")

	in, _ := ParseFetchInput(json.RawMessage(`{"id":"1"}`))
	out, err := HandleFetch(in, database)
	if err != nil {
		t.Fatalf("HandleFetch: %v", err)
	}
	if !strings.Contains(out, "String id transcript") {
		t.Fatalf("missing content: %q", out)
	}
}

func TestHandleFetch_UnknownID(t *testing.T) {
	database := newTestDB(t)
	in, _ := ParseFetchInput(json.RawMessage(`{"id":999}`))
	_, err := HandleFetch(in, database)
	if err == nil || err.Error() != "Memory record not found: 999" {
		t.Fatalf("expected not-found error, got %v", err)
	}
}

func TestHandleFetch_ArchiveMissing(t *testing.T) {
	database := newTestDB(t)
	insertRecord(t, database, db.KindFact, "missing archive", "/nonexistent/path.jsonl", 1, 1, "missing")
	in, _ := ParseFetchInput(json.RawMessage(`{"id":1}`))
	_, err := HandleFetch(in, database)
	if err == nil || !strings.HasPrefix(err.Error(), "Archive file not found for memory record 1:") {
		t.Fatalf("expected archive-missing error, got %v", err)
	}
}

func TestHandleFetch_InvalidID(t *testing.T) {
	database := newTestDB(t)
	// A string id that parses to a non-integer must raise "Invalid memory record id".
	in := FetchInput{IDString: "1.5", IsString: true}
	_, err := HandleFetch(in, database)
	if err == nil || err.Error() != "Invalid memory record id: 1.5" {
		t.Fatalf("expected invalid-id error, got %v", err)
	}
}

// --- HandleError ------------------------------------------------------------

func TestHandleError(t *testing.T) {
	if got := HandleError(verr("Something went wrong")); got != "Error: Something went wrong" {
		t.Fatalf("got %q", got)
	}
}

// --- Dispatch (server CallTool) ---------------------------------------------

func memDBFactory(t *testing.T) (DBFactory, *sql.DB) {
	t.Helper()
	database := newTestDB(t)
	// The factory hands out the same in-memory DB; Dispatch closes it via defer,
	// so we re-open a fresh one each call would lose data. Instead wrap with a
	// no-op close by returning a shared handle whose Close is deferred but
	// harmless across calls within a single Dispatch.
	return func() (*sql.DB, error) { return database, nil }, database
}

func TestDispatch_SearchEnvelope(t *testing.T) {
	testEmbedder = func(string) ([]float32, error) { return nil, nil }
	t.Cleanup(func() { testEmbedder = nil })

	factory, database := memDBFactory(t)
	insertRecord(t, database, db.KindEvent, "dispatch search content", "/archive/d.jsonl", 1, 2, "dispatch-search")

	res := Dispatch(context.Background(), "search", json.RawMessage(`{"query":"dispatch search"}`), factory)
	if res.IsError {
		t.Fatalf("unexpected error envelope: %+v", res)
	}
	text := contentText(t, res)
	var parsed struct {
		Results []SearchResult `json:"results"`
	}
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		t.Fatalf("payload not JSON: %v\n%s", err, text)
	}
	if len(parsed.Results) != 1 || parsed.Results[0].ID != "1" {
		t.Fatalf("unexpected results: %+v", parsed.Results)
	}
}

func TestDispatch_FetchEnvelope(t *testing.T) {
	factory, database := memDBFactory(t)
	dir := t.TempDir()
	archivePath := writeTranscript(t, dir, `{"uuid":"1","type":"user","timestamp":"2026-05-26T00:00:00.000Z","message":{"role":"user","content":"Dispatch fetch content"}}`+"\n")
	insertRecord(t, database, db.KindFact, "dispatch fetch", archivePath, 1, 1, "dispatch-fetch")

	res := Dispatch(context.Background(), "fetch", json.RawMessage(`{"id":1}`), factory)
	if res.IsError {
		t.Fatalf("unexpected error envelope: %+v", res)
	}
	if !strings.Contains(contentText(t, res), "Dispatch fetch content") {
		t.Fatalf("missing content: %q", contentText(t, res))
	}
}

// TestDispatch_UnknownTool_DirectCallerGuard pins the "Unknown tool" branch of
// Dispatch as a guard for DIRECT/internal callers only. Over real stdio the
// go-sdk rejects unadvertised tool names at the protocol layer (JSON-RPC -32602)
// before Dispatch runs, so the wired server never produces this envelope — see
// TestServer_UnknownTool_WireBehavior for the actual wire behavior, and the
// Dispatch doc comment for the divergence rationale.
func TestDispatch_UnknownTool_DirectCallerGuard(t *testing.T) {
	factory, _ := memDBFactory(t)
	res := Dispatch(context.Background(), "unknown_tool", json.RawMessage(`{}`), factory)
	if !res.IsError {
		t.Fatal("expected isError")
	}
	if got := contentText(t, res); got != "Error: Unknown tool: unknown_tool" {
		t.Fatalf("got %q", got)
	}
}

func TestDispatch_ValidationErrorEnvelope(t *testing.T) {
	factory, _ := memDBFactory(t)
	// A too-short query must fail validation and produce the error envelope
	// WITHOUT touching the DB.
	res := Dispatch(context.Background(), "search", json.RawMessage(`{"query":"x"}`), factory)
	if !res.IsError {
		t.Fatal("expected isError for invalid query")
	}
	if got := contentText(t, res); !strings.HasPrefix(got, "Error:") {
		t.Fatalf("error envelope text should start with Error: got %q", got)
	}
}

// contentText extracts the single TextContent payload from a CallToolResult.
func contentText(t *testing.T, res *gomcp.CallToolResult) string {
	t.Helper()
	if len(res.Content) != 1 {
		t.Fatalf("expected 1 content block, got %d", len(res.Content))
	}
	tc, ok := res.Content[0].(*gomcp.TextContent)
	if !ok {
		t.Fatalf("expected TextContent, got %T", res.Content[0])
	}
	return tc.Text
}
