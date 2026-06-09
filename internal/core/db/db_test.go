package db

import (
	"database/sql"
	"encoding/binary"
	"math"
	"path/filepath"
	"testing"
)

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	d, err := OpenDatabase(":memory:")
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func ptrInt64(v int64) *int64    { return &v }
func ptrString(v string) *string { return &v }

// TestSchemaTablesAndColumns verifies the three tables exist with the exact
// columns from the TS DDL (index compatibility).
func TestSchemaTablesAndColumns(t *testing.T) {
	d := openTestDB(t)

	wantCols := map[string][]string{
		"memory_records": {
			"id", "kind", "text", "source_kind", "archive_path", "line_start",
			"line_end", "observed_at", "project", "project_name", "confidence",
			"status", "supersedes_id", "dedupe_key", "extraction_version",
			"embedding_version", "created_at", "updated_at",
		},
		"extraction_state": {
			"id", "source_kind", "archive_path", "line_start", "line_end",
			"source_hash", "extraction_version", "status", "error_message",
			"retry_after", "attempt_count", "created_at", "updated_at",
		},
	}
	for table, cols := range wantCols {
		got := tableColumns(t, d, table)
		if len(got) != len(cols) {
			t.Fatalf("%s: got %d columns %v, want %d %v", table, len(got), got, len(cols), cols)
		}
		for i, c := range cols {
			if got[i] != c {
				t.Fatalf("%s column %d: got %q want %q (full: %v)", table, i, got[i], c, got)
			}
		}
	}
}

func TestSchemaIndexesExist(t *testing.T) {
	d := openTestDB(t)
	wantIdx := []string{
		"idx_memory_records_dedupe_key",
		"idx_memory_records_kind",
		"idx_memory_records_status",
		"idx_memory_records_archive_path",
		"idx_memory_records_observed_at",
		"idx_extraction_state_archive_path",
		"idx_extraction_state_status",
		"idx_extraction_state_retry_after",
	}
	rows, err := d.Query(`SELECT name FROM sqlite_master WHERE type='index'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	have := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		have[n] = true
	}
	for _, idx := range wantIdx {
		if !have[idx] {
			t.Errorf("missing index %s", idx)
		}
	}
}

func TestVecTableDimension(t *testing.T) {
	d := openTestDB(t)
	// vec0 stores its declared schema in sqlite_master; assert float[384].
	var ddl string
	err := d.QueryRow(
		`SELECT sql FROM sqlite_master WHERE name='vec_memory_records'`).Scan(&ddl)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(ddl, "float[384]") {
		t.Fatalf("vec0 ddl missing float[384]: %s", ddl)
	}
}

func TestInsertAndRetrieveMemoryRecord(t *testing.T) {
	d := openTestDB(t)
	id, err := InsertMemoryRecord(d, MemoryRecordInsert{
		Kind:              KindFact,
		Text:              "the sky is blue",
		SourceKind:        "claude-projects",
		ArchivePath:       "/a/b.jsonl",
		LineStart:         1,
		LineEnd:           3,
		ObservedAt:        ptrInt64(1000),
		Project:           ptrString("org/repo"),
		ProjectName:       ptrString("repo"),
		DedupeKey:         "k1",
		ExtractionVersion: 1,
		EmbeddingVersion:  ptrInt64(2),
	})
	if err != nil {
		t.Fatal(err)
	}
	if id <= 0 {
		t.Fatalf("expected positive id, got %d", id)
	}

	var (
		kind, text, dedupe string
		confidence         float64
		status             string
	)
	err = d.QueryRow(
		`SELECT kind, text, dedupe_key, confidence, status FROM memory_records WHERE id=?`, id).
		Scan(&kind, &text, &dedupe, &confidence, &status)
	if err != nil {
		t.Fatal(err)
	}
	if kind != "fact" || text != "the sky is blue" || dedupe != "k1" {
		t.Fatalf("unexpected row: %s %s %s", kind, text, dedupe)
	}
	if confidence != 1.0 {
		t.Fatalf("default confidence: got %v want 1.0", confidence)
	}
	if status != "active" {
		t.Fatalf("default status: got %s want active", status)
	}
}

func TestInsertMemoryRecordUpsertOnConflict(t *testing.T) {
	d := openTestDB(t)
	base := MemoryRecordInsert{
		Kind: KindFact, Text: "v1", SourceKind: "k", ArchivePath: "/a", LineStart: 1, LineEnd: 2,
		DedupeKey: "dup", ExtractionVersion: 1,
	}
	id1, err := InsertMemoryRecord(d, base)
	if err != nil {
		t.Fatal(err)
	}
	// Same scoped dedupe key -> upsert, same id, updated fields.
	upd := base
	upd.Text = "v2"
	upd.Kind = KindEvent
	id2, err := InsertMemoryRecord(d, upd)
	if err != nil {
		t.Fatal(err)
	}
	if id1 != id2 {
		t.Fatalf("upsert should keep id: %d vs %d", id1, id2)
	}
	var text, kind string
	if err := d.QueryRow(`SELECT text, kind FROM memory_records WHERE id=?`, id1).Scan(&text, &kind); err != nil {
		t.Fatal(err)
	}
	if text != "v2" || kind != "event" {
		t.Fatalf("upsert did not update fields: text=%s kind=%s", text, kind)
	}
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM memory_records`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("expected 1 row after upsert, got %d", n)
	}
}

func TestVectorInsertAndKNN(t *testing.T) {
	d := openTestDB(t)
	mk := func(key string, vec []float32) int64 {
		id, err := InsertMemoryRecord(d, MemoryRecordInsert{
			Kind: KindFact, Text: key, SourceKind: "k", ArchivePath: "/a", LineStart: 1, LineEnd: 1,
			DedupeKey: key, ExtractionVersion: 1,
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := InsertMemoryRecordVector(d, id, vec); err != nil {
			t.Fatal(err)
		}
		return id
	}
	nearVec := unit(0) // 1 at index 0
	farVec := unit(1)  // 1 at index 1
	near := mk("near", nearVec)
	_ = mk("far", farVec)

	// Query is mostly aligned with nearVec.
	q := make([]float32, EmbeddingDim)
	q[0] = 0.9
	q[1] = 0.1
	var rowid int64
	var dist float64
	err := d.QueryRow(
		`SELECT rowid, distance FROM vec_memory_records WHERE embedding MATCH ? ORDER BY distance LIMIT 1`,
		serializeVector(q)).Scan(&rowid, &dist)
	if err != nil {
		t.Fatal(err)
	}
	if rowid != near {
		t.Fatalf("KNN nearest = %d, want %d (dist %f)", rowid, near, dist)
	}
}

// TestVectorEncodingLittleEndianFloat32 verifies the raw bytes stored match
// little-endian float32 (matching TS Float32Array.buffer) for index compat.
func TestVectorEncodingLittleEndianFloat32(t *testing.T) {
	vec := make([]float32, EmbeddingDim)
	vec[0] = 1.5
	vec[1] = -2.25
	got := serializeVector(vec)
	if len(got) != EmbeddingDim*4 {
		t.Fatalf("encoded length %d, want %d", len(got), EmbeddingDim*4)
	}
	if b := math.Float32frombits(binary.LittleEndian.Uint32(got[0:4])); b != 1.5 {
		t.Fatalf("byte[0..4] decoded = %v, want 1.5", b)
	}
	if b := math.Float32frombits(binary.LittleEndian.Uint32(got[4:8])); b != -2.25 {
		t.Fatalf("byte[4..8] decoded = %v, want -2.25", b)
	}
}

func TestVectorRoundTrip(t *testing.T) {
	d := openTestDB(t)
	id, err := InsertMemoryRecord(d, MemoryRecordInsert{
		Kind: KindFact, Text: "rt", SourceKind: "k", ArchivePath: "/a", LineStart: 1, LineEnd: 1,
		DedupeKey: "rt", ExtractionVersion: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	in := make([]float32, EmbeddingDim)
	in[0], in[10], in[383] = 0.1, -0.2, 0.99
	if err := InsertMemoryRecordVector(d, id, in); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err := d.QueryRow(`SELECT embedding FROM vec_memory_records WHERE rowid=?`, id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != EmbeddingDim*4 {
		t.Fatalf("stored blob len %d", len(raw))
	}
	for i, want := range in {
		got := math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4 : i*4+4]))
		if got != want {
			t.Fatalf("vec[%d] = %v, want %v", i, got, want)
		}
	}
}

func TestDeleteMemoryIndexForArchivePath(t *testing.T) {
	d := openTestDB(t)
	id, err := InsertMemoryRecord(d, MemoryRecordInsert{
		Kind: KindFact, Text: "x", SourceKind: "k", ArchivePath: "/keep/a.jsonl", LineStart: 1, LineEnd: 1,
		DedupeKey: "x", ExtractionVersion: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := InsertMemoryRecordVector(d, id, unit(0)); err != nil {
		t.Fatal(err)
	}
	if err := UpsertExtractionState(d, ExtractionStateInsert{
		SourceKind: "k", ArchivePath: "/keep/a.jsonl", LineStart: 1, LineEnd: 1,
		SourceHash: "h", ExtractionVersion: 1, Status: ExtractionDone,
	}); err != nil {
		t.Fatal(err)
	}

	if err := DeleteMemoryIndexForArchivePath(d, "/keep/a.jsonl"); err != nil {
		t.Fatal(err)
	}
	assertCount(t, d, "memory_records", 0)
	assertCount(t, d, "vec_memory_records", 0)
	assertCount(t, d, "extraction_state", 0)
}

func TestDeleteMemoryIndexForArchivePathPrefix(t *testing.T) {
	d := openTestDB(t)
	prefix := filepath.Join("/root", "proj")
	child := filepath.Join(prefix, "sub", "c.jsonl")
	sibling := filepath.Join("/root", "other.jsonl")

	insert := func(p, key string) int64 {
		id, err := InsertMemoryRecord(d, MemoryRecordInsert{
			Kind: KindFact, Text: "x", SourceKind: "k", ArchivePath: p, LineStart: 1, LineEnd: 1,
			DedupeKey: key, ExtractionVersion: 1,
		})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	insert(prefix, "k1")  // exact prefix
	insert(child, "k2")   // child under prefix
	insert(sibling, "k3") // unrelated sibling

	if err := DeleteMemoryIndexForArchivePathPrefix(d, prefix); err != nil {
		t.Fatal(err)
	}
	// Only sibling remains.
	assertCount(t, d, "memory_records", 1)
	var remaining string
	if err := d.QueryRow(`SELECT archive_path FROM memory_records`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != sibling {
		t.Fatalf("expected sibling to remain, got %s", remaining)
	}
}

func TestExtractionStateUpsertAndQueries(t *testing.T) {
	d := openTestDB(t)
	key := func(s ExtractionStatus, attempts int64) ExtractionStateInsert {
		return ExtractionStateInsert{
			SourceKind: "k", ArchivePath: "/a", LineStart: 1, LineEnd: 5,
			SourceHash: "h1", ExtractionVersion: 1, Status: s, AttemptCount: attempts,
		}
	}
	if err := UpsertExtractionState(d, key(ExtractionErrored, 1)); err != nil {
		t.Fatal(err)
	}
	// Not completed yet.
	done, err := HasCompletedExtractionState(d, "/a", 1, 5, "h1", 1)
	if err != nil {
		t.Fatal(err)
	}
	if done {
		t.Fatal("errored should not count as completed")
	}
	cnt, err := GetExtractionAttemptCount(d, "/a", 1, 5, "h1", 1)
	if err != nil {
		t.Fatal(err)
	}
	if cnt != 1 {
		t.Fatalf("attempt count = %d, want 1", cnt)
	}

	// Upsert same key -> update, increment attempts, become done.
	if err := UpsertExtractionState(d, key(ExtractionDone, 2)); err != nil {
		t.Fatal(err)
	}
	assertCount(t, d, "extraction_state", 1)
	done, _ = HasCompletedExtractionState(d, "/a", 1, 5, "h1", 1)
	if !done {
		t.Fatal("done should count as completed")
	}
	cnt, _ = GetExtractionAttemptCount(d, "/a", 1, 5, "h1", 1)
	if cnt != 2 {
		t.Fatalf("attempt count after upsert = %d, want 2", cnt)
	}

	// 'empty' also counts as completed.
	emptyKey := key(ExtractionEmpty, 0)
	emptyKey.SourceHash = "h2"
	if err := UpsertExtractionState(d, emptyKey); err != nil {
		t.Fatal(err)
	}
	done, _ = HasCompletedExtractionState(d, "/a", 1, 5, "h2", 1)
	if !done {
		t.Fatal("empty should count as completed")
	}

	// Missing row -> count 0, not completed.
	cnt, _ = GetExtractionAttemptCount(d, "/missing", 0, 0, "nope", 1)
	if cnt != 0 {
		t.Fatalf("missing attempt count = %d, want 0", cnt)
	}
	done, _ = HasCompletedExtractionState(d, "/missing", 0, 0, "nope", 1)
	if done {
		t.Fatal("missing row should not be completed")
	}
}

func TestMigrationsSetUserVersion(t *testing.T) {
	d := openTestDB(t)
	v, err := getUserVersion(d)
	if err != nil {
		t.Fatal(err)
	}
	if v != 1 {
		t.Fatalf("user_version after createSchema = %d, want 1", v)
	}
}

func TestRunMigrationsWithOrderingAndSkip(t *testing.T) {
	d := openTestDB(t) // already at user_version 1
	var ran []int
	ms := []Migration{
		{Version: 3, Name: "c", Up: func(*sql.DB) error { ran = append(ran, 3); return nil }},
		{Version: 1, Name: "a", Up: func(*sql.DB) error { ran = append(ran, 1); return nil }},
		{Version: 2, Name: "b", Up: func(*sql.DB) error { ran = append(ran, 2); return nil }},
	}
	if err := RunMigrationsWith(d, ms); err != nil {
		t.Fatal(err)
	}
	// v1 already applied (current=1); only 2 then 3 run, in order.
	if len(ran) != 2 || ran[0] != 2 || ran[1] != 3 {
		t.Fatalf("ran = %v, want [2 3]", ran)
	}
	v, _ := getUserVersion(d)
	if v != 3 {
		t.Fatalf("user_version = %d, want 3", v)
	}
}

func TestOpenDatabasePersists(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "conversations.db")

	d1, err := OpenDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := InsertMemoryRecord(d1, MemoryRecordInsert{
		Kind: KindFact, Text: "persist", SourceKind: "k", ArchivePath: "/a", LineStart: 1, LineEnd: 1,
		DedupeKey: "p", ExtractionVersion: 1,
	}); err != nil {
		t.Fatal(err)
	}
	d1.Close()

	d2, err := OpenDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	defer d2.Close()
	assertCount(t, d2, "memory_records", 1)
}

func TestInitDatabaseWipes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "conversations.db")

	d1, err := OpenDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := InsertMemoryRecord(d1, MemoryRecordInsert{
		Kind: KindFact, Text: "x", SourceKind: "k", ArchivePath: "/a", LineStart: 1, LineEnd: 1,
		DedupeKey: "x", ExtractionVersion: 1,
	}); err != nil {
		t.Fatal(err)
	}
	d1.Close()

	d2, err := InitDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	defer d2.Close()
	assertCount(t, d2, "memory_records", 0)
}

// --- helpers ---

func tableColumns(t *testing.T, d *sql.DB, table string) []string {
	t.Helper()
	rows, err := d.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var cols []string
	for rows.Next() {
		var (
			cid     int
			name    string
			ctype   string
			notnull int
			dflt    sql.NullString
			pk      int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			t.Fatal(err)
		}
		cols = append(cols, name)
	}
	return cols
}

func assertCount(t *testing.T, d *sql.DB, table string, want int) {
	t.Helper()
	var n int
	if err := d.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != want {
		t.Fatalf("%s count = %d, want %d", table, n, want)
	}
}

func unit(seed int) []float32 {
	v := make([]float32, EmbeddingDim)
	v[seed%EmbeddingDim] = 1
	return v
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
