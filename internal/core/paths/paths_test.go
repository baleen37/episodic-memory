package paths

import (
	"os"
	"path/filepath"
	"testing"
)

// clearEnv unsets all memmem path env vars so each test starts clean.
func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"CONVERSATION_MEMORY_CONFIG_DIR", "MEMMEM_CONFIG_DIR",
		"CONVERSATION_MEMORY_DB_PATH", "MEMMEM_DB_PATH", "TEST_DB_PATH",
		"TEST_ARCHIVE_DIR",
	} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
}

func TestDBPathPrecedence(t *testing.T) {
	t.Run("CONVERSATION_MEMORY_DB_PATH wins", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("CONVERSATION_MEMORY_DB_PATH", "/primary.db")
		t.Setenv("MEMMEM_DB_PATH", "/secondary.db")
		t.Setenv("TEST_DB_PATH", "/tertiary.db")
		got, err := DBPath()
		if err != nil {
			t.Fatal(err)
		}
		if got != "/primary.db" {
			t.Fatalf("want /primary.db, got %s", got)
		}
	})

	t.Run("MEMMEM_DB_PATH over TEST_DB_PATH", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("MEMMEM_DB_PATH", "/secondary.db")
		t.Setenv("TEST_DB_PATH", "/tertiary.db")
		got, err := DBPath()
		if err != nil {
			t.Fatal(err)
		}
		if got != "/secondary.db" {
			t.Fatalf("want /secondary.db, got %s", got)
		}
	})

	t.Run("TEST_DB_PATH fallback", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("TEST_DB_PATH", "/tertiary.db")
		got, err := DBPath()
		if err != nil {
			t.Fatal(err)
		}
		if got != "/tertiary.db" {
			t.Fatalf("want /tertiary.db, got %s", got)
		}
	})

	t.Run("default under index dir", func(t *testing.T) {
		clearEnv(t)
		tmp := t.TempDir()
		t.Setenv("CONVERSATION_MEMORY_CONFIG_DIR", tmp)
		got, err := DBPath()
		if err != nil {
			t.Fatal(err)
		}
		want := filepath.Join(tmp, "conversation-index", "conversations.db")
		if got != want {
			t.Fatalf("want %s, got %s", want, got)
		}
	})

	t.Run(":memory: passthrough no dir creation", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("CONVERSATION_MEMORY_DB_PATH", ":memory:")
		got, err := DBPath()
		if err != nil {
			t.Fatal(err)
		}
		if got != ":memory:" {
			t.Fatalf("want :memory:, got %s", got)
		}
	})
}

func TestSuperpowersDirPrecedence(t *testing.T) {
	clearEnv(t)
	a := t.TempDir()
	b := t.TempDir()
	t.Setenv("CONVERSATION_MEMORY_CONFIG_DIR", a)
	t.Setenv("MEMMEM_CONFIG_DIR", b)
	got, err := SuperpowersDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != a {
		t.Fatalf("want %s, got %s", a, got)
	}

	clearEnv(t)
	t.Setenv("MEMMEM_CONFIG_DIR", b)
	got, err = SuperpowersDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != b {
		t.Fatalf("want %s, got %s", b, got)
	}
}

func TestArchiveDirOverride(t *testing.T) {
	clearEnv(t)
	tmp := t.TempDir()
	override := filepath.Join(tmp, "arch")
	t.Setenv("TEST_ARCHIVE_DIR", override)
	got, err := ArchiveDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != override {
		t.Fatalf("want %s, got %s", override, got)
	}
	if _, err := os.Stat(override); err != nil {
		t.Fatalf("archive dir not created: %v", err)
	}
}

func TestIndexDirCreated(t *testing.T) {
	clearEnv(t)
	tmp := t.TempDir()
	t.Setenv("CONVERSATION_MEMORY_CONFIG_DIR", tmp)
	got, err := IndexDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Join(tmp, "conversation-index") {
		t.Fatalf("unexpected index dir: %s", got)
	}
	if _, err := os.Stat(got); err != nil {
		t.Fatalf("index dir not created: %v", err)
	}
}

func TestLogFilePathFormat(t *testing.T) {
	clearEnv(t)
	tmp := t.TempDir()
	t.Setenv("CONVERSATION_MEMORY_CONFIG_DIR", tmp)
	got, err := LogFilePath()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(got)
	if dir != filepath.Join(tmp, "logs") {
		t.Fatalf("unexpected log dir: %s", dir)
	}
	base := filepath.Base(got)
	// YYYY-MM-DD.log = 14 chars
	if len(base) != len("2006-01-02.log") || filepath.Ext(base) != ".log" {
		t.Fatalf("unexpected log file name: %s", base)
	}
}
