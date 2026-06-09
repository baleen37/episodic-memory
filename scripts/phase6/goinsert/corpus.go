package main

import "time"

// Rec mirrors corpus.ts Rec exactly (same text/order/keys/dates).
type Rec struct {
	Kind        string
	Text        string
	SourceKind  string
	ArchivePath string
	LineStart   int64
	LineEnd     int64
	ObservedAt  int64 // epoch ms
	Project     string
	DedupeKey   string
}

func utcMillis(y int, m time.Month, d int) int64 {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC).UnixMilli()
}

// Corpus is byte-for-byte identical to CORPUS in corpus.ts.
var Corpus = []Rec{
	{"fact", "The transcript archive is the source of truth for memory records.", "claude-projects", "/arch/a.jsonl", 1, 3, utcMillis(2024, time.January, 15), "memmem", "k1"},
	{"event", "Switched the embedding model to multilingual-e5-small with 384 dimensions.", "claude-projects", "/arch/a.jsonl", 5, 9, utcMillis(2024, time.June, 1), "memmem", "k2"},
	{"fact", "Search is hybrid: vector results first, then text fallback, deduped by id.", "codex-sessions", "/arch/b.jsonl", 1, 4, utcMillis(2025, time.January, 1), "memmem", "k3"},
	{"event", "Vectors are stored as little-endian float32 raw bytes for index compatibility.", "codex-sessions", "/arch/b.jsonl", 6, 8, utcMillis(2025, time.June, 1), "other", "k4"},
	{"fact", "The user prefers communicating in Korean and concise compact outputs.", "claude-projects", "/arch/c.jsonl", 2, 2, utcMillis(2024, time.June, 1), "other", "k5"},
	{"event", "Deployed the release pipeline using goreleaser with cgo onnxruntime linkage.", "claude-transcripts", "/arch/d.jsonl", 10, 14, utcMillis(2025, time.January, 1), "memmem", "k6"},
	{"fact", "Rate limiting uses a token bucket singleton configurable per provider.", "claude-projects", "/arch/e.jsonl", 1, 5, utcMillis(2024, time.January, 15), "memmem", "k7"},
	{"event", "Cats are independent animals that sleep most of the day in warm spots.", "codex-sessions", "/arch/f.jsonl", 1, 2, utcMillis(2025, time.June, 1), "other", "k8"},
}
