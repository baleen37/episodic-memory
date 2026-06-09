package lock

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// setup points the config dir (and thus IndexDir/lockPath) at a temp directory
// so tests never touch ~/.config/memmem, and returns the lock dir path.
func setup(t *testing.T) string {
	t.Helper()
	cfg := t.TempDir()
	t.Setenv("CONVERSATION_MEMORY_CONFIG_DIR", cfg)
	t.Setenv("MEMMEM_LOG_LEVEL", "silent")
	lp, err := lockPath()
	if err != nil {
		t.Fatalf("lockPath: %v", err)
	}
	return lp
}

func TestAcquireThenSecondReturnsNil(t *testing.T) {
	setup(t)

	first := AcquireSyncLock()
	if first == nil {
		t.Fatal("first acquire should succeed")
	}
	defer first()

	second := AcquireSyncLock()
	if second != nil {
		second()
		t.Fatal("second acquire should return nil while lock is held")
	}
}

func TestReleaseRemovesLockAndAllowsReacquire(t *testing.T) {
	lp := setup(t)

	release := AcquireSyncLock()
	if release == nil {
		t.Fatal("acquire should succeed")
	}
	if _, err := os.Stat(lp); err != nil {
		t.Fatalf("lock dir should exist after acquire: %v", err)
	}

	release()
	if _, err := os.Stat(lp); !os.IsNotExist(err) {
		t.Fatalf("lock dir should be gone after release, stat err = %v", err)
	}

	again := AcquireSyncLock()
	if again == nil {
		t.Fatal("acquire after release should succeed")
	}
	again()
}

func TestDoubleReleaseIsIdempotent(t *testing.T) {
	setup(t)

	release := AcquireSyncLock()
	if release == nil {
		t.Fatal("acquire should succeed")
	}
	release()
	// Second release must not panic or remove a re-acquired lock.
	release()

	again := AcquireSyncLock()
	if again == nil {
		t.Fatal("acquire after double-release should succeed")
	}
	again()
}

func TestStaleLockIsReclaimed(t *testing.T) {
	lp := setup(t)

	// Simulate a crashed holder: create the lock dir, then backdate its mtime
	// beyond the stale threshold.
	if err := os.Mkdir(lp, 0o755); err != nil {
		t.Fatalf("mkdir lock: %v", err)
	}
	old := time.Now().Add(-staleDuration - time.Minute)
	if err := os.Chtimes(lp, old, old); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	release := AcquireSyncLock()
	if release == nil {
		t.Fatal("stale lock should be reclaimed")
	}
	defer release()

	// After reclaim the lock dir exists with a fresh mtime.
	info, err := os.Stat(lp)
	if err != nil {
		t.Fatalf("lock dir should exist after reclaim: %v", err)
	}
	if time.Since(info.ModTime()) > time.Minute {
		t.Errorf("reclaimed lock mtime not refreshed: %v", info.ModTime())
	}
}

func TestFreshLockIsNotReclaimed(t *testing.T) {
	lp := setup(t)

	// A fresh (non-stale) held lock must not be stolen.
	if err := os.Mkdir(lp, 0o755); err != nil {
		t.Fatalf("mkdir lock: %v", err)
	}
	recent := time.Now().Add(-time.Minute)
	if err := os.Chtimes(lp, recent, recent); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	if release := AcquireSyncLock(); release != nil {
		release()
		t.Fatal("fresh lock should not be reclaimed")
	}

	// Marker file inside the held lock dir must survive (not removed/recreated).
	marker := filepath.Join(lp, "marker")
	if err := os.WriteFile(marker, []byte("x"), 0o644); err != nil {
		t.Fatalf("write marker: %v", err)
	}
	if release := AcquireSyncLock(); release != nil {
		release()
		t.Fatal("fresh lock should still not be reclaimed")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Errorf("marker should survive: %v", err)
	}
}
