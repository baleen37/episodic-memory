// Phase 0 Track A — embedding accuracy PoC.
//
// Reproduces the memmem TS embedding pipeline in Go and compares the resulting
// 384-dim vectors against baseline vectors produced by the transformers.js
// pipeline (src/core/embeddings-model.ts).
//
// Pipeline:
//   1. tokenizer.json (Xenova/multilingual-e5-small) via daulet/tokenizers
//   2. input = prefix + text.substring(0, 8000); prefix "query: " / "passage: "
//   3. onnxruntime session on model_fp16.onnx (input_ids, attention_mask,
//      token_type_ids), output last_hidden_state
//   4. mask-weighted mean pooling -> L2 normalize -> 384-dim
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"

	ort "github.com/yalue/onnxruntime_go"

	"github.com/daulet/tokenizers"
)

const (
	cacheDir     = "./.cache/Xenova/multilingual-e5-small" // relative to repo root (the CWD when run per README)
	modelPath    = cacheDir + "/onnx/model_fp16.onnx"
	tokenizerPth = cacheDir + "/tokenizer.json"
	ortLib       = "/opt/homebrew/opt/onnxruntime/lib/libonnxruntime.dylib"
	baselineJSON = "poc/baseline.json" // all paths are relative to repo root (the CWD)
	maxChars     = 8000
	maxTokens    = 512
	embedDim     = 384
)

var prefix = map[string]string{
	"query":   "query: ",
	"passage": "passage: ",
}

func main() {
	// --- onnxruntime init ---
	ort.SetSharedLibraryPath(ortLib)
	if err := ort.InitializeEnvironment(); err != nil {
		fatal("InitializeEnvironment", err)
	}
	defer ort.DestroyEnvironment()

	// ORT 1.26's "EnableAll" graph optimizer crashes on this fp16 BERT model
	// (SimplifiedLayerNormFusion cast bug). Disable graph optimizations.
	opts, err := ort.NewSessionOptions()
	if err != nil {
		fatal("NewSessionOptions", err)
	}
	defer opts.Destroy()
	if err := opts.SetGraphOptimizationLevel(ort.GraphOptimizationLevelDisableAll); err != nil {
		fatal("SetGraphOptimizationLevel", err)
	}

	// --- inspect actual model tensor names ---
	inputs, outputs, err := ort.GetInputOutputInfoWithOptions(modelPath, opts)
	if err != nil {
		fatal("GetInputOutputInfo", err)
	}
	fmt.Println("=== ONNX model tensor names ===")
	inputNames := make([]string, 0, len(inputs))
	for _, in := range inputs {
		fmt.Printf("  INPUT  %-16s dims=%v type=%v\n", in.Name, in.Dimensions, in.DataType)
		inputNames = append(inputNames, in.Name)
	}
	var outputName string
	for i, out := range outputs {
		fmt.Printf("  OUTPUT %-18s dims=%v type=%v\n", out.Name, out.Dimensions, out.DataType)
		if i == 0 {
			outputName = out.Name
		}
	}
	fmt.Println()

	// --- tokenizer (apply 512 truncation to mirror model_max_length) ---
	tkData, err := os.ReadFile(tokenizerPth)
	if err != nil {
		fatal("read tokenizer.json", err)
	}
	tk, err := tokenizers.FromBytesWithTruncation(tkData, maxTokens, tokenizers.TruncationDirectionRight)
	if err != nil {
		fatal("tokenizer FromBytesWithTruncation", err)
	}
	defer tk.Close()

	// --- baseline ---
	baseRaw, err := os.ReadFile(baselineJSON)
	if err != nil {
		fatal("read baseline", err)
	}
	var baseline map[string][]float64
	if err := json.Unmarshal(baseRaw, &baseline); err != nil {
		fatal("parse baseline", err)
	}

	samples := []struct {
		kind string
		text string
	}{
		{"query", "한국어와 영어가 섞인 검색 쿼리 테스트"},
		{"passage", "memmem stores atomic fact and event memory records with provenance."},
	}

	allPass := true
	for _, s := range samples {
		vec := embed(s.kind, s.text, tk, inputNames, outputName, opts)
		base := baseline[s.kind]
		if len(base) != embedDim {
			fatal("baseline dim", fmt.Errorf("%s baseline dim=%d", s.kind, len(base)))
		}
		cos := cosine(vec, base)
		norm := l2norm(vec)

		fmt.Printf("=== %s ===\n", s.kind)
		fmt.Printf("  dim=%d  norm=%.6f\n", len(vec), norm)
		fmt.Printf("  go   head[0:8]=%s\n", head8(vec))
		fmt.Printf("  base head[0:8]=%s\n", head8f64(base))
		fmt.Printf("  cosine vs baseline (full 384-dim) = %.10f  (1-cos=%.3e)\n", cos, 1-cos)
		if cos >= 0.9999 {
			fmt.Printf("  PASS (>= 0.9999)\n\n")
		} else {
			fmt.Printf("  FAIL (< 0.9999)\n\n")
			allPass = false
		}
	}

	fmt.Println("=== VERDICT ===")
	if allPass {
		fmt.Println("TRACK A PASSES: both samples cosine >= 0.9999")
	} else {
		fmt.Println("TRACK A DOES NOT PASS the 0.9999 gate (see per-sample values above)")
	}
}

func embed(kind, text string, tk *tokenizers.Tokenizer, inputNames []string, outputName string, opts *ort.SessionOptions) []float32 {
	// GAP: byte truncation, not UTF-16 code units. TS does text.substring(0,8000)
	// (UTF-16 units). Diverges for multilingual text >8000 chars. See README
	// "Known gaps to fix when porting". Test samples are far under 8000.
	truncated := text
	if len(truncated) > maxChars {
		truncated = truncated[:maxChars]
	}
	input := prefix[kind] + truncated

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
	idsT, err := ort.NewTensor(shape, ids)
	if err != nil {
		fatal("ids tensor", err)
	}
	defer idsT.Destroy()
	maskT, err := ort.NewTensor(shape, mask)
	if err != nil {
		fatal("mask tensor", err)
	}
	defer maskT.Destroy()
	typesT, err := ort.NewTensor(shape, types)
	if err != nil {
		fatal("types tensor", err)
	}
	defer typesT.Destroy()

	// Map provided tensors to actual model input names.
	inVals := make([]ort.Value, 0, len(inputNames))
	for _, n := range inputNames {
		switch n {
		case "input_ids":
			inVals = append(inVals, idsT)
		case "attention_mask":
			inVals = append(inVals, maskT)
		case "token_type_ids":
			inVals = append(inVals, typesT)
		default:
			fatal("unexpected input", fmt.Errorf("model wants unknown input %q", n))
		}
	}

	// last_hidden_state: [1, seqLen, 384]
	outShape := ort.NewShape(1, int64(seqLen), embedDim)
	outT, err := ort.NewEmptyTensor[float32](outShape)
	if err != nil {
		fatal("out tensor", err)
	}
	defer outT.Destroy()

	sess, err := ort.NewAdvancedSession(modelPath, inputNames, []string{outputName},
		inVals, []ort.Value{outT}, opts)
	if err != nil {
		fatal("NewAdvancedSession", err)
	}
	defer sess.Destroy()

	if err := sess.Run(); err != nil {
		fatal("Run", err)
	}

	hidden := outT.GetData() // len = seqLen*384, row-major

	// mask-weighted mean pooling
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

	// L2 normalize
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

func head8(v []float32) string {
	s := "["
	for i := 0; i < 8; i++ {
		if i > 0 {
			s += ","
		}
		s += fmt.Sprintf("%.6f", v[i])
	}
	return s + "]"
}

func head8f64(v []float64) string {
	s := "["
	for i := 0; i < 8; i++ {
		if i > 0 {
			s += ","
		}
		s += fmt.Sprintf("%.6f", v[i])
	}
	return s + "]"
}

func fatal(ctx string, err error) {
	fmt.Fprintf(os.Stderr, "FATAL [%s]: %v\n", ctx, err)
	os.Exit(1)
}
