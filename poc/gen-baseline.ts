/**
 * Generates poc/baseline.json — the 384-dim ground-truth vectors the Track A
 * accuracy gate rests on. Run with bun (NOT node):
 *
 *   bun run poc/gen-baseline.ts
 *
 * Uses the real TS embedding pipeline (src/core/embeddings-model.ts), so if that
 * pipeline ever changes, regenerate and re-check the Go PoC against the new baseline.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateEmbeddingFromModel } from '../src/core/embeddings-model.ts';

const samples: Array<['query' | 'passage', string]> = [
  ['query', '한국어와 영어가 섞인 검색 쿼리 테스트'],
  ['passage', 'memmem stores atomic fact and event memory records with provenance.'],
];

const out: Record<string, number[]> = {};
for (const [kind, text] of samples) {
  const v = await generateEmbeddingFromModel(kind, text);
  if (!v) {
    console.log('NULL');
    continue;
  }
  const arr = Array.from(v) as number[];
  const norm = Math.sqrt(arr.reduce((s, x) => s + x * x, 0));
  console.log(
    JSON.stringify({ kind, dim: arr.length, norm: +norm.toFixed(6), head: arr.slice(0, 8).map((x) => +x.toFixed(6)) }),
  );
  out[kind] = arr;
}

const outPath = join(import.meta.dir, 'baseline.json');
writeFileSync(outPath, JSON.stringify(out));
console.log(`wrote ${outPath}`);
