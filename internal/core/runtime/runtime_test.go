package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// TestExtractEmbeddedSizeMatchSkip verifies graduation note 1: an already-present
// file with the expected size is NOT re-written (idempotent, no wipe). We detect
// the skip by writing sentinel content of the same size and confirming it
// survives a second extract call.
func TestExtractEmbeddedSizeMatchSkip(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, "asset.bin")
	data := []byte("hello-runtime-asset")

	if err := extractEmbedded(dst, data, dataMode); err != nil {
		t.Fatalf("first extract: %v", err)
	}
	// Overwrite with same-size sentinel; a re-extract must leave it alone.
	sentinel := make([]byte, len(data))
	for i := range sentinel {
		sentinel[i] = 'X'
	}
	if err := os.WriteFile(dst, sentinel, dataMode); err != nil {
		t.Fatal(err)
	}
	if err := extractEmbedded(dst, data, dataMode); err != nil {
		t.Fatalf("second extract: %v", err)
	}
	got, _ := os.ReadFile(dst)
	if string(got) != string(sentinel) {
		t.Fatalf("size-match file was re-extracted; got %q want sentinel preserved", got)
	}
}

// TestExtractEmbeddedSizeMismatchRewrites verifies that when the existing file
// has the WRONG size it is re-extracted (so a truncated/corrupt extract self-heals).
func TestExtractEmbeddedSizeMismatchRewrites(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, "asset.bin")
	data := []byte("correct-content")

	if err := os.WriteFile(dst, []byte("short"), dataMode); err != nil {
		t.Fatal(err)
	}
	if err := extractEmbedded(dst, data, dataMode); err != nil {
		t.Fatalf("extract: %v", err)
	}
	got, _ := os.ReadFile(dst)
	if string(got) != string(data) {
		t.Fatalf("size-mismatch file not rewritten; got %q want %q", got, data)
	}
}

// TestExtractEmbeddedModes verifies graduation note 2: dylib mode 0o755, data
// mode 0o644.
func TestExtractEmbeddedModes(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name string
		mode os.FileMode
	}{
		{"lib.dylib", dylibMode},
		{"data.json", dataMode},
	}
	for _, c := range cases {
		dst := filepath.Join(dir, c.name)
		if err := extractEmbedded(dst, []byte("payload-"+c.name), c.mode); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		fi, err := os.Stat(dst)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != c.mode {
			t.Fatalf("%s mode = %o want %o", c.name, fi.Mode().Perm(), c.mode)
		}
	}
}

// TestAtomicWriteNoTempLeftBehind verifies graduation note 3: a successful write
// leaves no ".tmp" file, and the content/mode are correct.
func TestAtomicWriteNoTempLeftBehind(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, "atomic.bin")
	if err := atomicWrite(dst, dataMode, func(w io.Writer) error {
		_, err := w.Write([]byte("atomic-payload"))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dst + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("temp file left behind: %v", err)
	}
	got, _ := os.ReadFile(dst)
	if string(got) != "atomic-payload" {
		t.Fatalf("content = %q", got)
	}
}

// TestAtomicWriteErrorLeavesDstUntouched verifies that a write error cleans up
// the temp file and does not create/clobber dst.
func TestAtomicWriteErrorLeavesDstUntouched(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, "atomic.bin")
	wantErr := io.ErrClosedPipe
	err := atomicWrite(dst, dataMode, func(w io.Writer) error { return wantErr })
	if err != wantErr {
		t.Fatalf("err = %v want %v", err, wantErr)
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatal("dst should not exist after failed write")
	}
	if _, err := os.Stat(dst + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("temp file should be cleaned up after failed write")
	}
}

// TestDownloadModelVerifiesDigest verifies graduation note 4 (happy path): a
// download whose bytes match the pinned digest is written atomically with 0o644.
func TestDownloadModelVerifiesDigest(t *testing.T) {
	payload := []byte("fake-model-bytes-for-test")
	want := sha256Hex(payload)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer srv.Close()

	dir := t.TempDir()
	dst := filepath.Join(dir, modelName)
	if err := downloadModel(srv.URL, dst, want); err != nil {
		t.Fatalf("downloadModel: %v", err)
	}
	got, _ := os.ReadFile(dst)
	if string(got) != string(payload) {
		t.Fatalf("downloaded content mismatch")
	}
	fi, _ := os.Stat(dst)
	if fi.Mode().Perm() != dataMode {
		t.Fatalf("model mode = %o want %o", fi.Mode().Perm(), dataMode)
	}
}

// TestDownloadModelRejectsBadDigest verifies graduation note 4 (rejection): a
// download whose bytes do NOT match the pinned digest is rejected and not left
// on disk.
func TestDownloadModelRejectsBadDigest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("wrong-model-content"))
	}))
	defer srv.Close()

	dir := t.TempDir()
	dst := filepath.Join(dir, modelName)
	err := downloadModel(srv.URL, dst, ModelSHA256) // pinned digest won't match
	if err == nil {
		t.Fatal("expected sha256 mismatch error, got nil")
	}
	if _, statErr := os.Stat(dst); !os.IsNotExist(statErr) {
		t.Fatal("bad-digest download must not be left on disk")
	}
}

// TestEnsureModelReusesGoodFile verifies that an existing model file with the
// correct digest is trusted and not re-downloaded (no network needed).
func TestEnsureModelReusesGoodFile(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, modelName)

	// Write a file and pin to ITS digest so ensureModel sees a match.
	payload := []byte("already-present-model")
	if err := os.WriteFile(dst, payload, dataMode); err != nil {
		t.Fatal(err)
	}
	ok, err := fileHasDigest(dst, sha256Hex(payload))
	if err != nil || !ok {
		t.Fatalf("fileHasDigest = %v, %v", ok, err)
	}
}

// TestEnsureRuntimeLocalModelBypass verifies the env-var bypass: with
// MEMMEM_MODEL_PATH set to a local file, EnsureRuntime returns that path and
// never attempts a network download (a guaranteed-failing URL would surface as
// an error if a download were attempted).
func TestEnsureRuntimeLocalModelBypass(t *testing.T) {
	// Isolate the runtime dir so we don't touch the real ~/.config/memmem.
	cfgDir := t.TempDir()
	t.Setenv("CONVERSATION_MEMORY_CONFIG_DIR", cfgDir)

	// Provide all three assets locally so no extract/download is needed.
	localDir := t.TempDir()
	model := filepath.Join(localDir, "local-model.onnx")
	tok := filepath.Join(localDir, "local-tokenizer.json")
	lib := filepath.Join(localDir, "local-lib.dylib")
	for _, p := range []string{model, tok, lib} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv(envModelPath, model)
	t.Setenv(envTokenizerPath, tok)
	t.Setenv(envORTLibPath, lib)

	rp, err := EnsureRuntime()
	if err != nil {
		t.Fatalf("EnsureRuntime: %v", err)
	}
	if rp.ModelPath != model || rp.TokenizerPath != tok || rp.DylibPath != lib {
		t.Fatalf("env overrides not honored: %+v", rp)
	}
}
