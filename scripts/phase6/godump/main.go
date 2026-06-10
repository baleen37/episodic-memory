// Dumps full-precision (id, score) JSON for a query against the DB at
// CONVERSATION_MEMORY_DB_PATH, mirroring ts_search_dump.ts. Args: query string.
//
//	CGO_LDFLAGS="-L$(pwd)/poc/lib" go run ./scripts/phase6/godump <query...>
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/baleen37/memmem/internal/core/db"
	"github.com/baleen37/memmem/internal/core/paths"
	"github.com/baleen37/memmem/internal/core/search"
)

type row struct {
	ID    int64    `json:"id"`
	Score *float64 `json:"score"`
}

func main() {
	query := strings.Join(os.Args[1:], " ")
	dbPath, err := paths.DBPath()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	database, err := db.OpenDatabase(dbPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer database.Close()

	results, err := search.Search(context.Background(), query, search.Options{DB: database})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	out := make([]row, len(results))
	for i, r := range results {
		out[i] = row{ID: r.ID, Score: r.Score}
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
