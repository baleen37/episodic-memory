// Package lock provides a minimal file-based sync mutex preventing concurrent
// memmem sync runs. Ports src/core/lock.ts.
package lock

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/baleen37/memmem/internal/core/logger"
	"github.com/baleen37/memmem/internal/core/paths"
)

// staleDuration: a lock older than this is treated as abandoned by a crashed
// holder. The holder does NOT refresh mtime, so a sync running longer than this
// could have its lock reclaimed. Acceptable for this minimal lock — real syncs
// finish well under 30 minutes.
const staleDuration = 30 * time.Minute

func lockPath() (string, error) {
	idx, err := paths.IndexDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(idx, "sync.lock"), nil
}

// tryCreate atomically creates the lock directory. Returns false if it already
// exists (held). Any other error is returned.
func tryCreate(lockDir string) (bool, error) {
	if err := os.Mkdir(lockDir, 0o755); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return false, nil
		}
		return false, err
	}
	// PID is written for diagnostics only — never used for liveness checks.
	_ = os.WriteFile(filepath.Join(lockDir, "pid"), []byte(strconv.Itoa(os.Getpid())), 0o644)
	return true, nil
}

func isStale(lockDir string) bool {
	info, err := os.Stat(lockDir)
	if err != nil {
		return false
	}
	return time.Since(info.ModTime()) > staleDuration
}

// AcquireSyncLock acquires the single-run sync lock. It returns a release
// function, or nil if another sync currently holds it.
func AcquireSyncLock() func() {
	lockDir, err := lockPath()
	if err != nil {
		return nil
	}

	created, err := tryCreate(lockDir)
	if err != nil {
		return nil
	}
	if created {
		return makeRelease(lockDir)
	}

	// Held. Reclaim only if the holder looks crashed (stale by mtime age).
	if isStale(lockDir) {
		logger.Warn("Reclaiming stale sync lock", map[string]any{"lockDir": lockDir})
		_ = os.RemoveAll(lockDir)
		created, err := tryCreate(lockDir)
		if err == nil && created {
			return makeRelease(lockDir)
		}
	}

	return nil
}

func makeRelease(lockDir string) func() {
	released := false
	return func() {
		if released {
			return
		}
		released = true
		_ = os.RemoveAll(lockDir)
	}
}
