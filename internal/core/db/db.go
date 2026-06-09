// Package db is the memory database layer for the Go port of memmem.
//
// Ports src/core/db.ts. Phase 2 will implement the schema (memory_records,
// vec_memory_records, extraction_state) on top of github.com/ncruces/go-sqlite3
// plus github.com/asg017/sqlite-vec-go-bindings/ncruces (WASM, CGO-free).
//
// TODO(phase2): port openDatabase()/initDatabase() and the migrations under
// src/core/migrations/.
package db
