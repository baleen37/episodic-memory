package cli

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/baleen37/memmem/internal/core/db"
	"github.com/baleen37/memmem/internal/core/indexer"
)

// setupSyncEnv points the source adapters, archive, and DB at temp locations and
// returns the source/archive directories. Provider is left unconfigured (HOME
// points at a temp dir with no config.json), so extraction is skipped — this
// keeps these tests CGO-free.
func setupSyncEnv(t *testing.T) (claudeDir, codexDir, archiveDir string) {
	t.Helper()
	root := t.TempDir()
	claudeDir = filepath.Join(root, ".claude")
	codexDir = filepath.Join(root, ".codex")
	archiveDir = filepath.Join(root, "archive")

	t.Setenv("CLAUDE_CONFIG_DIR", claudeDir)
	t.Setenv("CODEX_HOME", codexDir)
	t.Setenv("TEST_ARCHIVE_DIR", archiveDir)
	t.Setenv("HOME", root)
	t.Setenv("GO_TEST", "1")
	return claudeDir, codexDir, archiveDir
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

func writeClaudeTranscript(t *testing.T, filePath, userText, assistantText string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		t.Fatal(err)
	}
	lines := []map[string]any{
		{"type": "user", "timestamp": "2026-05-26T00:00:00.000Z", "sessionId": "s1", "message": map[string]any{"role": "user", "content": userText}},
		{"type": "assistant", "timestamp": "2026-05-26T00:00:01.000Z", "sessionId": "s1", "message": map[string]any{"role": "assistant", "content": assistantText}},
	}
	writeJSONL(t, filePath, lines)
}

func writeJSONL(t *testing.T, filePath string, objs []map[string]any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		t.Fatal(err)
	}
	var buf []byte
	for i, o := range objs {
		b, err := json.Marshal(o)
		if err != nil {
			t.Fatal(err)
		}
		if i > 0 {
			buf = append(buf, '\n')
		}
		buf = append(buf, b...)
	}
	if err := os.WriteFile(filePath, buf, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSyncCopiesUnderSourceKindPrefixes(t *testing.T) {
	claudeDir, codexDir, archiveDir := setupSyncEnv(t)
	database := newTestDB(t)

	writeClaudeTranscript(t, filepath.Join(claudeDir, "projects", "proj", "session.jsonl"), "Question", "Answer")
	writeJSONL(t, filepath.Join(codexDir, "sessions", "rollout.jsonl"), []map[string]any{
		{"type": "session_meta", "payload": map[string]any{"id": "c1", "cwd": "/repo"}},
		{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "Run tests"}}}},
		{"type": "response_item", "payload": map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "Passed"}}}},
	})

	result, err := SyncTranscripts(context.Background(), database, indexer.Options{})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}

	if result.Copied != 2 {
		t.Errorf("Copied = %d, want 2", result.Copied)
	}
	if result.Archived != 2 {
		t.Errorf("Archived = %d, want 2", result.Archived)
	}
	if result.SpansConsidered != 2 {
		t.Errorf("SpansConsidered = %d, want 2", result.SpansConsidered)
	}
	// Provider is nil → every span is skipped, none indexed.
	if result.SpansSkipped != 2 {
		t.Errorf("SpansSkipped = %d, want 2", result.SpansSkipped)
	}
	if result.MemoryRecordsIndexed != 0 {
		t.Errorf("MemoryRecordsIndexed = %d, want 0", result.MemoryRecordsIndexed)
	}
	if !pathExists(filepath.Join(archiveDir, "claude-projects", "proj", "session.jsonl")) {
		t.Error("claude archive missing")
	}
	if !pathExists(filepath.Join(archiveDir, "codex-sessions", "rollout.jsonl")) {
		t.Error("codex archive missing")
	}
}

func TestSyncCountsArchivedSeparatelyFromSpans(t *testing.T) {
	claudeDir, _, _ := setupSyncEnv(t)
	database := newTestDB(t)

	sourcePath := filepath.Join(claudeDir, "projects", "proj", "session.jsonl")
	if err := os.MkdirAll(filepath.Dir(sourcePath), 0o755); err != nil {
		t.Fatal(err)
	}
	writeJSONL(t, sourcePath, []map[string]any{
		{"type": "user", "timestamp": "2026-05-26T00:00:00.000Z", "sessionId": "s1", "message": map[string]any{"role": "user", "content": "First question"}},
		{"type": "assistant", "timestamp": "2026-05-26T00:00:01.000Z", "sessionId": "s1", "message": map[string]any{"role": "assistant", "content": "First answer"}},
		{"type": "user", "timestamp": "2026-05-26T00:00:02.000Z", "sessionId": "s1", "message": map[string]any{"role": "user", "content": "Second question"}},
		{"type": "assistant", "timestamp": "2026-05-26T00:00:03.000Z", "sessionId": "s1", "message": map[string]any{"role": "assistant", "content": "Second answer"}},
	})

	result, err := SyncTranscripts(context.Background(), database, indexer.Options{})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if result.Archived != 1 {
		t.Errorf("Archived = %d, want 1", result.Archived)
	}
	if result.SpansConsidered != 2 {
		t.Errorf("SpansConsidered = %d, want 2", result.SpansConsidered)
	}
	if result.SpansSkipped != 2 {
		t.Errorf("SpansSkipped = %d, want 2", result.SpansSkipped)
	}
}

func TestSyncExcludesNoMemmemDirectory(t *testing.T) {
	claudeDir, _, archiveDir := setupSyncEnv(t)
	database := newTestDB(t)

	ignoredDir := filepath.Join(claudeDir, "projects", "ignored")
	if err := os.MkdirAll(ignoredDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ignoredDir, ".no-memmem"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	writeClaudeTranscript(t, filepath.Join(ignoredDir, "session.jsonl"), "Secret question", "Secret answer")

	result, err := SyncTranscripts(context.Background(), database, indexer.Options{})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if result.Copied != 0 || result.Archived != 0 {
		t.Errorf("Copied=%d Archived=%d, want 0/0", result.Copied, result.Archived)
	}
	if pathExists(filepath.Join(archiveDir, "claude-projects", "ignored", "session.jsonl")) {
		t.Error("excluded transcript should not be archived")
	}
}

func TestSyncPurgesNewlyExcludedSubtree(t *testing.T) {
	claudeDir, _, archiveDir := setupSyncEnv(t)
	database := newTestDB(t)

	sourceDir := filepath.Join(claudeDir, "projects", "proj")
	sourcePath := filepath.Join(sourceDir, "session.jsonl")
	archivePath := filepath.Join(archiveDir, "claude-projects", "proj", "session.jsonl")
	writeClaudeTranscript(t, sourcePath, "Secret question", "Secret answer")

	if _, err := SyncTranscripts(context.Background(), database, indexer.Options{}); err != nil {
		t.Fatalf("first sync: %v", err)
	}
	seedMemoryRecord(t, database, archivePath)

	// Now exclude the source directory.
	if err := os.WriteFile(filepath.Join(sourceDir, ".no-memmem"), nil, 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := SyncTranscripts(context.Background(), database, indexer.Options{})
	if err != nil {
		t.Fatalf("second sync: %v", err)
	}
	if result.Archived != 0 {
		t.Errorf("Archived = %d, want 0", result.Archived)
	}
	if n, _ := scalarCount(database, "SELECT COUNT(*) FROM memory_records WHERE archive_path = ?", archivePath); n != 0 {
		t.Errorf("memory_records = %d, want 0", n)
	}
	if n, _ := scalarCount(database, "SELECT COUNT(*) FROM extraction_state WHERE archive_path = ?", archivePath); n != 0 {
		t.Errorf("extraction_state = %d, want 0", n)
	}
	if pathExists(archivePath) {
		t.Error("archive file should have been purged")
	}
}

func TestSyncContinuesWhenCopyFails(t *testing.T) {
	claudeDir, _, archiveDir := setupSyncEnv(t)
	database := newTestDB(t)

	failingSourceDir := filepath.Join(claudeDir, "projects", "blocked")
	otherSourceDir := filepath.Join(claudeDir, "projects", "proj")
	writeClaudeTranscript(t, filepath.Join(failingSourceDir, "session.jsonl"), "Failing question", "Failing answer")
	writeClaudeTranscript(t, filepath.Join(otherSourceDir, "existing.jsonl"), "Existing question", "Existing answer")
	writeClaudeTranscript(t, filepath.Join(otherSourceDir, "other.jsonl"), "Other question", "Other answer")

	existingArchivePath := filepath.Join(archiveDir, "claude-projects", "proj", "existing.jsonl")
	if err := os.MkdirAll(filepath.Dir(existingArchivePath), 0o755); err != nil {
		t.Fatal(err)
	}
	writeClaudeTranscript(t, existingArchivePath, "Archived question", "Archived answer")
	// Block the copy destination directory by placing a FILE where the adapter
	// would create a directory.
	blockedArchivePath := filepath.Join(archiveDir, "claude-projects", "blocked")
	if err := os.WriteFile(blockedArchivePath, []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Second)
	if err := os.Chtimes(existingArchivePath, future, future); err != nil {
		t.Fatal(err)
	}

	result, err := SyncTranscripts(context.Background(), database, indexer.Options{})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if result.Copied != 1 {
		t.Errorf("Copied = %d, want 1", result.Copied)
	}
	if result.Archived != 2 {
		t.Errorf("Archived = %d, want 2", result.Archived)
	}
	if pathExists(filepath.Join(archiveDir, "claude-projects", "blocked", "session.jsonl")) {
		t.Error("blocked transcript should not be archived")
	}
	if !pathExists(existingArchivePath) {
		t.Error("existing archive should remain")
	}
	if !pathExists(filepath.Join(archiveDir, "claude-projects", "proj", "other.jsonl")) {
		t.Error("other transcript should be archived")
	}
}

func TestCopyIfNewerSkipsWhenDestNewer(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.jsonl")
	dst := filepath.Join(dir, "dst.jsonl")
	if err := os.WriteFile(src, []byte("source"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, []byte("dest"), 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(dst, future, future); err != nil {
		t.Fatal(err)
	}

	copied, err := copyIfNewer(src, dst)
	if err != nil {
		t.Fatalf("copyIfNewer: %v", err)
	}
	if copied {
		t.Error("expected skip when dest is newer")
	}
	if b, _ := os.ReadFile(dst); string(b) != "dest" {
		t.Errorf("dest overwritten: %q", b)
	}
}

func TestCopyIfNewerCopiesWhenSourceNewer(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.jsonl")
	dst := filepath.Join(dir, "nested", "dst.jsonl")
	if err := os.WriteFile(src, []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}

	copied, err := copyIfNewer(src, dst)
	if err != nil {
		t.Fatalf("copyIfNewer: %v", err)
	}
	if !copied {
		t.Error("expected copy")
	}
	if b, _ := os.ReadFile(dst); string(b) != "payload" {
		t.Errorf("dest = %q, want payload", b)
	}
	// No leftover tmp files.
	entries, _ := os.ReadDir(filepath.Dir(dst))
	for _, e := range entries {
		if e.Name() != "dst.jsonl" {
			t.Errorf("unexpected leftover %q", e.Name())
		}
	}
}

func seedMemoryRecord(t *testing.T, database *sql.DB, archivePath string) {
	t.Helper()
	observedAt := time.Date(2026, 5, 26, 0, 0, 0, 0, time.UTC).UnixMilli()
	proj := "proj"
	emb := int64(db.CurrentEmbeddingVersion)
	id, err := db.InsertMemoryRecord(database, db.MemoryRecordInsert{
		Kind:              db.KindFact,
		Text:              "Seeded memory record.",
		SourceKind:        "claude-projects",
		ArchivePath:       archivePath,
		LineStart:         1,
		LineEnd:           2,
		ObservedAt:        &observedAt,
		Project:           &proj,
		Status:            db.StatusActive,
		DedupeKey:         "seed:" + archivePath,
		ExtractionVersion: db.CurrentExtractionVersion,
		EmbeddingVersion:  &emb,
	})
	if err != nil {
		t.Fatalf("insert memory record: %v", err)
	}
	vec := make([]float32, 384)
	for i := range vec {
		vec[i] = 0.1
	}
	if err := db.InsertMemoryRecordVector(database, id, vec); err != nil {
		t.Fatalf("insert vector: %v", err)
	}
	if err := db.UpsertExtractionState(database, db.ExtractionStateInsert{
		SourceKind:        "claude-projects",
		ArchivePath:       archivePath,
		LineStart:         1,
		LineEnd:           2,
		SourceHash:        "seed-hash",
		ExtractionVersion: db.CurrentExtractionVersion,
		Status:            db.ExtractionDone,
	}); err != nil {
		t.Fatalf("upsert extraction state: %v", err)
	}
}
