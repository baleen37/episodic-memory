package indexer

import (
	"database/sql"
	"fmt"
	"strings"

	"github.com/baleen37/memmem/internal/core/sources"
)

// execer is satisfied by both *sql.DB and *sql.Tx, so the index-mutation
// helpers run identically on the live DB and inside a transaction.
type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

func spanKey(lineStart, lineEnd int64) string {
	return fmt.Sprintf("%d:%d", lineStart, lineEnd)
}

// deleteMemoryRecordsByIDs deletes the vec rows and memory_records for ids.
// Ports deleteMemoryRecordsByIds.
func deleteMemoryRecordsByIDs(q execer, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	if _, err := q.Exec(fmt.Sprintf("DELETE FROM vec_memory_records WHERE rowid IN (%s)", ph), args...); err != nil {
		return fmt.Errorf("delete vectors by ids: %w", err)
	}
	if _, err := q.Exec(fmt.Sprintf("DELETE FROM memory_records WHERE id IN (%s)", ph), args...); err != nil {
		return fmt.Errorf("delete memory records by ids: %w", err)
	}
	return nil
}

// deleteMemoryIndexForSpan deletes existing memory_records (and their vectors)
// for the exact span line range. Ports deleteMemoryIndexForSpan.
func deleteMemoryIndexForSpan(q execer, span sources.TranscriptSpan) error {
	rows, err := q.Query(`
		SELECT id FROM memory_records
		WHERE archive_path = ? AND line_start = ? AND line_end = ?
	`, span.ArchivePath, span.LineStart, span.LineEnd)
	if err != nil {
		return fmt.Errorf("select span memory ids: %w", err)
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	return deleteMemoryRecordsByIDs(q, ids)
}

// deleteExtractionStateForSpan deletes the extraction_state rows for the exact
// span line range. Ports deleteExtractionStateForSpan.
func deleteExtractionStateForSpan(q execer, archivePath string, lineStart, lineEnd int64) error {
	if _, err := q.Exec(`
		DELETE FROM extraction_state
		WHERE archive_path = ? AND line_start = ? AND line_end = ?
	`, archivePath, lineStart, lineEnd); err != nil {
		return fmt.Errorf("delete extraction state for span: %w", err)
	}
	return nil
}

// pruneStaleMemoryIndexForArchivePath deletes memory_records and extraction_state
// rows for archivePath whose (line_start,line_end) are not in the current span
// set, handling spans that disappeared after a re-parse.
// Ports pruneStaleMemoryIndexForArchivePath.
func pruneStaleMemoryIndexForArchivePath(q execer, archivePath string, spans []sources.TranscriptSpan) error {
	current := make(map[string]struct{}, len(spans))
	for _, s := range spans {
		current[spanKey(s.LineStart, s.LineEnd)] = struct{}{}
	}

	memRows, err := q.Query(`
		SELECT id, line_start, line_end FROM memory_records WHERE archive_path = ?
	`, archivePath)
	if err != nil {
		return fmt.Errorf("select archive memory rows: %w", err)
	}
	var staleIDs []int64
	for memRows.Next() {
		var id, ls, le int64
		if err := memRows.Scan(&id, &ls, &le); err != nil {
			memRows.Close()
			return err
		}
		if _, ok := current[spanKey(ls, le)]; !ok {
			staleIDs = append(staleIDs, id)
		}
	}
	if err := memRows.Err(); err != nil {
		memRows.Close()
		return err
	}
	memRows.Close()

	stateRows, err := q.Query(`
		SELECT line_start, line_end FROM extraction_state WHERE archive_path = ?
	`, archivePath)
	if err != nil {
		return fmt.Errorf("select archive state rows: %w", err)
	}
	type lr struct{ ls, le int64 }
	staleStates := make(map[string]lr)
	for stateRows.Next() {
		var ls, le int64
		if err := stateRows.Scan(&ls, &le); err != nil {
			stateRows.Close()
			return err
		}
		k := spanKey(ls, le)
		if _, ok := current[k]; !ok {
			staleStates[k] = lr{ls, le}
		}
	}
	if err := stateRows.Err(); err != nil {
		stateRows.Close()
		return err
	}
	stateRows.Close()

	if err := deleteMemoryRecordsByIDs(q, staleIDs); err != nil {
		return err
	}
	for _, s := range staleStates {
		if err := deleteExtractionStateForSpan(q, archivePath, s.ls, s.le); err != nil {
			return err
		}
	}
	return nil
}

// hasPendingRetryExtractionState reports whether the keyed errored span is still
// within its backoff window or has been given up on (retry_after IS NOT NULL AND
// retry_after > now) OR (attempt_count >= AttemptCap AND retry_after IS NULL).
// Ports hasPendingRetryExtractionState; now is injected for testability.
func hasPendingRetryExtractionState(
	q execer,
	archivePath string,
	lineStart, lineEnd int64,
	sourceHash string,
	extractionVersion, now int64,
) (bool, error) {
	var one int
	err := q.QueryRow(`
		SELECT 1 FROM extraction_state
		WHERE archive_path = ? AND line_start = ? AND line_end = ?
		  AND source_hash = ? AND extraction_version = ? AND status = 'errored'
		  AND (
		    (retry_after IS NOT NULL AND retry_after > ?)
		    OR (attempt_count >= ? AND retry_after IS NULL)
		  )
	`, archivePath, lineStart, lineEnd, sourceHash, extractionVersion, now, AttemptCap).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check pending retry: %w", err)
	}
	return true, nil
}
