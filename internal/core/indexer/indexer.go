// Package indexer drives archive indexing into memory records and vectors.
//
// Ports src/core/indexer.ts: read a changed archive file, parse it into
// transcript spans, extract bounded fact/event memory records via the LLM,
// embed them, and write the source-linked index — with extraction_state-based
// retry/backoff, exclusion-marker handling, stale-span pruning, and atomic
// per-span replacement.
//
// It is the central integration module, depending on db, embeddings, llm,
// sources, and project. Embedding is CGO (via embeddings); the embedder and the
// clock are injectable so most logic is testable CGO-free with fakes.
package indexer

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"

	"github.com/baleen37/memmem/internal/core/db"
	"github.com/baleen37/memmem/internal/core/project"
	"github.com/baleen37/memmem/internal/core/sources"
	"github.com/baleen37/memmem/internal/llm"
)

// ArchiveParser parses archive content into transcript spans. It is injected by
// the caller (typically a source adapter's Parse). Ports the TS ArchiveParser.
type ArchiveParser func(content string, ctx sources.ParseContext) []sources.TranscriptSpan

// Embedder produces a passage embedding. It defaults to embeddings.EmbedPassage
// (wired in embedder_cgo.go); tests inject a fake to stay CGO-free. A nil/empty
// return with nil error signals "embedding failed", mirroring the TS
// `!embedding` branch that throws.
type Embedder func(text string) ([]float32, error)

// ReindexArchiveResult is the per-file outcome. Ports ReindexArchiveResult.
type ReindexArchiveResult struct {
	SpansConsidered      int
	SpansSkipped         int
	SpansEmpty           int
	SpansErrored         int
	MemoryRecordsIndexed int
}

// EXCLUSION_MARKERS are substrings that, if present anywhere in a file, exclude
// it from indexing. Ports EXCLUSION_MARKERS.
var EXCLUSION_MARKERS = []string{
	"DO NOT INDEX THIS CHAT",
	"DO NOT INDEX THIS CONVERSATION",
	"이 대화는 인덱싱하지 마세요",
	"이 대화는 검색에서 제외하세요",
}

// HasExclusionMarker reports whether content contains any exclusion marker.
// Ports hasExclusionMarker.
func HasExclusionMarker(content string) bool {
	for _, m := range EXCLUSION_MARKERS {
		if strings.Contains(content, m) {
			return true
		}
	}
	return false
}

// Options configures ReindexArchiveFile. The zero value uses production
// defaults: the CGO embeddings.EmbedPassage embedder, the system clock, and the
// default git reader for project resolution.
type Options struct {
	// Embedder overrides the embedding function. When nil, defaultEmbedder
	// (embeddings.EmbedPassage) is used. Set by tests to avoid the CGO model.
	Embedder Embedder
	// Now overrides the clock (epoch millis). When nil, the system clock is
	// used. Injected for deterministic backoff/retry tests.
	Now func() int64
	// GitReader overrides project resolution's git reader. When nil, the
	// default (shell-out) reader is used.
	GitReader project.GitReader
}

func (o Options) embedder() Embedder {
	if o.Embedder != nil {
		return o.Embedder
	}
	return defaultEmbedder
}

func (o Options) now() int64 {
	if o.Now != nil {
		return o.Now()
	}
	return nowMillis()
}

type preparedRecord struct {
	record    llm.ExtractedMemoryRecord
	embedding []float32
}

// ReindexArchiveFile reads the archive file at archivePath, parses it into
// spans, and indexes extracted memory records with provenance. provider may be
// nil, in which case spans are counted but skipped (no extraction without a
// provider). Ports reindexArchiveFile.
func ReindexArchiveFile(
	ctx context.Context,
	database *sql.DB,
	archivePath string,
	sourceKind string,
	parser ArchiveParser,
	provider llm.Provider,
	opts Options,
) (ReindexArchiveResult, error) {
	contentBytes, err := os.ReadFile(archivePath)
	if err != nil {
		return ReindexArchiveResult{}, fmt.Errorf("read archive file: %w", err)
	}
	content := string(contentBytes)

	if HasExclusionMarker(content) {
		if err := db.DeleteMemoryIndexForArchivePath(database, archivePath); err != nil {
			return ReindexArchiveResult{}, err
		}
		return ReindexArchiveResult{}, nil
	}

	spans := parser(content, sources.ParseContext{ArchivePath: archivePath, SourceKind: sourceKind})
	result := ReindexArchiveResult{SpansConsidered: len(spans)}

	if err := pruneStaleMemoryIndexForArchivePath(database, archivePath, spans); err != nil {
		return ReindexArchiveResult{}, err
	}

	if provider == nil {
		result.SpansSkipped = len(spans)
		return result, nil
	}

	embed := opts.embedder()

	for _, span := range spans {
		sourceHash := hashText(span.Text)

		completed, err := db.HasCompletedExtractionState(
			database, span.ArchivePath, span.LineStart, span.LineEnd, sourceHash, db.CurrentExtractionVersion)
		if err != nil {
			return ReindexArchiveResult{}, err
		}
		if completed {
			result.SpansSkipped++
			continue
		}

		pending, err := hasPendingRetryExtractionState(
			database, span.ArchivePath, span.LineStart, span.LineEnd, sourceHash, db.CurrentExtractionVersion, opts.now())
		if err != nil {
			return ReindexArchiveResult{}, err
		}
		if pending {
			result.SpansSkipped++
			continue
		}

		indexedCount, extractErr := extractEmbedAndStore(ctx, database, span, sourceHash, provider, embed, opts)
		if extractErr != nil {
			if err := recordExtractionError(database, span, sourceHash, extractErr, opts.now()); err != nil {
				return ReindexArchiveResult{}, err
			}
			result.SpansErrored++
			continue
		}

		if indexedCount == 0 {
			result.SpansEmpty++
		} else {
			result.MemoryRecordsIndexed += indexedCount
		}
	}

	return result, nil
}

// recordExtractionError upserts an 'errored' extraction_state with an
// accumulated attempt_count and the next backoff retry_after. Ports the catch
// block of reindexArchiveFile.
func recordExtractionError(database *sql.DB, span sources.TranscriptSpan, sourceHash string, cause error, now int64) error {
	prevAttempts, err := db.GetExtractionAttemptCount(
		database, span.ArchivePath, span.LineStart, span.LineEnd, sourceHash, db.CurrentExtractionVersion)
	if err != nil {
		return err
	}
	attemptCount := prevAttempts + 1
	msg := cause.Error()
	return db.UpsertExtractionState(database, db.ExtractionStateInsert{
		SourceKind:        span.SourceKind,
		ArchivePath:       span.ArchivePath,
		LineStart:         span.LineStart,
		LineEnd:           span.LineEnd,
		SourceHash:        sourceHash,
		ExtractionVersion: db.CurrentExtractionVersion,
		Status:            db.ExtractionErrored,
		ErrorMessage:      &msg,
		AttemptCount:      attemptCount,
		RetryAfter:        ComputeRetryAfter(attemptCount, now),
	})
}

// extractEmbedAndStore extracts records for one span, embeds them, then
// atomically replaces that span's index inside a transaction. It returns the
// indexed record count (0 when extraction was empty). Any error rolls the
// transaction back, leaving the existing index unchanged, and is returned so the
// caller records an errored extraction_state. Ports the try body of
// reindexArchiveFile (extraction + embedding + db.transaction).
func extractEmbedAndStore(
	ctx context.Context,
	database *sql.DB,
	span sources.TranscriptSpan,
	sourceHash string,
	provider llm.Provider,
	embed Embedder,
	opts Options,
) (int, error) {
	records, err := llm.ExtractMemoryRecordsFromSpan(ctx, provider, llm.TranscriptSpanForExtraction{
		SourceKind:  span.SourceKind,
		ArchivePath: span.ArchivePath,
		LineStart:   int(span.LineStart),
		LineEnd:     int(span.LineEnd),
		ObservedAt:  span.ObservedAt,
		Project:     span.Project,
		Text:        span.Text,
	}, llm.ExtractMemoryOptions{MaxRecords: 10})
	if err != nil {
		return 0, err
	}

	prepared := make([]preparedRecord, 0, len(records))
	for _, record := range records {
		embedding, err := embed(record.Text)
		if err != nil {
			return 0, err
		}
		if len(embedding) == 0 {
			return 0, fmt.Errorf("embedding failed")
		}
		prepared = append(prepared, preparedRecord{record: record, embedding: embedding})
	}

	tx, err := database.Begin()
	if err != nil {
		return 0, fmt.Errorf("begin span txn: %w", err)
	}

	count, txErr := replaceSpanIndex(tx, span, sourceHash, prepared, opts)
	if txErr != nil {
		if rbErr := tx.Rollback(); rbErr != nil {
			return 0, fmt.Errorf("rollback span txn after %v: %w", txErr, rbErr)
		}
		return 0, txErr
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit span txn: %w", err)
	}
	return count, nil
}

// replaceSpanIndex deletes the span's existing index then writes the prepared
// records + vectors and a 'done'/'empty' extraction_state, all on tx. Ports the
// db.transaction() callback in reindexArchiveFile.
func replaceSpanIndex(tx *sql.Tx, span sources.TranscriptSpan, sourceHash string, prepared []preparedRecord, opts Options) (int, error) {
	if err := deleteMemoryIndexForSpan(tx, span); err != nil {
		return 0, err
	}

	if len(prepared) == 0 {
		if err := txUpsertExtractionState(tx, db.ExtractionStateInsert{
			SourceKind:        span.SourceKind,
			ArchivePath:       span.ArchivePath,
			LineStart:         span.LineStart,
			LineEnd:           span.LineEnd,
			SourceHash:        sourceHash,
			ExtractionVersion: db.CurrentExtractionVersion,
			Status:            db.ExtractionEmpty,
			AttemptCount:      0,
		}); err != nil {
			return 0, err
		}
		return 0, nil
	}

	cwd := ""
	if span.Cwd != nil {
		cwd = *span.Cwd
	}
	info := project.ResolveProject(cwd, opts.GitReader)
	projectVal := info.Project
	projectName := info.ProjectName

	for _, pr := range prepared {
		confidence := pr.record.Confidence
		embeddingVersion := int64(db.CurrentEmbeddingVersion)
		dedupeKey := makeDedupeKey(pr.record.Kind, pr.record.Text)
		if pr.record.DedupeKey != nil {
			dedupeKey = *pr.record.DedupeKey
		}
		id, err := txInsertMemoryRecord(tx, db.MemoryRecordInsert{
			Kind:              db.MemoryRecordKind(pr.record.Kind),
			Text:              pr.record.Text,
			SourceKind:        span.SourceKind,
			ArchivePath:       span.ArchivePath,
			LineStart:         span.LineStart,
			LineEnd:           span.LineEnd,
			ObservedAt:        span.ObservedAt,
			Project:           &projectVal,
			ProjectName:       &projectName,
			Confidence:        &confidence,
			DedupeKey:         dedupeKey,
			ExtractionVersion: db.CurrentExtractionVersion,
			EmbeddingVersion:  &embeddingVersion,
		})
		if err != nil {
			return 0, err
		}
		if err := txInsertMemoryRecordVector(tx, id, pr.embedding); err != nil {
			return 0, err
		}
	}

	if err := txUpsertExtractionState(tx, db.ExtractionStateInsert{
		SourceKind:        span.SourceKind,
		ArchivePath:       span.ArchivePath,
		LineStart:         span.LineStart,
		LineEnd:           span.LineEnd,
		SourceHash:        sourceHash,
		ExtractionVersion: db.CurrentExtractionVersion,
		Status:            db.ExtractionDone,
		AttemptCount:      0,
	}); err != nil {
		return 0, err
	}
	return len(prepared), nil
}
