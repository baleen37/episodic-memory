package cli

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/baleen37/memmem/internal/core/lock"
)

// TestRunSyncCliSkipsWhenLockHeld ports the runSyncCli lock test: when the lock
// is already held, RunSyncCli does no work and does not release the lock.
func TestRunSyncCliSkipsWhenLockHeld(t *testing.T) {
	cfgDir := t.TempDir()
	t.Setenv("CONVERSATION_MEMORY_CONFIG_DIR", cfgDir)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(cfgDir, "claude"))
	t.Setenv("CODEX_HOME", filepath.Join(cfgDir, "codex"))
	t.Setenv("CONVERSATION_MEMORY_DB_PATH", ":memory:")
	t.Setenv("GO_TEST", "1")
	t.Setenv("MEMMEM_LOG_LEVEL", "silent")

	held := lock.AcquireSyncLock()
	if held == nil {
		t.Fatal("expected to acquire lock")
	}
	defer held()

	if err := RunSyncCli(context.Background()); err != nil {
		t.Fatalf("RunSyncCli returned error: %v", err)
	}

	// Lock must still be held → a second acquire returns nil.
	second := lock.AcquireSyncLock()
	if second != nil {
		second()
		t.Fatal("RunSyncCli should not have released the lock")
	}
}
