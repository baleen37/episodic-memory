package cli

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"time"

	"github.com/baleen37/memmem/internal/core/db"
	"github.com/baleen37/memmem/internal/core/paths"
	"github.com/baleen37/memmem/internal/core/read"
	"github.com/baleen37/memmem/internal/core/search"
)

func nowNanos() int64 { return time.Now().UnixNano() }

// openDB opens the production database at the resolved DB path.
func openDB() (*sql.DB, error) {
	dbPath, err := paths.DBPath()
	if err != nil {
		return nil, err
	}
	return db.OpenDatabase(dbPath)
}

// RunSearchCli runs the `search` command, printing compact memory cards to out.
// Ports runSearchCli.
func RunSearchCli(ctx context.Context, out io.Writer, args SearchArgs) error {
	database, err := openDB()
	if err != nil {
		return err
	}
	defer database.Close()

	results, err := search.Search(ctx, args.Query, search.Options{
		DB:         database,
		Limit:      args.Limit,
		After:      args.After,
		Before:     args.Before,
		SourceKind: args.SourceKind,
	})
	if err != nil {
		return err
	}

	for _, r := range results {
		date := "unknown-date"
		if r.ObservedAt != nil {
			date = time.UnixMilli(*r.ObservedAt).UTC().Format("2006-01-02")
		}
		project := "unknown-project"
		if r.Project != nil {
			project = *r.Project
		}
		fmt.Fprintf(out, "## [%s, %s, %s] %s\n", r.Kind, r.SourceKind, date, project)
		fmt.Fprintln(out, r.Text)
		fmt.Fprintf(out, "Source: %s:%d-%d\n", r.ArchivePath, r.LineStart, r.LineEnd)
		if r.Score != nil {
			fmt.Fprintf(out, "Score: %d%%\n", roundPercent(*r.Score))
		}
		fmt.Fprintln(out, "")
	}
	return nil
}

func roundPercent(score float64) int {
	return int(score*100 + 0.5)
}

// RunReadCli runs the `read` command. Returns a non-nil error (used as exit
// signal) when the file is not found. Ports runReadCli.
func RunReadCli(out io.Writer, args ReadArgs) error {
	start := args.StartLine
	end := args.EndLine
	output, ok := read.ReadConversation(args.Path, &start, &end)
	if !ok {
		return fmt.Errorf("File not found: %s", args.Path)
	}
	fmt.Fprintln(out, output)
	return nil
}

// RunStatsCli runs the `stats` command. Ports runStatsCli + getMemoryStats.
func RunStatsCli(out io.Writer) error {
	database, err := openDB()
	if err != nil {
		return err
	}
	defer database.Close()

	q := func(sqlText string) (int, error) { return scalarCount(database, sqlText) }

	total, err := q("SELECT COUNT(*) FROM memory_records")
	if err != nil {
		return err
	}
	active, err := q("SELECT COUNT(*) FROM memory_records WHERE status = 'active'")
	if err != nil {
		return err
	}
	superseded, err := q("SELECT COUNT(*) FROM memory_records WHERE status = 'superseded'")
	if err != nil {
		return err
	}
	facts, err := q("SELECT COUNT(*) FROM memory_records WHERE kind = 'fact'")
	if err != nil {
		return err
	}
	events, err := q("SELECT COUNT(*) FROM memory_records WHERE kind = 'event'")
	if err != nil {
		return err
	}
	missingVectors, err := q(`
		SELECT COUNT(*)
		FROM memory_records m
		LEFT JOIN vec_memory_records v ON v.rowid = m.id
		WHERE m.status = 'active' AND v.rowid IS NULL`)
	if err != nil {
		return err
	}
	extractionErrored, err := q("SELECT COUNT(*) FROM extraction_state WHERE status = 'errored'")
	if err != nil {
		return err
	}

	fmt.Fprintf(out, "Memory records: %d\n", total)
	fmt.Fprintf(out, "Active: %d\n", active)
	fmt.Fprintf(out, "Superseded: %d\n", superseded)
	fmt.Fprintf(out, "Facts: %d\n", facts)
	fmt.Fprintf(out, "Events: %d\n", events)
	fmt.Fprintf(out, "Missing vectors: %d\n", missingVectors)
	fmt.Fprintf(out, "Extraction errors: %d\n", extractionErrored)
	return nil
}

func scalarCount(database *sql.DB, sqlText string, args ...any) (int, error) {
	var n int
	if err := database.QueryRow(sqlText, args...).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}
