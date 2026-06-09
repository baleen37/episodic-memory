package db

import (
	"database/sql"
	"fmt"
	"path/filepath"
)

// InsertMemoryRecord upserts a memory record on its scoped dedupe key
// (dedupe_key, archive_path, line_start, line_end) and returns the row id.
// Ports insertMemoryRecord from src/core/db.ts.
func InsertMemoryRecord(db *sql.DB, r MemoryRecordInsert) (int64, error) {
	now := nowMillis()

	confidence := 1.0
	if r.Confidence != nil {
		confidence = *r.Confidence
	}
	status := r.Status
	if status == "" {
		status = StatusActive
	}

	_, err := db.Exec(`
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
		string(r.Kind),
		r.Text,
		r.SourceKind,
		r.ArchivePath,
		r.LineStart,
		r.LineEnd,
		nullInt64(r.ObservedAt),
		nullString(r.Project),
		nullString(r.ProjectName),
		confidence,
		string(status),
		nullInt64(r.SupersedesID),
		r.DedupeKey,
		r.ExtractionVersion,
		nullInt64(r.EmbeddingVersion),
		now,
		now,
	)
	if err != nil {
		return 0, fmt.Errorf("insert memory record: %w", err)
	}

	var id int64
	err = db.QueryRow(`
    SELECT id FROM memory_records
    WHERE dedupe_key = ? AND archive_path = ? AND line_start = ? AND line_end = ?
  `, r.DedupeKey, r.ArchivePath, r.LineStart, r.LineEnd).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("resolve memory record for scoped dedupe key %q: %w", r.DedupeKey, err)
	}
	return id, nil
}

// InsertMemoryRecordVector replaces the vector for memoryRecordID with the
// given embedding, encoded as little-endian float32 raw bytes (index-compatible
// with the TS Float32Array.buffer encoding). Ports insertMemoryRecordVector.
func InsertMemoryRecordVector(db *sql.DB, memoryRecordID int64, embedding []float32) error {
	if _, err := db.Exec(`DELETE FROM vec_memory_records WHERE rowid = ?`, memoryRecordID); err != nil {
		return fmt.Errorf("delete vector: %w", err)
	}
	if _, err := db.Exec(
		`INSERT INTO vec_memory_records(rowid, embedding) VALUES (?, ?)`,
		memoryRecordID, serializeVector(embedding),
	); err != nil {
		return fmt.Errorf("insert vector: %w", err)
	}
	return nil
}

// DeleteMemoryIndexForArchivePath deletes all vec rows, memory_records, and
// extraction_state rows for an exact archive_path. Ports the like-named TS fn.
func DeleteMemoryIndexForArchivePath(db *sql.DB, archivePath string) error {
	ids, err := selectMemoryIDs(db, `SELECT id FROM memory_records WHERE archive_path = ?`, archivePath)
	if err != nil {
		return err
	}
	if err := deleteVectors(db, ids); err != nil {
		return err
	}
	if _, err := db.Exec(`DELETE FROM memory_records WHERE archive_path = ?`, archivePath); err != nil {
		return fmt.Errorf("delete memory records: %w", err)
	}
	if _, err := db.Exec(`DELETE FROM extraction_state WHERE archive_path = ?`, archivePath); err != nil {
		return fmt.Errorf("delete extraction state: %w", err)
	}
	return nil
}

// DeleteMemoryIndexForArchivePathPrefix deletes rows for the exact prefix path
// and any child path under it (prefix + path separator + ...). Ports the
// like-named TS fn.
func DeleteMemoryIndexForArchivePathPrefix(db *sql.DB, archivePathPrefix string) error {
	childPrefix := archivePathPrefix + string(filepath.Separator) + "%"
	ids, err := selectMemoryIDs(db,
		`SELECT id FROM memory_records WHERE archive_path = ? OR archive_path LIKE ?`,
		archivePathPrefix, childPrefix)
	if err != nil {
		return err
	}
	if err := deleteVectors(db, ids); err != nil {
		return err
	}
	if _, err := db.Exec(
		`DELETE FROM memory_records WHERE archive_path = ? OR archive_path LIKE ?`,
		archivePathPrefix, childPrefix); err != nil {
		return fmt.Errorf("delete memory records: %w", err)
	}
	if _, err := db.Exec(
		`DELETE FROM extraction_state WHERE archive_path = ? OR archive_path LIKE ?`,
		archivePathPrefix, childPrefix); err != nil {
		return fmt.Errorf("delete extraction state: %w", err)
	}
	return nil
}

func selectMemoryIDs(db *sql.DB, query string, args ...any) ([]int64, error) {
	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("select memory ids: %w", err)
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func deleteVectors(db *sql.DB, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	q := fmt.Sprintf(`DELETE FROM vec_memory_records WHERE rowid IN (%s)`, placeholders(len(ids)))
	if _, err := db.Exec(q, args...); err != nil {
		return fmt.Errorf("delete vectors: %w", err)
	}
	return nil
}

// UpsertExtractionState upserts an extraction_state row on its unique key
// (archive_path, line_start, line_end, source_hash, extraction_version).
// Ports upsertExtractionState.
func UpsertExtractionState(db *sql.DB, s ExtractionStateInsert) error {
	now := nowMillis()
	_, err := db.Exec(`
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
		s.SourceKind,
		s.ArchivePath,
		s.LineStart,
		s.LineEnd,
		s.SourceHash,
		s.ExtractionVersion,
		string(s.Status),
		nullString(s.ErrorMessage),
		nullInt64(s.RetryAfter),
		s.AttemptCount,
		now,
		now,
	)
	if err != nil {
		return fmt.Errorf("upsert extraction state: %w", err)
	}
	return nil
}

// GetExtractionAttemptCount returns the attempt_count for the keyed row, or 0
// if absent. Ports getExtractionAttemptCount.
func GetExtractionAttemptCount(db *sql.DB, archivePath string, lineStart, lineEnd int64, sourceHash string, extractionVersion int64) (int64, error) {
	var count int64
	err := db.QueryRow(`
    SELECT attempt_count FROM extraction_state
    WHERE archive_path = ? AND line_start = ? AND line_end = ?
      AND source_hash = ? AND extraction_version = ?
  `, archivePath, lineStart, lineEnd, sourceHash, extractionVersion).Scan(&count)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("get attempt count: %w", err)
	}
	return count, nil
}

// HasCompletedExtractionState reports whether the keyed row has status 'done'
// or 'empty'. Ports hasCompletedExtractionState.
func HasCompletedExtractionState(db *sql.DB, archivePath string, lineStart, lineEnd int64, sourceHash string, extractionVersion int64) (bool, error) {
	var status string
	err := db.QueryRow(`
    SELECT status FROM extraction_state
    WHERE archive_path = ? AND line_start = ? AND line_end = ?
      AND source_hash = ? AND extraction_version = ?
  `, archivePath, lineStart, lineEnd, sourceHash, extractionVersion).Scan(&status)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("get extraction status: %w", err)
	}
	return status == string(ExtractionDone) || status == string(ExtractionEmpty), nil
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
