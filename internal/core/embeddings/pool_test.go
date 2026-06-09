package embeddings

import (
	"math"
	"testing"
)

// TestPoolAndNormalize_MaskWeightingWithPadding exercises the mask-weighted mean
// pooling path that the PoC never hit: it builds a [seqLen, Dim] hidden state
// where some positions are padding (mask=0) and proves those positions are
// excluded from the mean. The PoC's two short samples had no padding, so
// mask-weighting was arithmetically identical to a plain mean (graduation gap
// #5). Here the padded rows carry a poison value that a plain mean would let
// leak into the result.
func TestPoolAndNormalize_MaskWeightingWithPadding(t *testing.T) {
	const seqLen = 4
	hidden := make([]float32, seqLen*Dim)

	// Real tokens (mask=1): rows 0 and 1, value 1.0 and 3.0 in every dim.
	// Padding (mask=0): rows 2 and 3, a huge poison value that must NOT appear.
	const poison = 1e6
	for d := 0; d < Dim; d++ {
		hidden[0*Dim+d] = 1.0
		hidden[1*Dim+d] = 3.0
		hidden[2*Dim+d] = poison
		hidden[3*Dim+d] = poison
	}
	mask := []int64{1, 1, 0, 0}

	got := poolAndNormalize(hidden, mask, seqLen)

	// Mask-weighted mean over the two real rows = (1+3)/2 = 2.0 in every dim.
	// After L2 normalization a constant vector v in Dim dims has each component
	// = sign(v) / sqrt(Dim). The actual mean value cancels, so we just check the
	// normalized component and that padding did not leak (a plain mean including
	// poison would also normalize to 1/sqrt(Dim) — so additionally assert the
	// PRE-normalization behavior via a poison-sensitive check below).
	want := float32(1.0 / math.Sqrt(float64(Dim)))
	for d := 0; d < Dim; d++ {
		if diff := math.Abs(float64(got[d] - want)); diff > 1e-6 {
			t.Fatalf("dim %d: got %v, want %v", d, got[d], want)
		}
	}

	// Poison-sensitivity: compare against pooling that (wrongly) includes the
	// padded rows by setting their mask to 1. If mask-weighting were ignored,
	// the unnormalized mean would be dominated by poison; after normalization
	// the constant-vector still collapses to 1/sqrt(Dim), so to make the
	// difference observable we break the constant symmetry on ONE real dim.
	hidden2 := make([]float32, seqLen*Dim)
	copy(hidden2, hidden)
	hidden2[0*Dim+0] = 5.0 // asymmetric value on dim 0, real token
	masked := poolAndNormalize(hidden2, mask, seqLen)
	allOnesMask := []int64{1, 1, 1, 1}
	leaked := poolAndNormalize(hidden2, allOnesMask, seqLen)
	if math.Abs(float64(masked[0]-leaked[0])) < 1e-3 {
		t.Fatalf("expected masked (%v) and unmasked-leaked (%v) results to differ on dim 0", masked[0], leaked[0])
	}
}

func TestPoolAndNormalize_Normalized(t *testing.T) {
	const seqLen = 3
	hidden := make([]float32, seqLen*Dim)
	for i := range hidden {
		hidden[i] = float32((i%7)+1) * 0.13
	}
	mask := []int64{1, 1, 1}
	got := poolAndNormalize(hidden, mask, seqLen)
	var sum float64
	for _, v := range got {
		sum += float64(v) * float64(v)
	}
	if math.Abs(math.Sqrt(sum)-1.0) > 1e-5 {
		t.Fatalf("output not L2-normalized: norm=%v", math.Sqrt(sum))
	}
}
