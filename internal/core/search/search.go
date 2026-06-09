// Package search implements hybrid vector-first + text-fallback memory search.
//
// Ports src/core/search.ts: embed the query, search vec_memory_records joined
// to active memory_records by vector distance, supplement with text matches,
// deduplicate, and return compact source-linked memory cards.
//
// TODO(phase2): port single-query and multi-query AND search.
package search
