package indexer

import (
	"database/sql"
	"fmt"
	"time"

	sqlite_vec "github.com/asg017/sqlite-vec-go-bindings/ncruces"
	"github.com/baleen37/memmem/internal/core/db"
)

// nowMillis returns the current epoch millis (matches Date.now()).
func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// txInsertMemoryRecord mirrors db.InsertMemoryRecord but runs on a *sql.Tx so
// the span-replacement block is atomic. The SQL is identical to db's helper
// (same scoped upsert on (dedupe_key, archive_path, line_start, line_end)),
// keeping index compatibility.
func txInsertMemoryRecord(tx *sql.Tx, r db.MemoryRecordInsert) (int64, error) {
	now := nowMillis()

	confidence := 1.0
	if r.Confidence != nil {
		confidence = *r.Confidence
	}
	status := r.Status
	if status == "" {
		status = db.StatusActive
	}

	_, err := tx.Exec(`
    INSERT INTO memory_records (
      kind, text, source_kind, archive_path, line_start, line_end,
      observed_at, project, project_name, confidence, status, supersedes_id,
      dedupe_key, extraction_version, embedding_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key, archive_path, line_start, line_end) DO UPDATE SET
      kind = excluded.kind,
      text = excluded.text,
      source_kind = excluded.source_kind,
      observed_at = excluded.observed_at,
      project = excluded.project,
      project_name = excluded.project_name,
      confidence = excluded.confidence,
      status = excluded.status,
      supersedes_id = excluded.supersedes_id,
      extraction_version = excluded.extraction_version,
      embedding_version = excluded.embedding_version,
      updated_at = excluded.updated_at
  `,
		string(r.Kind), r.Text, r.SourceKind, r.ArchivePath, r.LineStart, r.LineEnd,
		nullInt64(r.ObservedAt), nullString(r.Project), nullString(r.ProjectName),
		confidence, string(status), nullInt64(r.SupersedesID), r.DedupeKey,
		r.ExtractionVersion, nullInt64(r.EmbeddingVersion), now, now,
	)
	if err != nil {
		return 0, fmt.Errorf("insert memory record: %w", err)
	}

	var id int64
	err = tx.QueryRow(`
    SELECT id FROM memory_records
    WHERE dedupe_key = ? AND archive_path = ? AND line_start = ? AND line_end = ?
  `, r.DedupeKey, r.ArchivePath, r.LineStart, r.LineEnd).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("resolve memory record for scoped dedupe key %q: %w", r.DedupeKey, err)
	}
	return id, nil
}

// txInsertMemoryRecordVector mirrors db.InsertMemoryRecordVector on a *sql.Tx.
func txInsertMemoryRecordVector(tx *sql.Tx, memoryRecordID int64, embedding []float32) error {
	if _, err := tx.Exec(`DELETE FROM vec_memory_records WHERE rowid = ?`, memoryRecordID); err != nil {
		return fmt.Errorf("delete vector: %w", err)
	}
	blob, err := sqlite_vec.SerializeFloat32(embedding)
	if err != nil {
		return fmt.Errorf("serialize vector: %w", err)
	}
	if _, err := tx.Exec(
		`INSERT INTO vec_memory_records(rowid, embedding) VALUES (?, ?)`,
		memoryRecordID, blob,
	); err != nil {
		return fmt.Errorf("insert vector: %w", err)
	}
	return nil
}

// txUpsertExtractionState mirrors db.UpsertExtractionState on a *sql.Tx.
func txUpsertExtractionState(tx *sql.Tx, s db.ExtractionStateInsert) error {
	now := nowMillis()
	_, err := tx.Exec(`
    INSERT INTO extraction_state (
      source_kind, archive_path, line_start, line_end, source_hash,
      extraction_version, status, error_message, retry_after, attempt_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(archive_path, line_start, line_end, source_hash, extraction_version)
    DO UPDATE SET
      source_kind = excluded.source_kind,
      status = excluded.status,
      error_message = excluded.error_message,
      retry_after = excluded.retry_after,
      attempt_count = excluded.attempt_count,
      updated_at = excluded.updated_at
  `,
		s.SourceKind, s.ArchivePath, s.LineStart, s.LineEnd, s.SourceHash,
		s.ExtractionVersion, string(s.Status), nullString(s.ErrorMessage),
		nullInt64(s.RetryAfter), s.AttemptCount, now, now,
	)
	if err != nil {
		return fmt.Errorf("upsert extraction state: %w", err)
	}
	return nil
}

func nullInt64(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullString(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}
