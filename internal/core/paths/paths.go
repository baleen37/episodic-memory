// Package paths resolves memmem storage locations with environment-variable
// overrides. It ports src/core/paths.ts. Other Go modules (db, indexer,
// archive, logging) depend on these path resolvers, so it lives in its own
// package.
package paths

import (
	"os"
	"path/filepath"
	"time"
)

// ensureDir creates dir (and parents) if missing and returns it.
func ensureDir(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// SuperpowersDir returns the memmem config directory.
//
// Precedence:
//  1. CONVERSATION_MEMORY_CONFIG_DIR (primary, documented in CLI)
//  2. MEMMEM_CONFIG_DIR (backward-compatible alternative)
//  3. ~/.config/memmem (default)
//
// The directory is created if it does not exist.
func SuperpowersDir() (string, error) {
	if v := os.Getenv("CONVERSATION_MEMORY_CONFIG_DIR"); v != "" {
		return ensureDir(v)
	}
	if v := os.Getenv("MEMMEM_CONFIG_DIR"); v != "" {
		return ensureDir(v)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return ensureDir(filepath.Join(home, ".config", "memmem"))
}

// RuntimeDir returns the runtime asset directory (<SuperpowersDir>/runtime),
// created if missing. Phase 5 extracts the embedded onnxruntime dylib and
// tokenizer here on first run and downloads the embedding model into it.
func RuntimeDir() (string, error) {
	base, err := SuperpowersDir()
	if err != nil {
		return "", err
	}
	return ensureDir(filepath.Join(base, "runtime"))
}

// ArchiveDir returns the conversation archive directory, honoring the
// TEST_ARCHIVE_DIR override. The directory is created if missing.
func ArchiveDir() (string, error) {
	if v := os.Getenv("TEST_ARCHIVE_DIR"); v != "" {
		return ensureDir(v)
	}
	base, err := SuperpowersDir()
	if err != nil {
		return "", err
	}
	return ensureDir(filepath.Join(base, "conversation-archive"))
}

// IndexDir returns the conversation index directory, created if missing.
func IndexDir() (string, error) {
	base, err := SuperpowersDir()
	if err != nil {
		return "", err
	}
	return ensureDir(filepath.Join(base, "conversation-index"))
}

// DBPath returns the database path.
//
// Precedence:
//  1. CONVERSATION_MEMORY_DB_PATH (primary, documented in CLI)
//  2. MEMMEM_DB_PATH or TEST_DB_PATH (backward-compatible alternatives)
//  3. <IndexDir>/conversations.db (default)
//
// A value of ":memory:" is returned as-is (no directory is created).
func DBPath() (string, error) {
	if v := os.Getenv("CONVERSATION_MEMORY_DB_PATH"); v != "" {
		return v, nil
	}
	if v := os.Getenv("MEMMEM_DB_PATH"); v != "" {
		return v, nil
	}
	if v := os.Getenv("TEST_DB_PATH"); v != "" {
		return v, nil
	}
	idx, err := IndexDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(idx, "conversations.db"), nil
}

// LogDir returns the logs directory, created if missing.
func LogDir() (string, error) {
	base, err := SuperpowersDir()
	if err != nil {
		return "", err
	}
	return ensureDir(filepath.Join(base, "logs"))
}

// LogFilePath returns the log file path for the current date (YYYY-MM-DD.log).
func LogFilePath() (string, error) {
	dir, err := LogDir()
	if err != nil {
		return "", err
	}
	date := time.Now().Format("2006-01-02")
	return filepath.Join(dir, date+".log"), nil
}
