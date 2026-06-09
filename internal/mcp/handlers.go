package mcp

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"strconv"

	"github.com/baleen37/memmem/internal/core/read"
	"github.com/baleen37/memmem/internal/core/search"
)

// SearchResult is the compact memory card returned by the search tool. Ports
// the TS SearchResult interface: { id: string; kind; text; score? }. Score is a
// pointer so it is omitted when absent (matching the TS optional field).
type SearchResult struct {
	ID    string   `json:"id"`
	Kind  string   `json:"kind"`
	Text  string   `json:"text"`
	Score *float64 `json:"score,omitempty"`
}

// testEmbedder, when non-nil, overrides the search embedder. It is the Go
// analog of the TS __setModelForTests hook: production leaves it nil (the
// default CGO embedder is used), while CGO-free tests inject a mock so the
// search path never loads the ONNX model. Set only from _test.go.
var testEmbedder search.Embedder

// HandleSearch ports handleSearch(params, db): array query -> searchMulti, else
// search; options carry { db, limit, after, before } (NOTE: source_kind is in
// the tool schema but, matching the TS handler, is NOT passed to the search
// options). Results are mapped to compact cards with stringified ids and score
// rounded to 3 decimals when present.
func HandleSearch(ctx context.Context, in SearchInput, db *sql.DB) ([]SearchResult, error) {
	opts := search.Options{
		DB:       db,
		Limit:    in.Limit,
		After:    in.After,
		Before:   in.Before,
		Embedder: testEmbedder,
	}

	var results []search.MemorySearchResult
	var err error
	if in.IsArray {
		results, err = search.SearchMulti(ctx, in.QueryArray, opts)
	} else {
		results, err = search.Search(ctx, in.QueryString, opts)
	}
	if err != nil {
		return nil, err
	}

	cards := make([]SearchResult, 0, len(results))
	for _, r := range results {
		card := SearchResult{
			ID:   strconv.FormatInt(r.ID, 10),
			Kind: r.Kind,
			Text: r.Text,
		}
		if r.Score != nil {
			// Ports Math.round(score * 1000) / 1000.
			rounded := math.Round(*r.Score*1000) / 1000
			card.Score = &rounded
		}
		cards = append(cards, card)
	}
	return cards, nil
}

// HandleFetch ports handleFetch(params, db): resolve the id to an integer
// (string ids are parsed; non-integers error), look up the record location,
// then render the archived transcript. The error messages match the TS exactly.
func HandleFetch(in FetchInput, db *sql.DB) (string, error) {
	id, ok := resolveID(in)
	if !ok {
		return "", fmt.Errorf("Invalid memory record id: %s", rawID(in))
	}

	location, err := search.GetMemoryRecordLocation(db, id)
	if err != nil {
		return "", err
	}
	if location == nil {
		return "", fmt.Errorf("Memory record not found: %d", id)
	}

	start := int(location.LineStart)
	end := int(location.LineEnd)
	result, found := read.ReadConversation(location.ArchivePath, &start, &end)
	if !found {
		return "", fmt.Errorf("Archive file not found for memory record %d: %s", id, location.ArchivePath)
	}
	return result, nil
}

// resolveID ports `const id = typeof params.id === 'string' ? Number(params.id) : params.id`
// followed by `Number.isInteger(id)`. A string id is parsed as a JS Number
// (which accepts floats and "0x.." etc., but we only accept inputs that resolve
// to an integer, matching Number.isInteger). A numeric id must be integral.
func resolveID(in FetchInput) (int64, bool) {
	if in.IsString {
		// JS Number("1") -> 1; Number("1.5") -> 1.5 (not integer); Number("abc") -> NaN.
		f, err := strconv.ParseFloat(in.IDString, 64)
		if err != nil {
			return 0, false
		}
		if f != math.Trunc(f) || math.IsInf(f, 0) {
			return 0, false
		}
		return int64(f), true
	}
	if in.IDNumber != math.Trunc(in.IDNumber) {
		return 0, false
	}
	return int64(in.IDNumber), true
}

// rawID renders the original id for the "Invalid memory record id: <id>"
// message, matching String(params.id) in TS.
func rawID(in FetchInput) string {
	if in.IsString {
		return in.IDString
	}
	return strconv.FormatFloat(in.IDNumber, 'g', -1, 64)
}
