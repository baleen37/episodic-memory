package db

import (
	"database/sql"
	"testing"

	sqlite_vec "github.com/asg017/sqlite-vec-go-bindings/ncruces"
	"github.com/ncruces/go-sqlite3"
	_ "github.com/ncruces/go-sqlite3/driver"
	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/experimental"
)

// TestSpikeVec0KNN confirms the ncruces + sqlite-vec binding supports vec0
// virtual tables, float32 vector insert, and KNN MATCH queries, CGO-free.
func TestSpikeVec0KNN(t *testing.T) {
	sqlite3.RuntimeConfig = wazero.NewRuntimeConfig().
		WithCoreFeatures(api.CoreFeaturesV2 | experimental.CoreFeaturesThreads)

	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`CREATE VIRTUAL TABLE vec_test USING vec0(embedding float[4])`); err != nil {
		t.Fatalf("create vec0: %v", err)
	}

	v1, err := sqlite_vec.SerializeFloat32([]float32{1, 0, 0, 0})
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	v2, _ := sqlite_vec.SerializeFloat32([]float32{0, 1, 0, 0})

	if _, err := db.Exec(`INSERT INTO vec_test(rowid, embedding) VALUES (?, ?)`, 1, v1); err != nil {
		t.Fatalf("insert v1: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO vec_test(rowid, embedding) VALUES (?, ?)`, 2, v2); err != nil {
		t.Fatalf("insert v2: %v", err)
	}

	q, _ := sqlite_vec.SerializeFloat32([]float32{0.9, 0.1, 0, 0})
	rows, err := db.Query(
		`SELECT rowid, distance FROM vec_test WHERE embedding MATCH ? ORDER BY distance LIMIT 1`, q)
	if err != nil {
		t.Fatalf("knn query: %v", err)
	}
	defer rows.Close()

	if !rows.Next() {
		t.Fatal("expected a KNN result")
	}
	var rowid int64
	var dist float64
	if err := rows.Scan(&rowid, &dist); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if rowid != 1 {
		t.Fatalf("expected nearest rowid 1, got %d (dist %f)", rowid, dist)
	}
}
