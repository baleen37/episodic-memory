// Shared fixed corpus for the Phase 6 index-equivalence harness.
// Mirrored byte-for-byte in corpus.go. observedAt are epoch-ms; chosen so
// date filters (--after / --before) split the set non-trivially.
export type Rec = {
  kind: "fact" | "event";
  text: string;
  sourceKind: string;
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  observedAt: number;
  project: string;
  dedupeKey: string;
};

// 2024-01-15, 2024-06-01, 2025-01-01, 2025-06-01 (UTC midnights)
const D1 = Date.UTC(2024, 0, 15);
const D2 = Date.UTC(2024, 5, 1);
const D3 = Date.UTC(2025, 0, 1);
const D4 = Date.UTC(2025, 5, 1);

export const CORPUS: Rec[] = [
  { kind: "fact",  text: "The transcript archive is the source of truth for memory records.", sourceKind: "claude-projects", archivePath: "/arch/a.jsonl", lineStart: 1,  lineEnd: 3,  observedAt: D1, project: "memmem", dedupeKey: "k1" },
  { kind: "event", text: "Switched the embedding model to multilingual-e5-small with 384 dimensions.", sourceKind: "claude-projects", archivePath: "/arch/a.jsonl", lineStart: 5,  lineEnd: 9,  observedAt: D2, project: "memmem", dedupeKey: "k2" },
  { kind: "fact",  text: "Search is hybrid: vector results first, then text fallback, deduped by id.", sourceKind: "codex-sessions",  archivePath: "/arch/b.jsonl", lineStart: 1,  lineEnd: 4,  observedAt: D3, project: "memmem", dedupeKey: "k3" },
  { kind: "event", text: "Vectors are stored as little-endian float32 raw bytes for index compatibility.", sourceKind: "codex-sessions",  archivePath: "/arch/b.jsonl", lineStart: 6,  lineEnd: 8,  observedAt: D4, project: "other",  dedupeKey: "k4" },
  { kind: "fact",  text: "The user prefers communicating in Korean and concise compact outputs.", sourceKind: "claude-projects", archivePath: "/arch/c.jsonl", lineStart: 2,  lineEnd: 2,  observedAt: D2, project: "other",  dedupeKey: "k5" },
  { kind: "event", text: "Deployed the release pipeline using goreleaser with cgo onnxruntime linkage.", sourceKind: "claude-transcripts", archivePath: "/arch/d.jsonl", lineStart: 10, lineEnd: 14, observedAt: D3, project: "memmem", dedupeKey: "k6" },
  { kind: "fact",  text: "Rate limiting uses a token bucket singleton configurable per provider.", sourceKind: "claude-projects", archivePath: "/arch/e.jsonl", lineStart: 1,  lineEnd: 5,  observedAt: D1, project: "memmem", dedupeKey: "k7" },
  { kind: "event", text: "Cats are independent animals that sleep most of the day in warm spots.", sourceKind: "codex-sessions",  archivePath: "/arch/f.jsonl", lineStart: 1,  lineEnd: 2,  observedAt: D4, project: "other",  dedupeKey: "k8" },
];
