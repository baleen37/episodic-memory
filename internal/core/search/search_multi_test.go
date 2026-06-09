package search

import (
	"context"
	"math"
	"testing"

	"github.com/baleen37/memmem/internal/core/db"
)

// queryEmbed mirrors the TS makeQueryEmbed: "alpha-query" -> hotVector(0),
// "beta-query" -> hotVector(1), anything else -> hotVector(2).
func queryEmbed() Embedder {
	return func(text string) ([]float32, error) {
		switch text {
		case "alpha-query":
			return hotVector(0), nil
		case "beta-query":
			return hotVector(1), nil
		default:
			return hotVector(2), nil
		}
	}
}

func TestSearchMultiANDIntersection(t *testing.T) {
	d := newTestDB(t)
	id1 := insertRecord(t, d, memory(withText("record alpha only"), withDedupe("multi-r1")))
	insertVector(t, d, id1, hotVector(0))
	id2 := insertRecord(t, d, memory(withText("record beta only"), withDedupe("multi-r2")))
	insertVector(t, d, id2, hotVector(1))
	id3 := insertRecord(t, d, memory(withText("record no vector"), withDedupe("multi-r3")))

	results, err := SearchMulti(context.Background(), []string{"alpha-query", "beta-query"},
		Options{DB: d, Limit: 10, Embedder: queryEmbed()})
	if err != nil {
		t.Fatal(err)
	}
	got := map[int64]bool{}
	for _, r := range results {
		got[r.ID] = true
	}
	if !got[id1] || !got[id2] {
		t.Fatalf("expected both id1=%d and id2=%d in intersection, got %v", id1, id2, ids(results))
	}
	if got[id3] {
		t.Fatalf("id3=%d has no vector, must not appear", id3)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
}

func TestSearchMultiMeanScoring(t *testing.T) {
	d := newTestDB(t)
	// Record vector symmetric to both query vectors => equal per-query distance,
	// so mean == the per-query score.
	vec := make([]float32, db.EmbeddingDim)
	vec[0] = 0.7071
	vec[1] = 0.7071
	id := insertRecord(t, d, memory(withText("record both"), withDedupe("multi-mean")))
	insertVector(t, d, id, vec)

	expectedDist := math.Sqrt(math.Pow(1-0.7071, 2) + math.Pow(0-0.7071, 2))
	expectedScore := 1.0 / (1.0 + expectedDist)

	results, err := SearchMulti(context.Background(), []string{"alpha-query", "beta-query"},
		Options{DB: d, Limit: 10, Embedder: queryEmbed()})
	if err != nil {
		t.Fatal(err)
	}
	var rec *MemorySearchResult
	for i := range results {
		if results[i].ID == id {
			rec = &results[i]
		}
	}
	if rec == nil || rec.Score == nil {
		t.Fatalf("record not found or unscored: %+v", results)
	}
	if math.Abs(*rec.Score-expectedScore) > 1e-3 {
		t.Fatalf("score = %f, want ~%f", *rec.Score, expectedScore)
	}
}

func TestSearchMultiSortAndLimit(t *testing.T) {
	d := newTestDB(t)
	for i := 0; i < 5; i++ {
		w := float32(i+1) / 6.0
		vec := make([]float32, db.EmbeddingDim)
		vec[0] = w
		vec[1] = 1 - w
		rid := insertRecord(t, d, memory(withText("sort record"), withDedupe("multi-sort-"+string(rune('a'+i)))))
		insertVector(t, d, rid, vec)
	}

	results, err := SearchMulti(context.Background(), []string{"alpha-query", "beta-query"},
		Options{DB: d, Limit: 3, Embedder: queryEmbed()})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) > 3 {
		t.Fatalf("limit not respected: %d results", len(results))
	}
	for i := 1; i < len(results); i++ {
		prev, cur := score(results[i-1]), score(results[i])
		if prev < cur {
			t.Fatalf("results not sorted desc: [%d]=%f < [%d]=%f", i-1, prev, i, cur)
		}
	}
}

func TestSearchMultiEmptyIntersection(t *testing.T) {
	d := newTestDB(t)
	insertRecord(t, d, memory(withText("no vector record"), withDedupe("multi-empty")))

	results, err := SearchMulti(context.Background(), []string{"alpha-query", "beta-query"},
		Options{DB: d, Limit: 10, Embedder: queryEmbed()})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("expected empty intersection, got %v", ids(results))
	}
}

func TestSearchMultiSingleElementDelegates(t *testing.T) {
	d := newTestDB(t)
	for i := 0; i < 3; i++ {
		rid := insertRecord(t, d, memory(withText("single test record"), withDedupe("multi-single-"+string(rune('a'+i)))))
		insertVector(t, d, rid, hotVector(i%3))
	}

	multi, err := SearchMulti(context.Background(), []string{"alpha-query"},
		Options{DB: d, Limit: 10, Embedder: queryEmbed()})
	if err != nil {
		t.Fatal(err)
	}
	single, err := Search(context.Background(), "alpha-query",
		Options{DB: d, Limit: 10, Embedder: queryEmbed()})
	if err != nil {
		t.Fatal(err)
	}
	multiSet, singleSet := map[int64]bool{}, map[int64]bool{}
	for _, r := range multi {
		multiSet[r.ID] = true
	}
	for _, r := range single {
		singleSet[r.ID] = true
	}
	if len(multiSet) != len(singleSet) {
		t.Fatalf("size mismatch: multi=%d single=%d", len(multiSet), len(singleSet))
	}
	for id := range singleSet {
		if !multiSet[id] {
			t.Fatalf("id %d in single but not in multi-delegated", id)
		}
	}
}

func TestSearchMultiWideCandidatePool(t *testing.T) {
	d := newTestDB(t)
	// X is relevant to both queries but not top for either.
	xVec := make([]float32, db.EmbeddingDim)
	xVec[0] = 0.5
	xVec[1] = 0.5
	xID := insertRecord(t, d, memory(withText("record relevant to both"), withDedupe("wide-x")))
	insertVector(t, d, xID, xVec)

	for i := 0; i < 60; i++ {
		aVec := make([]float32, db.EmbeddingDim)
		aVec[0] = 0.9
		aID := insertRecord(t, d, memory(withText("alpha noise"), withDedupe("wide-a-"+itoa(i))))
		insertVector(t, d, aID, aVec)

		bVec := make([]float32, db.EmbeddingDim)
		bVec[1] = 0.9
		bID := insertRecord(t, d, memory(withText("beta noise"), withDedupe("wide-b-"+itoa(i))))
		insertVector(t, d, bID, bVec)
	}

	results, err := SearchMulti(context.Background(), []string{"alpha-query", "beta-query"},
		Options{DB: d, Limit: 200, Embedder: queryEmbed()})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range results {
		if r.ID == xID {
			found = true
		}
	}
	if !found {
		t.Fatalf("wide candidate pool should include X (id=%d); got %d results", xID, len(results))
	}
}

func score(r MemorySearchResult) float64 {
	if r.Score == nil {
		return 0
	}
	return *r.Score
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
