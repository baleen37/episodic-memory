// Package indexer drives archive indexing into memory records and vectors.
//
// Ports src/core/indexer.ts: parse changed archive files into transcript spans,
// call the extractor to produce fact/event memory records, and embed those
// records into vec_memory_records.
//
// TODO(phase2): port the indexing pipeline (span parsing -> extraction ->
// embedding).
package indexer
