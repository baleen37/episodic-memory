// Package runtime provisions the native assets the embedding pipeline needs so
// the Go binary is self-contained: it carries the onnxruntime dylib + tokenizer
// inside the binary (via //go:embed) and extracts them to <SuperpowersDir>/runtime
// on first run, then downloads the 235MB ONNX model into the same dir on first
// run (the model is too large to embed without bloating the binary to 316MB).
//
// This graduates the Phase 0 PoC (poc/packaging/main.go) into shipping code,
// applying the four "graduation notes" from poc/packaging/README.md:
//
//  1. No unconditional os.RemoveAll(runtimeDir). Idempotency comes from a
//     size-match skip: if the extracted file already exists with the expected
//     size, it is not re-written. The user's runtime dir (incl. the downloaded
//     model) is never wiped on launch.
//  2. File modes: the dylib is written 0o755 (loadable); data files (tokenizer,
//     model) 0o644.
//  3. Atomic writes: every artifact is written to "<dst>.tmp" then os.Rename'd,
//     so a crash mid-write never leaves a torn file at the real path.
//  4. The downloaded model is verified with sha256 against a pinned digest
//     before it is trusted; a mismatch is rejected (a partial/corrupt/wrong
//     download is never used).
package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/baleen37/memmem/internal/core/paths"
)

const (
	// The ORT shared library filename is platform-specific (.dylib on macOS,
	// .so on linux) and is defined as embeddedLibName in the build-tagged
	// embed_{darwin,linux}.go files.
	tokenizerName = "tokenizer.json"
	modelName     = "model_fp16.onnx"

	// ModelSHA256 is the sha256 of Xenova/multilingual-e5-small's
	// onnx/model_fp16.onnx. The memmem index is built against THIS exact model;
	// fetching a different version would silently break index compatibility, so
	// the download is verified against this digest and rejected on mismatch.
	//
	// CONFIRMED in Phase 5: this is the digest of the local
	// .cache/Xenova/multilingual-e5-small/onnx/model_fp16.onnx the index was
	// built against, and the HuggingFace URL (ModelURL) was downloaded and
	// verified to serve byte-identical content.
	ModelSHA256 = "0e0fe349c99ea21c6f3aa273af21f7fb753c1e1174ef1647032029c2be3251c3"

	// ModelURL is the source for the first-run model download.
	ModelURL = "https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/onnx/model_fp16.onnx"

	dylibMode = 0o755 // dylib must be loadable
	dataMode  = 0o644 // tokenizer + model are data

	downloadTimeout = 10 * time.Minute
)

// Env overrides let users/tests supply their own assets instead of extracting or
// downloading. When MEMMEM_MODEL_PATH points at an existing file, that path is
// used verbatim (no download); it is the primary test/local bypass.
const (
	envModelPath     = "MEMMEM_MODEL_PATH"     // explicit model file (skips download)
	envTokenizerPath = "MEMMEM_TOKENIZER_PATH" // explicit tokenizer file (skips extract)
	envORTLibPath    = "MEMMEM_ORT_LIB_PATH"   // explicit onnxruntime dylib (skips extract)
)

// RuntimePaths are the resolved on-disk locations of the provisioned assets.
type RuntimePaths struct {
	DylibPath     string
	TokenizerPath string
	ModelPath     string
}

// logf writes a user-facing provisioning message to stderr. Provisioning is a
// rare first-run event; surfacing it (esp. the 235MB download) avoids a silent
// multi-minute hang on first launch.
var logf = func(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[memmem runtime] "+format+"\n", args...)
}

// EnsureRuntime provisions the native assets and returns their resolved paths.
//
// On first run it extracts the embedded dylib + tokenizer into the runtime dir
// (idempotent size-match skip) and ensures the model is present (env override,
// already-downloaded, or first-run download with sha256 verification). It is
// safe to call on every launch: when everything is already provisioned it does
// no I/O beyond a few stats.
func EnsureRuntime() (RuntimePaths, error) {
	dir, err := paths.RuntimeDir()
	if err != nil {
		return RuntimePaths{}, fmt.Errorf("resolve runtime dir: %w", err)
	}

	out := RuntimePaths{
		DylibPath:     filepath.Join(dir, embeddedLibName),
		TokenizerPath: filepath.Join(dir, tokenizerName),
		ModelPath:     filepath.Join(dir, modelName),
	}

	// dylib: env override or extract the embedded MS dylib (0o755).
	if v := os.Getenv(envORTLibPath); v != "" {
		out.DylibPath = v
	} else if err := extractEmbedded(out.DylibPath, embeddedLib, dylibMode); err != nil {
		return RuntimePaths{}, fmt.Errorf("provision dylib: %w", err)
	}

	// tokenizer: env override or extract the embedded tokenizer (0o644).
	if v := os.Getenv(envTokenizerPath); v != "" {
		out.TokenizerPath = v
	} else if err := extractEmbedded(out.TokenizerPath, embeddedTokenizer, dataMode); err != nil {
		return RuntimePaths{}, fmt.Errorf("provision tokenizer: %w", err)
	}

	// model: env override (no download), cached in runtime dir, or download.
	if v := os.Getenv(envModelPath); v != "" {
		out.ModelPath = v
	} else if err := ensureModel(out.ModelPath); err != nil {
		return RuntimePaths{}, fmt.Errorf("provision model: %w", err)
	}

	return out, nil
}

// extractEmbedded writes data to dst with mode, idempotently: if dst already
// exists with the expected size it is left untouched (graduation note 1, no
// wipe). Writes go through "<dst>.tmp" + os.Rename so a crash never leaves a
// torn file (note 3), and the mode is applied to the temp file before rename
// so the final file lands with the right bits already set (note 2).
func extractEmbedded(dst string, data []byte, mode os.FileMode) error {
	if fi, err := os.Stat(dst); err == nil && fi.Size() == int64(len(data)) {
		return nil // already extracted, correct size -> skip
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return atomicWrite(dst, mode, func(w io.Writer) error {
		_, err := w.Write(data)
		return err
	})
}

// ensureModel makes the model present at dst with the pinned sha256. If dst
// already exists with the correct digest it is trusted and reused (no
// re-download). Otherwise it is downloaded from ModelURL, verified, and written
// atomically (0o644). A wrong-digest existing file is treated as absent and
// re-fetched.
func ensureModel(dst string) error {
	if ok, _ := fileHasDigest(dst, ModelSHA256); ok {
		return nil
	}
	logf("first run: downloading embedding model (~235MB) from %s", ModelURL)
	if err := downloadModel(ModelURL, dst, ModelSHA256); err != nil {
		return err
	}
	logf("embedding model ready at %s", dst)
	return nil
}

// downloadModel fetches url to dst, streaming to "<dst>.tmp" while computing the
// sha256, rejects the download if the digest does not match wantHex (note 4),
// and only then renames it into place (0o644). A failed/partial download leaves
// only the temp file, which is removed; the real path is never touched until the
// bytes are verified.
func downloadModel(url, dst, wantHex string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}

	client := &http.Client{Timeout: downloadTimeout}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download model: %w (is the network reachable?)", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download model: unexpected status %s from %s", resp.Status, url)
	}

	h := sha256.New()
	if err := atomicWrite(dst, dataMode, func(w io.Writer) error {
		_, err := io.Copy(io.MultiWriter(w, h), resp.Body)
		return err
	}); err != nil {
		return fmt.Errorf("download model: %w", err)
	}

	got := hex.EncodeToString(h.Sum(nil))
	if got != wantHex {
		// The bytes are already renamed into place but are wrong; remove them so
		// the next run re-downloads rather than trusting a bad file.
		_ = os.Remove(dst)
		return fmt.Errorf("downloaded model sha256 mismatch: got %s want %s (refusing to use a model that differs from the one the index was built against)", got, wantHex)
	}
	return nil
}

// atomicWrite writes via "<dst>.tmp" then renames to dst, applying mode to the
// temp file before the rename. write is invoked with the temp file as an
// io.Writer. On any error the temp file is cleaned up and dst is left untouched.
func atomicWrite(dst string, mode os.FileMode, write func(io.Writer) error) error {
	tmp := dst + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	cleanup := func() {
		f.Close()
		_ = os.Remove(tmp)
	}
	if err := write(f); err != nil {
		cleanup()
		return err
	}
	if err := f.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	// OpenFile honors umask, so re-assert the mode explicitly (the dylib must end
	// up 0o755 even under a restrictive umask).
	if err := os.Chmod(tmp, mode); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// fileHasDigest reports whether path exists and its sha256 equals wantHex.
func fileHasDigest(path, wantHex string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false, err
	}
	return hex.EncodeToString(h.Sum(nil)) == wantHex, nil
}
