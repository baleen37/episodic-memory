// Package logger is a level-gated logger that writes to stderr and mirrors
// output to a dated log file at <config>/logs/YYYY-MM-DD.log. Ports
// src/core/logger.ts.
//
// Control via the MEMMEM_LOG_LEVEL env var:
//
//	error | warn | info | debug   (default: info)
//	silent                         (disables all output)
//
// File writes are suppressed under tests (GO_TEST / NODE_ENV=test) so suites
// that don't override the config dir don't pollute the real logs directory.
//
// TODO: port the TS logger's 14-day retention pruning (logger.ts pruneOldLogs)
// and buffered/batched flush. Deferred — the observable behavior here
// (level-gated stderr, dated log file, test suppression) is faithful; only the
// log-directory housekeeping is missing.
package logger

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/baleen37/memmem/internal/core/paths"
)

type level int

const (
	levelError level = 0
	levelWarn  level = 1
	levelInfo  level = 2
	levelDebug level = 3
)

var levelNames = map[string]level{
	"error": levelError,
	"warn":  levelWarn,
	"info":  levelInfo,
	"debug": levelDebug,
}

// threshold returns the active level threshold, or -1 for "silent".
func threshold() int {
	raw := os.Getenv("MEMMEM_LOG_LEVEL")
	if raw == "" {
		raw = "info"
	}
	switch raw {
	case "silent", "SILENT", "Silent":
		return -1
	}
	if lvl, ok := levelNames[lowercase(raw)]; ok {
		return int(lvl)
	}
	return int(levelInfo)
}

func lowercase(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

var fileMu sync.Mutex

// testMode reports whether file writes should be skipped (under tests).
func testMode() bool {
	return os.Getenv("NODE_ENV") == "test" || os.Getenv("GO_TEST") == "1"
}

func emit(lvl level, name, msg string, meta map[string]any) {
	if threshold() < int(lvl) {
		return
	}
	ts := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	var line string
	if meta != nil {
		b, err := json.Marshal(meta)
		if err != nil {
			b = []byte("{}")
		}
		line = fmt.Sprintf("[%s] %s %s %s\n", ts, upper(name), msg, string(b))
	} else {
		line = fmt.Sprintf("[%s] %s %s\n", ts, upper(name), msg)
	}
	fmt.Fprint(os.Stderr, line)
	writeFile(line)
}

func upper(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - ('a' - 'A')
		}
	}
	return string(b)
}

func writeFile(line string) {
	if testMode() {
		return
	}
	path, err := paths.LogFilePath()
	if err != nil {
		return
	}
	fileMu.Lock()
	defer fileMu.Unlock()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line)
}

// Error logs at the error level.
func Error(msg string, meta map[string]any) { emit(levelError, "error", msg, meta) }

// Warn logs at the warn level.
func Warn(msg string, meta map[string]any) { emit(levelWarn, "warn", msg, meta) }

// Info logs at the info level.
func Info(msg string, meta map[string]any) { emit(levelInfo, "info", msg, meta) }

// Debug logs at the debug level.
func Debug(msg string, meta map[string]any) { emit(levelDebug, "debug", msg, meta) }
