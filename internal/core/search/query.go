package search

import (
	"database/sql"
	"fmt"
	"strings"

	"github.com/baleen37/memmem/internal/core/db"
)

// maxKNNK ports MAX_KNN_K: sqlite-vec's knn vec.k cannot exceed 4096, so the
// candidate width is always clamped to this.
const maxKNNK = 4096

// vectorCount ports the `SELECT COUNT(*) FROM vec_memory_records` lookup.
func vectorCount(d *sql.DB) (int, error) {
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) AS count FROM vec_memory_records`).Scan(&n); err != nil {
		return 0, fmt.Errorf("count vectors: %w", err)
	}
	return n, nil
}

// runVectorQuery ports runVectorQuery: it joins vec_memory_records to active
// memory_records by vector distance, applies the filters, orders by ascending
// distance, and returns the top returnCount rows. k is the ANN search width
// (vec.k); returnCount is the final LIMIT. The query vector is bound as
// little-endian float32 bytes via db.SerializeVector, identical to how stored
// vectors were written, so distances are computed correctly.
func runVectorQuery(d *sql.DB, embedding []float32, k, returnCount int, opts Options) ([]MemorySearchResult, error) {
	fp := buildFilterParts(opts)
	query := `
    SELECT
      m.id,
      m.kind,
      m.text,
      m.archive_path,
      m.line_start,
      m.line_end,
      m.source_kind,
      m.project,
      m.observed_at,
      vec.distance
    FROM vec_memory_records vec
    INNER JOIN memory_records m ON m.id = vec.rowid
    WHERE vec.embedding MATCH ?
      AND vec.k = ?
      AND m.status = 'active'
      ` + fp.clause + `
    ORDER BY vec.distance ASC
    LIMIT ?`

	args := make([]any, 0, len(fp.params)+3)
	args = append(args, db.SerializeVector(embedding), k)
	args = append(args, fp.params...)
	args = append(args, returnCount)

	rows, err := d.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("vector query: %w", err)
	}
	defer rows.Close()
	return scanRows(rows, true)
}

// textSearch ports textSearch: a LIKE fallback over active memory_records,
// ORed across the provided queries, ordered by observed_at DESC. No distance is
// selected, so results carry no score.
func textSearch(d *sql.DB, queries []string, opts Options) ([]MemorySearchResult, error) {
	limit := opts.limit()
	fp := buildFilterParts(opts)

	clauses := make([]string, len(queries))
	args := make([]any, 0, len(queries)+len(fp.params)+1)
	for i, q := range queries {
		clauses[i] = `m.text LIKE ? ESCAPE '\'`
		args = append(args, makeLikePattern(q))
	}
	args = append(args, fp.params...)
	args = append(args, limit)

	query := `
    SELECT
      m.id,
      m.kind,
      m.text,
      m.archive_path,
      m.line_start,
      m.line_end,
      m.source_kind,
      m.project,
      m.observed_at
    FROM memory_records m
    WHERE (` + strings.Join(clauses, " OR ") + `)
      AND m.status = 'active'
      ` + fp.clause + `
    ORDER BY m.observed_at DESC
    LIMIT ?`

	rows, err := d.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("text query: %w", err)
	}
	defer rows.Close()
	return scanRows(rows, false)
}

// scanRows scans memory-record columns into results via mapRow. When withDistance
// is true the trailing vec.distance column is read and drives the score.
func scanRows(rows *sql.Rows, withDistance bool) ([]MemorySearchResult, error) {
	var out []MemorySearchResult
	for rows.Next() {
		var (
			r        rowFields
			project  sql.NullString
			observed sql.NullInt64
			distance sql.NullFloat64
		)
		dest := []any{
			&r.id, &r.kind, &r.text, &r.archivePath, &r.lineStart, &r.lineEnd,
			&r.sourceKind, &project, &observed,
		}
		if withDistance {
			dest = append(dest, &distance)
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, fmt.Errorf("scan row: %w", err)
		}
		if project.Valid {
			p := project.String
			r.project = &p
		}
		if observed.Valid {
			o := observed.Int64
			r.observedAt = &o
		}
		if withDistance && distance.Valid {
			dd := distance.Float64
			r.distance = &dd
		}
		out = append(out, mapRow(r))
	}
	return out, rows.Err()
}

// GetMemoryRecordLocation ports getMemoryRecordLocation: it returns the
// provenance triple for an active record, or nil if none.
func GetMemoryRecordLocation(d *sql.DB, id int64) (*MemoryRecordLocation, error) {
	var loc MemoryRecordLocation
	err := d.QueryRow(`
    SELECT
      archive_path,
      line_start,
      line_end
    FROM memory_records
    WHERE id = ? AND status = 'active'
  `, id).Scan(&loc.ArchivePath, &loc.LineStart, &loc.LineEnd)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get memory record location: %w", err)
	}
	return &loc, nil
}
