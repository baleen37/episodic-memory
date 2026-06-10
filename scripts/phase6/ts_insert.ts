// Phase 6 index-equivalence harness (TS side).
// Inserts a fixed corpus of memory records + TS embedPassage vectors into the DB
// at CONVERSATION_MEMORY_DB_PATH so a Go (or TS) `search` binary can read it.
// Run from repo root so ./.cache (TS env.cacheDir) and ./src imports resolve.
import { openDatabase, insertMemoryRecord, insertMemoryRecordVector } from "../../src/core/db.ts";
import { embedPassage } from "../../src/core/embeddings.ts";
import { CORPUS } from "./corpus.ts";

const db = openDatabase();
try {
  for (const r of CORPUS) {
    const id = insertMemoryRecord(db, {
      kind: r.kind,
      text: r.text,
      sourceKind: r.sourceKind,
      archivePath: r.archivePath,
      lineStart: r.lineStart,
      lineEnd: r.lineEnd,
      observedAt: r.observedAt,
      project: r.project,
      projectName: null,
      confidence: 1.0,
      status: "active",
      supersedesId: null,
      dedupeKey: r.dedupeKey,
      extractionVersion: 1,
      embeddingVersion: 2,
    });
    const emb = await embedPassage(r.text);
    if (!emb) throw new Error("embedPassage returned null for: " + r.text);
    insertMemoryRecordVector(db, id, emb);
    console.error(`inserted id=${id} key=${r.dedupeKey}`);
  }
} finally {
  db.close();
}
console.error("TS insert done");
