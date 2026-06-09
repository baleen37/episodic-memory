// Package search implements hybrid vector-first + text-fallback memory search.
//
// Ports src/core/search.ts: embed the query, search vec_memory_records joined
// to active memory_records by vector distance, supplement with text matches,
// deduplicate, and return compact source-linked memory cards. searchMulti adds
// a multi-query AND mode: candidates from each query are intersected (only IDs
// matched by every query survive) and scored by the mean of their per-query
// vector scores.
package search

import (
	"context"
	"database/sql"
	"sort"
	"strings"
)

const defaultLimit = 10

// QueryNormalizer is the provider-shaped hook that rewrites a raw query (e.g.
// translating to concise English) before embedding. It ports the TS
// QueryNormalizerProvider{ complete(prompt) -> {text} }. The real LLM provider
// (Phase 3) will satisfy this; for now the no-provider identity path is what
// matters. A non-nil error or empty result falls back to the original query.
type QueryNormalizer interface {
	Complete(ctx context.Context, prompt string) (string, error)
}

// Embedder produces a query embedding. It defaults to embeddings.EmbedQuery
// (wired in embedder.go); tests inject a mock to stay CGO-free. A nil return
// (no embedding available) yields no vector results, matching the TS
// `if (!embedding) return []`.
type Embedder func(text string) ([]float32, error)

// Options carries the DB handle and the search parameters. It ports the TS
// SearchOptions. Empty After/Before/SourceKind mean "no filter"; nil/empty
// Projects/Files mean "no filter". Limit <= 0 defaults to 10.
type Options struct {
	DB              *sql.DB
	Limit           int
	After           string
	Before          string
	SourceKind      string
	Projects        []string
	Files           []string
	QueryNormalizer QueryNormalizer
	// Embedder overrides the embedding function. When nil, the default
	// (embeddings.EmbedQuery) is used. Set by tests to avoid the CGO model.
	Embedder Embedder
}

func (o Options) limit() int {
	if o.Limit <= 0 {
		return defaultLimit
	}
	return o.Limit
}

func (o Options) embedder() Embedder {
	if o.Embedder != nil {
		return o.Embedder
	}
	return defaultEmbedder
}

// validateDates ports the after/before validation guard shared by search and
// searchMulti.
func validateDates(opts Options) error {
	if opts.After != "" {
		if err := validateISODate(opts.After, "--after"); err != nil {
			return err
		}
	}
	if opts.Before != "" {
		if err := validateISODate(opts.Before, "--before"); err != nil {
			return err
		}
	}
	return nil
}

// normalizeQuery ports normalizeQuery: with no provider it is the identity; with
// a provider it returns the trimmed completion, falling back to the original
// query on an empty result or any provider error.
func normalizeQuery(ctx context.Context, query string, provider QueryNormalizer) string {
	if provider == nil {
		return query
	}
	result, err := provider.Complete(ctx,
		"Normalize this search query to concise English. Return only the normalized query.\n\nQuery: "+query)
	if err != nil {
		return query
	}
	normalized := strings.TrimSpace(result)
	if normalized == "" {
		return query
	}
	return normalized
}

// vectorSearch ports vectorSearch: embed the query, clamp k, and run the vector
// query. A nil embedding yields no results.
func vectorSearch(query string, opts Options) ([]MemorySearchResult, error) {
	limit := opts.limit()
	embedding, err := opts.embedder()(query)
	if err != nil {
		return nil, err
	}
	if embedding == nil {
		return nil, nil
	}

	count, err := vectorCount(opts.DB)
	if err != nil {
		return nil, err
	}
	// k = min(vectorCount, MAX_KNN_K, max(limit*64, 1000)).
	k := minInt(count, maxKNNK, maxInt(limit*64, 1000))
	return runVectorQuery(opts.DB, embedding, k, limit, opts)
}

// Search ports search(): hybrid vector-first + text fallback with dedupe. The
// vector path is searched on the normalized query; the text fallback searches
// the original query (and the normalized query too when it differs). Results are
// combined with vector results winning over text results for the same id, then
// truncated to the limit.
func Search(ctx context.Context, query string, opts Options) ([]MemorySearchResult, error) {
	if err := validateDates(opts); err != nil {
		return nil, err
	}
	limit := opts.limit()

	normalized := normalizeQuery(ctx, query, opts.QueryNormalizer)

	vectorResults, err := vectorSearch(normalized, opts)
	if err != nil {
		return nil, err
	}

	textQueries := []string{query}
	if normalized != query {
		textQueries = []string{query, normalized}
	}
	fallback, err := textSearch(opts.DB, textQueries, opts)
	if err != nil {
		return nil, err
	}

	// Combine preserving insertion order: vector results first, then text
	// results whose id is not already present.
	seen := make(map[int64]struct{}, len(vectorResults)+len(fallback))
	combined := make([]MemorySearchResult, 0, len(vectorResults)+len(fallback))
	for _, r := range vectorResults {
		if _, ok := seen[r.ID]; ok {
			continue
		}
		seen[r.ID] = struct{}{}
		combined = append(combined, r)
	}
	for _, r := range fallback {
		if _, ok := seen[r.ID]; ok {
			continue
		}
		seen[r.ID] = struct{}{}
		combined = append(combined, r)
	}

	if len(combined) > limit {
		combined = combined[:limit]
	}
	return combined, nil
}

// SearchMulti ports searchMulti(): multi-query AND search. A single-element
// queries slice delegates to Search. Otherwise each query is embedded and run
// as a wide vector query (candidateCount = min(vectorCount, MAX_KNN_K) for both
// k and the return count); results are grouped by id collecting per-query
// scores, only ids matched by EVERY query are kept, scored by the mean of their
// per-query scores, sorted by score descending, and truncated to the limit.
//
// Note: the QueryNormalizer is applied only on the delegated single-query path,
// matching the TS behavior.
func SearchMulti(ctx context.Context, queries []string, opts Options) ([]MemorySearchResult, error) {
	if err := validateDates(opts); err != nil {
		return nil, err
	}
	limit := opts.limit()

	if len(queries) == 1 {
		return Search(ctx, queries[0], opts)
	}

	count, err := vectorCount(opts.DB)
	if err != nil {
		return nil, err
	}
	candidateCount := minInt(count, maxKNNK)

	embed := opts.embedder()
	perQuery := make([][]MemorySearchResult, len(queries))
	for i, q := range queries {
		embedding, err := embed(q)
		if err != nil {
			return nil, err
		}
		if embedding == nil {
			perQuery[i] = nil
			continue
		}
		results, err := runVectorQuery(opts.DB, embedding, candidateCount, candidateCount, opts)
		if err != nil {
			return nil, err
		}
		perQuery[i] = results
	}

	type group struct {
		record MemorySearchResult
		scores []float64
		order  int
	}
	byID := make(map[int64]*group)
	next := 0
	for _, results := range perQuery {
		for _, r := range results {
			score := 0.0
			if r.Score != nil {
				score = *r.Score
			}
			if g, ok := byID[r.ID]; ok {
				g.scores = append(g.scores, score)
			} else {
				byID[r.ID] = &group{record: r, scores: []float64{score}, order: next}
				next++
			}
		}
	}

	var intersected []*group
	for _, g := range byID {
		if len(g.scores) == len(queries) {
			intersected = append(intersected, g)
		}
	}

	// Sort by mean score descending. Ties keep first-seen order for stability
	// (Go map iteration is random; JS preserved insertion order via Map).
	sort.SliceStable(intersected, func(i, j int) bool {
		mi, mj := mean(intersected[i].scores), mean(intersected[j].scores)
		if mi != mj {
			return mi > mj
		}
		return intersected[i].order < intersected[j].order
	})

	out := make([]MemorySearchResult, 0, len(intersected))
	for _, g := range intersected {
		rec := g.record
		m := mean(g.scores)
		rec.Score = &m
		out = append(out, rec)
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func mean(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	var sum float64
	for _, x := range xs {
		sum += x
	}
	return sum / float64(len(xs))
}

func minInt(xs ...int) int {
	m := xs[0]
	for _, x := range xs[1:] {
		if x < m {
			m = x
		}
	}
	return m
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
