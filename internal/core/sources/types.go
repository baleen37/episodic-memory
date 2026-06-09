// Package sources holds the transcript source adapters.
//
// Ports src/core/sources/ (types.ts, jsonl.ts, claude.ts, codex.ts, index.ts):
// claude-projects, claude-transcripts, and codex-sessions adapters that
// discover roots, detect JSONL transcripts, and parse transcript spans.
//
// This package is CGO-free pure parsing (CGO_ENABLED=0 must work).
package sources

// TranscriptSpan is a parsed span of conversation extracted from an archived
// transcript. Nullable fields use *string/*int64 to mirror the TS
// `string | null` / `number | null` shape and to flow directly into the db
// package's MemoryRecordInsert (which also uses *string/*int64). Ports the
// TranscriptSpan interface in src/core/sources/types.ts.
type TranscriptSpan struct {
	ArchivePath  string
	LineStart    int64
	LineEnd      int64
	SourceKind   string
	SessionID    *string
	Project      *string
	Cwd          *string
	GitBranch    *string
	Model        *string
	Provider     *string
	MetadataJSON *string
	ObservedAt   *int64
	Text         string
}

// ParseContext carries the per-file context passed to an adapter's Parse.
// Ports the ParseContext interface in src/core/sources/types.ts.
type ParseContext struct {
	ArchivePath string
	SourceKind  string
}

// SourceAdapter discovers transcript roots, detects transcript files, and
// parses transcript content into spans. Ports the SourceAdapter interface in
// src/core/sources/types.ts.
type SourceAdapter interface {
	Kind() string
	Roots() []string
	Detect(filePath string) bool
	Parse(content string, ctx ParseContext) []TranscriptSpan
}
