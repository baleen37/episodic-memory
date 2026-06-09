// Phase 6 index-equivalence harness (Go side).
// Inserts the shared corpus + Go EmbedPassage vectors into the DB at
// CONVERSATION_MEMORY_DB_PATH, mirroring scripts/phase6/ts_insert.ts.
// Build with the tokenizer static lib on the linker path, e.g.:
//
//	CGO_LDFLAGS="-L$(pwd)/poc/lib" go run ./scripts/phase6/goinsert
package main

import (
	"fmt"
	"os"

	"github.com/baleen37/memmem/internal/core/db"
	"github.com/baleen37/memmem/internal/core/embeddings"
	"github.com/baleen37/memmem/internal/core/paths"
)

func main() {
	dbPath, err := paths.DBPath()
	if err != nil {
		fmt.Fprintln(os.Stderr, "db path:", err)
		os.Exit(1)
	}
	database, err := db.OpenDatabase(dbPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open db:", err)
		os.Exit(1)
	}
	defer database.Close()

	ev := int64(2)
	for _, r := range Corpus {
		observed := r.ObservedAt
		project := r.Project
		id, err := db.InsertMemoryRecord(database, db.MemoryRecordInsert{
			Kind:              db.MemoryRecordKind(r.Kind),
			Text:              r.Text,
			SourceKind:        r.SourceKind,
			ArchivePath:       r.ArchivePath,
			LineStart:         r.LineStart,
			LineEnd:           r.LineEnd,
			ObservedAt:        &observed,
			Project:           &project,
			Status:            db.StatusActive,
			DedupeKey:         r.DedupeKey,
			ExtractionVersion: 1,
			EmbeddingVersion:  &ev,
		})
		if err != nil {
			fmt.Fprintln(os.Stderr, "insert record:", err)
			os.Exit(1)
		}
		emb, err := embeddings.EmbedPassage(r.Text)
		if err != nil {
			fmt.Fprintln(os.Stderr, "embed:", err)
			os.Exit(1)
		}
		if err := db.InsertMemoryRecordVector(database, id, emb); err != nil {
			fmt.Fprintln(os.Stderr, "insert vector:", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "inserted id=%d key=%s\n", id, r.DedupeKey)
	}
	fmt.Fprintln(os.Stderr, "Go insert done")
}
