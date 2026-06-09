package cli

import (
	"bufio"
	"database/sql"
	"fmt"
	"io"
	"os"
	"time"
)

// verificationResult holds the counts the verify/doctor commands report. Ports
// the VerificationResult interface (as counts; the TS arrays are only ever used
// by .length).
type verificationResult struct {
	missingArchives         int
	invalidProvenance       int
	missingVectors          int
	orphanVectors           int
	retryableExtractionErrs int
}

// verifyMemoryIndex ports verifyMemoryIndex.
func verifyMemoryIndex(database *sql.DB) (verificationResult, error) {
	var res verificationResult

	rows, err := database.Query(`
		SELECT archive_path, line_start, line_end
		FROM memory_records
		WHERE status = 'active'
		ORDER BY id ASC`)
	if err != nil {
		return res, err
	}
	lineCounts := map[string]int{}
	type rec struct {
		archivePath          string
		lineStart, lineEnd   int
	}
	var records []rec
	for rows.Next() {
		var r rec
		if err := rows.Scan(&r.archivePath, &r.lineStart, &r.lineEnd); err != nil {
			rows.Close()
			return res, err
		}
		records = append(records, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return res, err
	}

	for _, r := range records {
		if !pathExists(r.archivePath) {
			res.missingArchives++
			continue
		}
		lineCount, ok := lineCounts[r.archivePath]
		if !ok {
			lineCount = countLines(r.archivePath)
			lineCounts[r.archivePath] = lineCount
		}
		if r.lineStart < 1 || r.lineEnd < r.lineStart || r.lineEnd > lineCount {
			res.invalidProvenance++
		}
	}

	res.missingVectors, err = scalarCount(database, `
		SELECT COUNT(*)
		FROM memory_records m
		LEFT JOIN vec_memory_records v ON v.rowid = m.id
		WHERE m.status = 'active' AND v.rowid IS NULL`)
	if err != nil {
		return res, err
	}

	res.orphanVectors, err = scalarCount(database, `
		SELECT COUNT(*)
		FROM vec_memory_records v
		LEFT JOIN memory_records m ON m.id = v.rowid
		WHERE m.id IS NULL`)
	if err != nil {
		return res, err
	}

	res.retryableExtractionErrs, err = scalarCount(database,
		"SELECT COUNT(*) FROM extraction_state WHERE status = 'errored' AND retry_after <= ?",
		time.Now().UnixMilli())
	if err != nil {
		return res, err
	}

	return res, nil
}

// countLines ports the TS countLines: number of newline-terminated lines, or the
// split count when there is no trailing newline. Returns 0 for an empty file.
func countLines(filePath string) int {
	f, err := os.Open(filePath)
	if err != nil {
		return 0
	}
	defer f.Close()

	r := bufio.NewReader(f)
	var lines, lastByte int = 0, 0
	empty := true
	for {
		b, err := r.ReadByte()
		if err != nil {
			break
		}
		empty = false
		lastByte = int(b)
		if b == '\n' {
			lines++
		}
	}
	if empty {
		return 0
	}
	if lastByte != '\n' {
		lines++ // trailing content without a final newline counts as a line
	}
	return lines
}

// RunVerifyCli runs the `verify` command. Returns a non-nil error (sentinel)
// when issues are found so main can set exit code 1. Ports runVerifyCli.
func RunVerifyCli(out io.Writer) error {
	database, err := openDB()
	if err != nil {
		return err
	}
	defer database.Close()

	v, err := verifyMemoryIndex(database)
	if err != nil {
		return err
	}
	issueCount := v.missingArchives + v.invalidProvenance + v.missingVectors +
		v.orphanVectors + v.retryableExtractionErrs

	if issueCount == 0 {
		fmt.Fprintln(out, "No memory index issues found.")
		return nil
	}

	fmt.Fprintf(out, "Memory index issues: %d\n", issueCount)
	fmt.Fprintf(out, "Missing archives: %d\n", v.missingArchives)
	fmt.Fprintf(out, "Invalid provenance: %d\n", v.invalidProvenance)
	fmt.Fprintf(out, "Missing vectors: %d\n", v.missingVectors)
	fmt.Fprintf(out, "Orphan vectors: %d\n", v.orphanVectors)
	fmt.Fprintf(out, "Retryable extraction errors: %d\n", v.retryableExtractionErrs)
	return ErrVerifyIssues
}

// ErrVerifyIssues is a sentinel indicating verify found issues (exit code 1)
// without an underlying failure.
var ErrVerifyIssues = fmt.Errorf("memory index issues found")
