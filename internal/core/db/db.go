// Package db is the memory database layer for the Go port of memmem.
//
// It ports src/core/db.ts and is the index-compatibility foundation: the
// on-disk schema (tables, columns, indexes, vec0 dimension) and the vector
// encoding (little-endian float32, matching TS Float32Array.buffer) match the
// TS implementation byte-for-byte, so a single conversations.db file works
// with both implementations.
//
// SQLite runs CGO-free via github.com/ncruces/go-sqlite3 (WASM/wazero) with
// the sqlite-vec vec0 extension from
// github.com/asg017/sqlite-vec-go-bindings/ncruces.
package db

import (
	"database/sql"
	"fmt"
	"math/bits"
	"os"
	"path/filepath"
	"strings"
	"time"

	sqlite_vec "github.com/asg017/sqlite-vec-go-bindings/ncruces"
	"github.com/ncruces/go-sqlite3"
	"github.com/ncruces/go-sqlite3/driver"
	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/experimental"
)

// EmbeddingDim mirrors EMBEDDING_DIM in src/core/constants.ts.
const EmbeddingDim = 384

// Version constants mirror src/core/db.ts.
const (
	CurrentEmbeddingVersion  = 2
	CurrentExtractionVersion = 1
)

// MemoryRecordKind mirrors the TS 'fact' | 'event' union.
type MemoryRecordKind string

const (
	KindFact  MemoryRecordKind = "fact"
	KindEvent MemoryRecordKind = "event"
)

// MemoryRecordStatus mirrors the TS 'active' | 'superseded' union.
type MemoryRecordStatus string

const (
	StatusActive     MemoryRecordStatus = "active"
	StatusSuperseded MemoryRecordStatus = "superseded"
)

// ExtractionStatus mirrors the TS 'done' | 'empty' | 'errored' union.
type ExtractionStatus string

const (
	ExtractionDone    ExtractionStatus = "done"
	ExtractionEmpty   ExtractionStatus = "empty"
	ExtractionErrored ExtractionStatus = "errored"
)

// MemoryRecordInsert is the input to InsertMemoryRecord. Pointer fields are
// nullable, matching the TS `number | null` / optional fields.
type MemoryRecordInsert struct {
	Kind              MemoryRecordKind
	Text              string
	SourceKind        string
	ArchivePath       string
	LineStart         int64
	LineEnd           int64
	ObservedAt        *int64
	Project           *string
	ProjectName       *string
	Confidence        *float64 // defaults to 1.0 when nil
	Status            MemoryRecordStatus
	SupersedesID      *int64
	DedupeKey         string
	ExtractionVersion int64
	EmbeddingVersion  *int64
}

// ExtractionStateInsert is the input to UpsertExtractionState.
type ExtractionStateInsert struct {
	SourceKind        string
	ArchivePath       string
	LineStart         int64
	LineEnd           int64
	SourceHash        string
	ExtractionVersion int64
	Status            ExtractionStatus
	ErrorMessage      *string
	RetryAfter        *int64
	AttemptCount      int64
}

func init() {
	// The sqlite-vec wasm shipped by asg017 requires the WebAssembly threads
	// (atomics) feature, which ncruces' default RuntimeConfig does not enable.
	// Configure the runtime once, before the wasm is compiled on first open.
	// Mirror ncruces' default tuning (compiler runtime + memory limit) and add
	// threads. NewRuntimeConfig() auto-selects the compiler backend and falls
	// back to the interpreter when unsupported.
	cfg := wazero.NewRuntimeConfig()
	if bits.UintSize < 64 {
		cfg = cfg.WithMemoryLimitPages(512) // 32MB
	} else {
		cfg = cfg.WithMemoryLimitPages(4096) // 256MB
	}
	cfg = cfg.WithCoreFeatures(api.CoreFeaturesV2 | experimental.CoreFeaturesThreads)
	sqlite3.RuntimeConfig = cfg
}

// OpenDatabase opens (creating if needed) the database at path, applies the
// connection PRAGMAs, ensures the schema/migrations, and returns the handle.
// It preserves existing data. Use ":memory:" for an in-memory database.
//
// This is the production entrypoint (ports openDatabase()).
func OpenDatabase(path string) (*sql.DB, error) {
	return createDatabase(path, false)
}

// InitDatabase wipes the database file (and -wal/-shm sidecars) then opens it
// fresh. It mirrors the TS initDatabase() and is intended for tests only.
func InitDatabase(path string) (*sql.DB, error) {
	return createDatabase(path, true)
}

func createDatabase(path string, wipe bool) (*sql.DB, error) {
	if path != ":memory:" {
		dir := filepath.Dir(path)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create db dir: %w", err)
		}
		if wipe {
			for _, suffix := range []string{"", "-wal", "-shm"} {
				if err := os.Remove(path + suffix); err != nil && !os.IsNotExist(err) {
					return nil, fmt.Errorf("wipe db: %w", err)
				}
			}
		}
	}

	sdb, err := driver.Open(dsn(path))
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	// A single connection keeps PRAGMAs and the in-memory DB consistent.
	sdb.SetMaxOpenConns(1)

	for _, pragma := range []string{
		"PRAGMA foreign_keys = ON",
		"PRAGMA journal_mode = WAL",
		"PRAGMA busy_timeout = 5000",
		"PRAGMA synchronous = NORMAL",
	} {
		if _, err := sdb.Exec(pragma); err != nil {
			sdb.Close()
			return nil, fmt.Errorf("pragma %q: %w", pragma, err)
		}
	}

	if err := createSchema(sdb); err != nil {
		sdb.Close()
		return nil, err
	}
	return sdb, nil
}

// dsn builds the ncruces data source name. ":memory:" maps to an in-memory DB;
// file paths are passed through as a file: URI.
func dsn(path string) string {
	if path == ":memory:" {
		return ":memory:"
	}
	return "file:" + path
}

func createSchema(db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS memory_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('fact', 'event')),
      text TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      observed_at INTEGER,
      project TEXT,
      project_name TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
      supersedes_id INTEGER,
      dedupe_key TEXT NOT NULL,
      extraction_version INTEGER NOT NULL,
      embedding_version INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
		`DROP INDEX IF EXISTS idx_memory_records_dedupe_key`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_records_dedupe_key ON memory_records(dedupe_key, archive_path, line_start, line_end)`,
		`CREATE INDEX IF NOT EXISTS idx_memory_records_kind ON memory_records(kind)`,
		`CREATE INDEX IF NOT EXISTS idx_memory_records_status ON memory_records(status)`,
		`CREATE INDEX IF NOT EXISTS idx_memory_records_archive_path ON memory_records(archive_path)`,
		`CREATE INDEX IF NOT EXISTS idx_memory_records_observed_at ON memory_records(observed_at)`,
		fmt.Sprintf(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory_records USING vec0(
      embedding float[%d]
    )`, EmbeddingDim),
		`CREATE TABLE IF NOT EXISTS extraction_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_kind TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      source_hash TEXT NOT NULL,
      extraction_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('done', 'empty', 'errored')),
      error_message TEXT,
      retry_after INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(archive_path, line_start, line_end, source_hash, extraction_version)
    )`,
		`CREATE INDEX IF NOT EXISTS idx_extraction_state_archive_path ON extraction_state(archive_path)`,
		`CREATE INDEX IF NOT EXISTS idx_extraction_state_status ON extraction_state(status)`,
		`CREATE INDEX IF NOT EXISTS idx_extraction_state_retry_after ON extraction_state(retry_after)`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			return fmt.Errorf("schema stmt failed: %w", err)
		}
	}
	if err := migrateExtractionState(db); err != nil {
		return err
	}
	return runMigrations(db)
}

// migrateExtractionState adds the attempt_count column to legacy extraction_state
// tables that predate it. Idempotent.
func migrateExtractionState(db *sql.DB) error {
	has, err := hasColumn(db, "extraction_state", "attempt_count")
	if err != nil {
		return err
	}
	if !has {
		if _, err := db.Exec(
			`ALTER TABLE extraction_state ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`,
		); err != nil {
			return fmt.Errorf("add attempt_count: %w", err)
		}
	}
	return nil
}

func hasColumn(db *sql.DB, table, column string) (bool, error) {
	rows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			cid       int
			name      string
			ctype     string
			notnull   int
			dfltValue sql.NullString
			pk        int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

// serializeVector encodes embedding as little-endian float32 raw bytes,
// matching the TS Buffer.from(new Float32Array(embedding).buffer) encoding.
// This encoding is load-bearing for index compatibility. It delegates to the
// sqlite-vec binding's SerializeFloat32, which uses binary.LittleEndian.
func serializeVector(embedding []float32) []byte {
	b, _ := sqlite_vec.SerializeFloat32(embedding)
	return b
}

// nowMillis returns the current time as a millisecond epoch (matches Date.now()).
func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// placeholders builds "?,?,..." with n placeholders.
func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}
