package embeddings

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"

	"github.com/daulet/tokenizers"
	ort "github.com/yalue/onnxruntime_go"
)

// Config locates the native onnxruntime library and the model/tokenizer files.
// Zero value uses DefaultConfig(). Paths are configurable so tests and Phase 5
// (runtime-dir + download-on-first-run) can point them elsewhere; for now they
// default to the gitignored .cache location the TS pipeline also uses.
type Config struct {
	// ModelPath is the fp16 ONNX model file.
	ModelPath string
	// TokenizerPath is the tokenizer.json file.
	TokenizerPath string
	// ORTSharedLibraryPath is libonnxruntime (.dylib/.so/.dll). Empty leaves the
	// onnxruntime_go default (which may already be set process-wide).
	ORTSharedLibraryPath string
}

// DefaultConfig points at the repo-relative .cache location populated by the TS
// pipeline (env.cacheDir = './.cache' in embeddings-model.ts) and the Homebrew
// onnxruntime 1.26 install validated by the Phase 0 PoC. Phase 5 will replace
// this with a proper runtime dir + download.
func DefaultConfig() Config {
	const cacheDir = ".cache/Xenova/multilingual-e5-small"
	return Config{
		ModelPath:            filepath.Join(cacheDir, "onnx", "model_fp16.onnx"),
		TokenizerPath:        filepath.Join(cacheDir, "tokenizer.json"),
		ORTSharedLibraryPath: "/opt/homebrew/opt/onnxruntime/lib/libonnxruntime.dylib",
	}
}

// Model holds the lazily-initialized, reused ONNX session and tokenizer. It is
// safe for concurrent use after construction; the underlying ORT session
// serializes Run calls via mu.
type Model struct {
	cfg        Config
	tokenizer  *tokenizers.Tokenizer
	options    *ort.SessionOptions
	session    *ort.DynamicAdvancedSession
	inputNames []string
	outputName string

	mu sync.Mutex // serializes Run; ORT sessions are not guaranteed concurrent-safe
}

// ortEnvOnce guards process-wide onnxruntime environment initialization. The ORT
// environment is a process global; initializing it more than once errors, and
// multiple Models must share it.
var (
	ortEnvMu   sync.Mutex
	ortEnvDone bool
)

func initORTEnv(libPath string) error {
	ortEnvMu.Lock()
	defer ortEnvMu.Unlock()
	if ortEnvDone {
		return nil
	}
	if libPath != "" {
		ort.SetSharedLibraryPath(libPath)
	}
	if err := ort.InitializeEnvironment(); err != nil {
		return fmt.Errorf("initialize onnxruntime environment: %w", err)
	}
	ortEnvDone = true
	return nil
}

// process-wide default model, lazily loaded by Embed/Init.
var (
	defaultMu    sync.Mutex
	defaultInst  *Model
	defaultErr   error
	defaultBuilt bool
)

func defaultModel() (*Model, error) {
	defaultMu.Lock()
	defer defaultMu.Unlock()
	if defaultBuilt {
		return defaultInst, defaultErr
	}
	defaultBuilt = true
	defaultInst, defaultErr = NewModel(DefaultConfig())
	return defaultInst, defaultErr
}

// NewModel loads the tokenizer and creates a single reusable ONNX session.
// Mirrors initModel() in embeddings-model.ts (one-time load), but as an explicit
// handle so paths are configurable and the session is reused across Embed calls
// (graduation gap #2). All failures return an error (gap #3).
func NewModel(cfg Config) (*Model, error) {
	if cfg.ModelPath == "" {
		cfg.ModelPath = DefaultConfig().ModelPath
	}
	if cfg.TokenizerPath == "" {
		cfg.TokenizerPath = DefaultConfig().TokenizerPath
	}

	if err := initORTEnv(cfg.ORTSharedLibraryPath); err != nil {
		return nil, err
	}

	// ORT 1.26's default ("EnableAll") graph optimizer crashes during session
	// init on this fp16 BERT model: SimplifiedLayerNormFusion tries to index a
	// constant by a name that the fp16 precision-free cast pass removed
	// ("InsertedPrecisionFreeCast_.../LayerNorm/Constant_output_0"). Disabling
	// graph optimization avoids the crash and does NOT change output accuracy
	// (the Phase 0 PoC reproduced TS vectors bit-for-bit with it disabled).
	// MUST be re-validated if the pinned ORT version changes — a newer build may
	// fix the fusion bug, or may behave differently. See poc/README.md.
	options, err := ort.NewSessionOptions()
	if err != nil {
		return nil, fmt.Errorf("new session options: %w", err)
	}
	if err := options.SetGraphOptimizationLevel(ort.GraphOptimizationLevelDisableAll); err != nil {
		options.Destroy()
		return nil, fmt.Errorf("set graph optimization level: %w", err)
	}

	// Discover the model's actual input/output tensor names rather than assuming
	// them (the PoC verified these against the .onnx: input_ids, attention_mask,
	// token_type_ids; output last_hidden_state).
	inputs, outputs, err := ort.GetInputOutputInfoWithOptions(cfg.ModelPath, options)
	if err != nil {
		options.Destroy()
		return nil, fmt.Errorf("inspect model io (%s): %w", cfg.ModelPath, err)
	}
	if len(outputs) == 0 {
		options.Destroy()
		return nil, fmt.Errorf("model %s exposes no outputs", cfg.ModelPath)
	}
	inputNames := make([]string, 0, len(inputs))
	for _, in := range inputs {
		switch in.Name {
		case "input_ids", "attention_mask", "token_type_ids":
			inputNames = append(inputNames, in.Name)
		default:
			options.Destroy()
			return nil, fmt.Errorf("model %s wants unexpected input %q", cfg.ModelPath, in.Name)
		}
	}
	outputName := outputs[0].Name

	tkData, err := os.ReadFile(cfg.TokenizerPath)
	if err != nil {
		options.Destroy()
		return nil, fmt.Errorf("read tokenizer %s: %w", cfg.TokenizerPath, err)
	}
	// Truncate to MaxTokens (512) to mirror transformers.js's model_max_length.
	tk, err := tokenizers.FromBytesWithTruncation(tkData, MaxTokens, tokenizers.TruncationDirectionRight)
	if err != nil {
		options.Destroy()
		return nil, fmt.Errorf("load tokenizer: %w", err)
	}

	// Create the ONNX session ONCE and reuse it (graduation gap #2). Dynamic
	// session allows the varying sequence lengths across calls without rebuild.
	session, err := ort.NewDynamicAdvancedSession(cfg.ModelPath, inputNames, []string{outputName}, options)
	if err != nil {
		tk.Close()
		options.Destroy()
		return nil, fmt.Errorf("create onnx session: %w", err)
	}

	return &Model{
		cfg:        cfg,
		tokenizer:  tk,
		options:    options,
		session:    session,
		inputNames: inputNames,
		outputName: outputName,
	}, nil
}

// Close releases the ONNX session, session options, and tokenizer.
func (m *Model) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var first error
	if m.session != nil {
		if err := m.session.Destroy(); err != nil && first == nil {
			first = err
		}
		m.session = nil
	}
	if m.options != nil {
		if err := m.options.Destroy(); err != nil && first == nil {
			first = err
		}
		m.options = nil
	}
	if m.tokenizer != nil {
		if err := m.tokenizer.Close(); err != nil && first == nil {
			first = err
		}
		m.tokenizer = nil
	}
	return first
}

// Embed runs the full pipeline for one text. See package-level Embed.
func (m *Model) Embed(kind Kind, text string) ([]float32, error) {
	pfx, ok := prefix[kind]
	if !ok {
		return nil, fmt.Errorf("unknown embedding kind %q", kind)
	}

	// Truncate by UTF-16 code units to match TS text.substring(0, 8000), THEN
	// prefix (graduation gap #1). Order matches embeddings-model.ts.
	input := pfx + truncateUTF16(text, MaxContentChars)

	enc, err := m.tokenizer.EncodeWithOptionsErr(input, true,
		tokenizers.WithReturnTypeIDs(),
		tokenizers.WithReturnAttentionMask(),
	)
	if err != nil {
		return nil, fmt.Errorf("tokenize: %w", err)
	}
	seqLen := len(enc.IDs)
	if seqLen == 0 {
		return nil, fmt.Errorf("tokenizer produced zero tokens")
	}

	ids := make([]int64, seqLen)
	mask := make([]int64, seqLen)
	types := make([]int64, seqLen)
	for i := range enc.IDs {
		ids[i] = int64(enc.IDs[i])
		if i < len(enc.AttentionMask) {
			mask[i] = int64(enc.AttentionMask[i])
		}
		if i < len(enc.TypeIDs) {
			types[i] = int64(enc.TypeIDs[i])
		}
	}

	hidden, err := m.run(ids, mask, types, seqLen)
	if err != nil {
		return nil, err
	}

	return poolAndNormalize(hidden, mask, seqLen), nil
}

// run executes the shared ONNX session for a single (batch=1) sequence and
// returns the flattened [seqLen*Dim] last_hidden_state. It holds m.mu so the
// reused session is not entered concurrently.
func (m *Model) run(ids, mask, types []int64, seqLen int) ([]float32, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.session == nil {
		return nil, fmt.Errorf("model is closed")
	}

	shape := ort.NewShape(1, int64(seqLen))
	idsT, err := ort.NewTensor(shape, ids)
	if err != nil {
		return nil, fmt.Errorf("input_ids tensor: %w", err)
	}
	defer idsT.Destroy()
	maskT, err := ort.NewTensor(shape, mask)
	if err != nil {
		return nil, fmt.Errorf("attention_mask tensor: %w", err)
	}
	defer maskT.Destroy()
	typesT, err := ort.NewTensor(shape, types)
	if err != nil {
		return nil, fmt.Errorf("token_type_ids tensor: %w", err)
	}
	defer typesT.Destroy()

	byName := map[string]ort.Value{
		"input_ids":      idsT,
		"attention_mask": maskT,
		"token_type_ids": typesT,
	}
	inVals := make([]ort.Value, len(m.inputNames))
	for i, n := range m.inputNames {
		inVals[i] = byName[n]
	}

	outShape := ort.NewShape(1, int64(seqLen), int64(Dim))
	outT, err := ort.NewEmptyTensor[float32](outShape)
	if err != nil {
		return nil, fmt.Errorf("output tensor: %w", err)
	}
	defer outT.Destroy()

	if err := m.session.Run(inVals, []ort.Value{outT}); err != nil {
		return nil, fmt.Errorf("onnx run: %w", err)
	}

	// Copy out before the tensor is destroyed by defer.
	data := outT.GetData()
	out := make([]float32, len(data))
	copy(out, data)
	return out, nil
}

// poolAndNormalize performs mask-weighted mean pooling over the [seqLen, Dim]
// hidden states then L2-normalizes, matching transformers.js {pooling:'mean',
// normalize:true}. Computation is done in float64 to match the PoC's verified
// numerics, then cast to float32.
func poolAndNormalize(hidden []float32, mask []int64, seqLen int) []float32 {
	pooled := make([]float64, Dim)
	var maskSum float64
	for t := 0; t < seqLen; t++ {
		m := float64(mask[t])
		if m == 0 {
			continue
		}
		maskSum += m
		base := t * Dim
		for d := 0; d < Dim; d++ {
			pooled[d] += float64(hidden[base+d]) * m
		}
	}
	if maskSum == 0 {
		maskSum = 1 // avoid div-by-zero; degenerate all-padding input
	}
	var nrm float64
	for d := 0; d < Dim; d++ {
		pooled[d] /= maskSum
		nrm += pooled[d] * pooled[d]
	}
	nrm = math.Sqrt(nrm)
	if nrm == 0 {
		nrm = 1
	}
	out := make([]float32, Dim)
	for d := 0; d < Dim; d++ {
		out[d] = float32(pooled[d] / nrm)
	}
	return out
}
