/**
 * Cross-lingual search benchmark.
 *
 * Measures the Korean↔English query gap against the live memory index.
 * Each gold case carries an answer archive_path (collected via a high-confidence
 * English query). We run the English query and the same-meaning Korean query and
 * record, per language: rank of the gold answer in top-K (or miss) and its score.
 *
 * Reports recall@K and mean gold-answer score per language, plus the gap.
 *
 * Run: bun --preload ./scripts/preload-sqlite.ts run scripts/bench-crosslingual.ts
 */
import { openDatabase } from '../plugins/memmem/src/core/db.js';
import { search } from '../plugins/memmem/src/core/search.js';
import { resolveQueryNormalizer } from '../plugins/memmem/src/core/query-normalizer.js';

const K = 10;

interface GoldCase {
  id: string;
  en: string;
  ko: string;
  /** Substring of the answer archive_path that uniquely identifies the gold record. */
  answer: string;
}

// Gold answers were confirmed by running the English query and taking its top hit.
const GOLD: GoldCase[] = [
  {
    id: 'round-robin',
    en: 'round-robin provider distributes rate limits across multiple API keys',
    ko: '라운드로빈 프로바이더로 여러 API 키에 레이트리밋 분산',
    answer: '1020be02-73db-4fe3-83bb-48ae304ea593.jsonl:74-96',
  },
  {
    id: 'initdb-isolation',
    en: 'initDatabase wipes the real database in tests, use in-memory isolation',
    ko: '테스트에서 initDatabase가 실제 DB를 삭제하므로 인메모리로 격리',
    answer: 'a7e306d3-dc01-49d7-8a63-0ef2a8de9593.jsonl:458-733',
  },
  {
    id: 'marketplace-build',
    en: 'marketplace requires committed bin and dist or SessionStart hook breaks',
    ko: '마켓플레이스는 bin과 dist를 커밋해야 하고 안 하면 SessionStart 훅이 깨짐',
    answer: 'agent-aac96ebc9ad1d6b1c.jsonl:1-34',
  },
  {
    id: 'embeddings-prefix',
    en: 'embeddings use multilingual-e5-small with passage and query prefix',
    ko: '임베딩은 multilingual-e5-small에 passage와 query 접두어를 사용',
    answer: 'agent-afc20484d9add15ef.jsonl:1-4',
  },
  {
    id: 'extraction-contract',
    en: 'extraction must be bounded idempotent schema-validated failure-tolerant',
    ko: '추출은 제한적이고 멱등하며 스키마 검증되고 실패에 강해야 함',
    answer: 'agent-af7f9c4940bc4283c.jsonl:1-39',
  },
];

interface Hit {
  rank: number | null; // 1-based; null = miss
  score: number | null;
}

function findGold(results: Awaited<ReturnType<typeof search>>, answer: string): Hit {
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (`${r.archivePath}:${r.lineStart}-${r.lineEnd}`.includes(answer)) {
      return { rank: i + 1, score: r.score ?? null };
    }
  }
  return { rank: null, score: null };
}

// Mock normalizer: simulates a perfect KO→EN translation provider by returning
// the gold case's English query when it sees that case's Korean query. This
// measures the UPPER BOUND of the "wire up queryNormalizerProvider" fix in
// isolation, without making real LLM calls.
function makeMockNormalizer() {
  const koToEn = new Map(GOLD.map(g => [g.ko, g.en]));
  return {
    async complete(prompt: string): Promise<{ text: string }> {
      for (const [ko, en] of koToEn) {
        if (prompt.includes(ko)) return { text: en };
      }
      // Fallback: echo the query portion unchanged.
      const m = prompt.match(/Query: (.*)$/s);
      return { text: m ? m[1].trim() : prompt };
    },
  };
}

async function main() {
  const db = openDatabase();
  // REAL=1 uses the configured LLM provider (true end-to-end). Default uses the
  // mock normalizer to measure the upper bound without LLM calls.
  const normalizer = process.env.REAL
    ? (await resolveQueryNormalizer()) ?? makeMockNormalizer()
    : makeMockNormalizer();
  if (process.env.REAL) console.log('(using REAL configured LLM normalizer)');
  try {
    const rows: Array<{ id: string; en: Hit; ko: Hit; koNorm: Hit }> = [];
    for (const g of GOLD) {
      const enRes = await search(g.en, { db, limit: K });
      const koRes = await search(g.ko, { db, limit: K });
      const koNormRes = await search(g.ko, { db, limit: K, queryNormalizerProvider: normalizer });
      rows.push({
        id: g.id,
        en: findGold(enRes, g.answer),
        ko: findGold(koRes, g.answer),
        koNorm: findGold(koNormRes, g.answer),
      });
    }

    const fmt = (h: Hit) =>
      h.rank === null ? 'MISS'.padEnd(14) : `#${h.rank} ${(h.score! * 100).toFixed(0)}%`.padEnd(14);

    console.log(`\nCross-lingual benchmark (recall@${K}, gold answer rank/score)\n`);
    console.log('case'.padEnd(20) + 'EN'.padEnd(14) + 'KO'.padEnd(14) + 'KO+normalize'.padEnd(14));
    console.log('-'.repeat(62));
    for (const r of rows) {
      console.log(r.id.padEnd(20) + fmt(r.en) + fmt(r.ko) + fmt(r.koNorm));
    }

    const recall = (sel: (r: typeof rows[number]) => Hit) =>
      rows.filter(r => sel(r).rank !== null).length / rows.length;
    const meanScore = (sel: (r: typeof rows[number]) => Hit) => {
      const xs = rows.map(sel).filter(h => h.score !== null).map(h => h.score!);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    };

    const cols: Array<[string, (r: typeof rows[number]) => Hit]> = [
      ['en', r => r.en],
      ['ko', r => r.ko],
      ['koNorm', r => r.koNorm],
    ];

    console.log('-'.repeat(62));
    console.log(
      `recall@${K}`.padEnd(20) +
        cols.map(([, sel]) => `${(recall(sel) * 100).toFixed(0)}%`.padEnd(14)).join(''),
    );
    console.log(
      'mean gold score'.padEnd(20) +
        cols.map(([, sel]) => `${(meanScore(sel) * 100).toFixed(0)}%`.padEnd(14)).join(''),
    );
    const enR = recall(r => r.en), koR = recall(r => r.ko), koNR = recall(r => r.koNorm);
    console.log(`\nKO recall gap (raw): ${((enR - koR) * 100).toFixed(0)}pp | with normalize: ${((enR - koNR) * 100).toFixed(0)}pp | lift: ${((koNR - koR) * 100).toFixed(0)}pp`);
  } finally {
    db.close();
  }
}

main();
