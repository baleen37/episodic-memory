package cli

import (
	"database/sql"
	"fmt"
	"io"
)

type diagnosticStatus string

const (
	statusOK   diagnosticStatus = "ok"
	statusWarn diagnosticStatus = "warn"
	statusFail diagnosticStatus = "fail"
)

type diagnosticResult struct {
	name       string
	status     diagnosticStatus
	detail     string
	suggestion string
}

var statusIcon = map[diagnosticStatus]string{
	statusOK:   "✓",
	statusWarn: "⚠",
	statusFail: "✗",
}

// checkBuild reports the build status. Unlike the TS port (which compares dist
// bundles against src mtimes), the Go binary is self-contained, so there is no
// stale-bundle failure mode to detect at runtime; the binary running at all
// means the build is present.
func checkBuild() diagnosticResult {
	return diagnosticResult{name: "build", status: statusOK, detail: "Binary built."}
}

// checkIndex ports checkIndex.
func checkIndex(database *sql.DB) (diagnosticResult, error) {
	v, err := verifyMemoryIndex(database)
	if err != nil {
		return diagnosticResult{}, err
	}
	hard := v.missingArchives + v.invalidProvenance + v.missingVectors + v.orphanVectors
	if hard > 0 {
		return diagnosticResult{
			name:   "index",
			status: statusFail,
			detail: fmt.Sprintf(
				"Integrity issues: %d missing archives, %d invalid provenance, %d missing vectors, %d orphan vectors.",
				v.missingArchives, v.invalidProvenance, v.missingVectors, v.orphanVectors),
			suggestion: "memmem sync",
		}, nil
	}
	if v.retryableExtractionErrs > 0 {
		return diagnosticResult{
			name:       "index",
			status:     statusWarn,
			detail:     fmt.Sprintf("%d retryable extraction error(s).", v.retryableExtractionErrs),
			suggestion: "memmem sync",
		}, nil
	}
	return diagnosticResult{name: "index", status: statusOK, detail: "Memory index integrity verified."}, nil
}

// checkData ports checkData.
func checkData(database *sql.DB) (diagnosticResult, error) {
	active, err := scalarCount(database, "SELECT COUNT(*) FROM memory_records WHERE status = 'active'")
	if err != nil {
		return diagnosticResult{}, err
	}
	missingVectors, err := scalarCount(database, `
		SELECT COUNT(*)
		FROM memory_records m
		LEFT JOIN vec_memory_records v ON v.rowid = m.id
		WHERE m.status = 'active' AND v.rowid IS NULL`)
	if err != nil {
		return diagnosticResult{}, err
	}
	if active == 0 {
		return diagnosticResult{
			name:       "data",
			status:     statusWarn,
			detail:     "No active memory records — nothing has been indexed yet.",
			suggestion: "memmem sync",
		}, nil
	}
	if missingVectors > 0 {
		return diagnosticResult{
			name:       "data",
			status:     statusWarn,
			detail:     fmt.Sprintf("%d active record(s) are not vectorized.", missingVectors),
			suggestion: "memmem sync",
		}, nil
	}
	return diagnosticResult{
		name:   "data",
		status: statusOK,
		detail: fmt.Sprintf("%d active records, all vectorized.", active),
	}, nil
}

// RunDoctorCli runs the `doctor` command. Returns errDoctorFail (sentinel) when
// any check fails so main can set exit code 1. Ports runDoctorCli + runDiagnostics.
func RunDoctorCli(out io.Writer) error {
	database, err := openDB()
	if err != nil {
		return err
	}
	defer database.Close()

	idx, err := checkIndex(database)
	if err != nil {
		return err
	}
	data, err := checkData(database)
	if err != nil {
		return err
	}
	results := []diagnosticResult{checkBuild(), idx, data}

	hasFail, hasWarn := false, false
	for _, r := range results {
		fmt.Fprintf(out, "%s %s: %s\n", statusIcon[r.status], r.name, r.detail)
		if r.suggestion != "" {
			fmt.Fprintf(out, "    → run: %s\n", r.suggestion)
		}
		if r.status == statusFail {
			hasFail = true
		}
		if r.status == statusWarn {
			hasWarn = true
		}
	}

	if hasFail {
		return ErrDoctorFail
	}
	if hasWarn {
		fmt.Fprintln(out, "\nmemmem is usable, but some checks need attention.")
	} else {
		fmt.Fprintln(out, "\nmemmem is healthy.")
	}
	return nil
}

// ErrDoctorFail is a sentinel indicating one or more doctor checks failed
// (exit code 1) without an underlying error.
var ErrDoctorFail = fmt.Errorf("doctor checks failed")
