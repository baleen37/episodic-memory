// Phase 0 Track B — Method 1 (go:embed self-extraction) measurement.
//
// Embeds the runtime artifacts the embedding pipeline needs and extracts them
// to ~/.config/memmem/runtime/ on first run, then loads onnxruntime from the
// EXTRACTED dylib path and runs one real embedding to prove the extracted
// artifacts actually work.
//
// What gets embedded:
//   - libonnxruntime.dylib  (loaded at runtime by path -> MUST be extracted)
//   - tokenizer.json        (read at runtime by path -> MUST be extracted)
//   - model_fp16.onnx       (read at runtime by path) ONLY when built with the
//     `embedmodel` build tag. Without the tag the model
//     is loaded from the on-disk .cache (download-on-
//     first-run model). This lets us measure binary size
//     both with and without the 235MB model embedded.
//
// libtokenizers.a is NOT embedded: it is a static archive linked at BUILD time
// (via CGO_LDFLAGS -L.../lib), it is baked into the executable's machine code
// and is never a separate runtime file. Confirmed by the Track A poc link line.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"time"

	ort "github.com/yalue/onnxruntime_go"

	"github.com/daulet/tokenizers"
)

const (
	embedDim  = 384
	maxTokens = 512
	maxChars  = 8000
)

var prefix = map[string]string{
	"query":   "query: ",
	"passage": "passage: ",
}

func runtimeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		fatal("UserHomeDir", err)
	}
	return filepath.Join(home, ".config", "memmem", "runtime")
}

// extractOne writes data to dst only if missing or size-mismatched (idempotent
// first-run extraction). Returns whether it actually wrote.
func extractOne(dst string, data []byte) (wrote bool) {
	if fi, err := os.Stat(dst); err == nil && fi.Size() == int64(len(data)) {
		return false
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		fatal("mkdir runtime", err)
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		fatal("write "+dst, err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		fatal("rename "+dst, err)
	}
	return true
}

func sha8(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])[:8]
}

func main() {
	rt := runtimeDir()
	fmt.Println("=== Method 1: go:embed self-extraction ===")
	fmt.Printf("runtime dir: %s\n", rt)
	fmt.Printf("model embedded in binary: %v\n", modelEmbedded)

	// MEASUREMENT-ONLY — MUST NOT SHIP. Wipes the runtime dir so every run
	// measures a true COLD first-run extraction. In the real port this line must
	// be deleted: it would delete the user's ~/.config/memmem/runtime/ (including
	// a 235MB downloaded model) on every launch. extractOne's size-match skip
	// already provides idempotency without any wipe. See README "Graduation notes".
	_ = os.RemoveAll(rt)

	dylibDst := filepath.Join(rt, "libonnxruntime.dylib")
	tokenizerDst := filepath.Join(rt, "tokenizer.json")
	modelDst := filepath.Join(rt, "model_fp16.onnx")

	start := time.Now()
	w1 := extractOne(dylibDst, dylibBytes)
	w2 := extractOne(tokenizerDst, tokenizerBytes)
	totalBytes := len(dylibBytes) + len(tokenizerBytes)
	if modelEmbedded {
		extractOne(modelDst, modelBytes())
		totalBytes += len(modelBytes())
	} else {
		// download-on-first-run model: use the existing on-disk cache.
		modelDst = filepath.Join("..", "..", ".cache", "Xenova", "multilingual-e5-small", "onnx", "model_fp16.onnx")
	}
	elapsed := time.Since(start)

	fmt.Printf("dylib  sha8=%s extracted=%v (%d bytes)\n", sha8(dylibBytes), w1, len(dylibBytes))
	fmt.Printf("tokenizer sha8=%s extracted=%v (%d bytes)\n", sha8(tokenizerBytes), w2, len(tokenizerBytes))
	fmt.Printf("first-run extraction: %.3f s for %d bytes (%.1f MB)\n",
		elapsed.Seconds(), totalBytes, float64(totalBytes)/1e6)
	fmt.Println()

	// --- prove the EXTRACTED dylib + tokenizer actually drive a real embedding ---
	ort.SetSharedLibraryPath(dylibDst)
	if err := ort.InitializeEnvironment(); err != nil {
		fatal("InitializeEnvironment (extracted dylib)", err)
	}
	defer ort.DestroyEnvironment()

	opts, err := ort.NewSessionOptions()
	if err != nil {
		fatal("NewSessionOptions", err)
	}
	defer opts.Destroy()
	if err := opts.SetGraphOptimizationLevel(ort.GraphOptimizationLevelDisableAll); err != nil {
		fatal("SetGraphOptimizationLevel", err)
	}

	tkData, err := os.ReadFile(tokenizerDst)
	if err != nil {
		fatal("read extracted tokenizer", err)
	}
	tk, err := tokenizers.FromBytesWithTruncation(tkData, maxTokens, tokenizers.TruncationDirectionRight)
	if err != nil {
		fatal("tokenizer FromBytes", err)
	}
	defer tk.Close()

	vec := embed("passage", "memmem stores atomic fact and event memory records with provenance.",
		tk, modelDst, opts)

	// Compare against the committed Track A baseline to prove the extracted
	// artifacts produce the SAME vector as the validated pipeline.
	baseRaw, err := os.ReadFile(filepath.Join("..", "baseline.json"))
	if err != nil {
		fatal("read baseline", err)
	}
	var baseline map[string][]float64
	if err := json.Unmarshal(baseRaw, &baseline); err != nil {
		fatal("parse baseline", err)
	}
	cos := cosine(vec, baseline["passage"])
	fmt.Println("=== embedding via EXTRACTED dylib + tokenizer ===")
	fmt.Printf("  dim=%d  norm=%.6f\n", len(vec), l2norm(vec))
	fmt.Printf("  cosine vs Track A baseline = %.10f\n", cos)
	if cos >= 0.9999 {
		fmt.Println("  PASS: extracted artifacts reproduce the validated vector")
	} else {
		fmt.Println("  FAIL")
	}
}

func embed(kind, text string, tk *tokenizers.Tokenizer, modelPath string, opts *ort.SessionOptions) []float32 {
	truncated := text
	if len(truncated) > maxChars {
		truncated = truncated[:maxChars]
	}
	input := prefix[kind] + truncated

	inputNames := []string{"input_ids", "attention_mask", "token_type_ids"}
	outputName := "last_hidden_state"

	enc := tk.EncodeWithOptions(input, true,
		tokenizers.WithReturnTypeIDs(),
		tokenizers.WithReturnAttentionMask(),
	)
	seqLen := len(enc.IDs)

	ids := make([]int64, seqLen)
	mask := make([]int64, seqLen)
	types := make([]int64, seqLen)
	for i := range enc.IDs {
		ids[i] = int64(enc.IDs[i])
		mask[i] = int64(enc.AttentionMask[i])
		if i < len(enc.TypeIDs) {
			types[i] = int64(enc.TypeIDs[i])
		}
	}

	shape := ort.NewShape(1, int64(seqLen))
	idsT, _ := ort.NewTensor(shape, ids)
	defer idsT.Destroy()
	maskT, _ := ort.NewTensor(shape, mask)
	defer maskT.Destroy()
	typesT, _ := ort.NewTensor(shape, types)
	defer typesT.Destroy()

	outShape := ort.NewShape(1, int64(seqLen), embedDim)
	outT, _ := ort.NewEmptyTensor[float32](outShape)
	defer outT.Destroy()

	sess, err := ort.NewAdvancedSession(modelPath, inputNames, []string{outputName},
		[]ort.Value{idsT, maskT, typesT}, []ort.Value{outT}, opts)
	if err != nil {
		fatal("NewAdvancedSession", err)
	}
	defer sess.Destroy()

	if err := sess.Run(); err != nil {
		fatal("Run", err)
	}

	hidden := outT.GetData()
	pooled := make([]float64, embedDim)
	var maskSum float64
	for t := 0; t < seqLen; t++ {
		m := float64(mask[t])
		if m == 0 {
			continue
		}
		maskSum += m
		base := t * embedDim
		for d := 0; d < embedDim; d++ {
			pooled[d] += float64(hidden[base+d]) * m
		}
	}
	for d := 0; d < embedDim; d++ {
		pooled[d] /= maskSum
	}
	var nrm float64
	for d := 0; d < embedDim; d++ {
		nrm += pooled[d] * pooled[d]
	}
	nrm = math.Sqrt(nrm)
	out := make([]float32, embedDim)
	for d := 0; d < embedDim; d++ {
		out[d] = float32(pooled[d] / nrm)
	}
	return out
}

func cosine(a []float32, b []float64) float64 {
	var dot, na, nb float64
	for i := range a {
		av := float64(a[i])
		dot += av * b[i]
		na += av * av
		nb += b[i] * b[i]
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}

func l2norm(a []float32) float64 {
	var s float64
	for _, x := range a {
		s += float64(x) * float64(x)
	}
	return math.Sqrt(s)
}

func fatal(ctx string, err error) {
	fmt.Fprintf(os.Stderr, "FATAL [%s]: %v\n", ctx, err)
	os.Exit(1)
}
