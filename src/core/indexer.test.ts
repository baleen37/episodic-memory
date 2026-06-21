import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase, upsertExtractionState } from './db.js';
import { resetRateLimiters } from './ratelimiter.js';
import { __setModelForTests } from './embeddings.js';
import { reindexArchiveFile, type ArchiveParser, computeRetryAfter, ATTEMPT_CAP, BASE_DELAY_MS, hasPendingRetryExtractionStateForTests } from './indexer.js';
import type { LLMProvider } from './llm/types.js';

let dir: string | null = null;
let db: ReturnType<typeof initDatabase> | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  __setModelForTests(null, null);
  resetRateLimiters();
  delete process.env.TEST_DB_PATH;
});

test('given-up span (attempt_count>=cap, retry_after null) is skipped', () => {
  process.env.TEST_DB_PATH = ':memory:';
  db = initDatabase();
  upsertExtractionState(db, {
    sourceKind: 'claude-code-projects', archivePath: '/g.jsonl',
    lineStart: 1, lineEnd: 5, sourceHash: 'h1', extractionVersion: 1,
    status: 'errored', attemptCount: ATTEMPT_CAP, retryAfter: null,
  });
  expect(
    hasPendingRetryExtractionStateForTests(db, '/g.jsonl', 1, 5, 'h1', 1),
  ).toBe(true); // true = skip
});

test('errored span still within backoff window is skipped', () => {
  process.env.TEST_DB_PATH = ':memory:';
  db = initDatabase();
  upsertExtractionState(db, {
    sourceKind: 'claude-code-projects', archivePath: '/w.jsonl',
    lineStart: 1, lineEnd: 5, sourceHash: 'h1', extractionVersion: 1,
    status: 'errored', attemptCount: 2, retryAfter: Date.now() + 60_000,
  });
  expect(
    hasPendingRetryExtractionStateForTests(db, '/w.jsonl', 1, 5, 'h1', 1),
  ).toBe(true);
});

test('errored span past backoff window (not given up) is NOT skipped', () => {
  process.env.TEST_DB_PATH = ':memory:';
  db = initDatabase();
  upsertExtractionState(db, {
    sourceKind: 'claude-code-projects', archivePath: '/r.jsonl',
    lineStart: 1, lineEnd: 5, sourceHash: 'h1', extractionVersion: 1,
    status: 'errored', attemptCount: 2, retryAfter: Date.now() - 60_000,
  });
  expect(
    hasPendingRetryExtractionStateForTests(db, '/r.jsonl', 1, 5, 'h1', 1),
  ).toBe(false); // false = eligible to retry
});

test('computeRetryAfter: exponential 5min base, doubling', () => {
  const now = 1_000_000;
  expect(computeRetryAfter(1, now)).toBe(now + 5 * 60 * 1000);   // 5분
  expect(computeRetryAfter(2, now)).toBe(now + 10 * 60 * 1000);  // 10분
  expect(computeRetryAfter(3, now)).toBe(now + 20 * 60 * 1000);  // 20분
  expect(computeRetryAfter(4, now)).toBe(now + 40 * 60 * 1000);  // 40분
});

test('computeRetryAfter: returns null at or above attempt cap (give up)', () => {
  const now = 1_000_000;
  expect(ATTEMPT_CAP).toBe(10);
  expect(computeRetryAfter(ATTEMPT_CAP, now)).toBeNull();
  expect(computeRetryAfter(ATTEMPT_CAP + 1, now)).toBeNull();
});

test('BASE_DELAY_MS is 5 minutes', () => {
  expect(BASE_DELAY_MS).toBe(5 * 60 * 1000);
});

describe('reindexArchiveFile', () => {
  test('extracts memory records from transcript spans and indexes vectors', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, (_, i) => i / 384));

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archiveDir = join(dir, 'claude-code-projects');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, 'session.jsonl');
    writeFileSync(archivePath, 'transcript content');

    const parser: ArchiveParser = (_content, context) => [{
      archivePath: context.archivePath,
      lineStart: 1,
      lineEnd: 1,
      sourceKind: context.sourceKind,
      sessionId: 's1',
      project: 'memmem',
      cwd: null,
      gitBranch: null,
      model: null,
      provider: null,
      metadataJson: null,
      observedAt: Date.parse('2026-05-26T00:00:00.000Z'),
      text: 'User prefers durable memory records over exchange indexing.',
    }];

    let completeCalls = 0;
    const provider: LLMProvider = {
      async complete() {
        completeCalls++;
        return {
          text: JSON.stringify([
            {
              kind: 'fact',
              text: 'The user prefers durable memory records over exchange indexing.',
              confidence: 0.9,
            },
          ]),
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    };

    const result = await reindexArchiveFile(db, archivePath, 'claude-code-projects', parser, provider);

    expect(result.memoryRecordsIndexed).toBe(1);
    expect(result.spansEmpty).toBe(0);
    expect(result.spansErrored).toBe(0);
    expect(completeCalls).toBe(1);

    const memoryCount = db.query('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number };
    const vectorCount = db.query('SELECT COUNT(*) AS count FROM vec_memory_records').get() as { count: number };
    const state = db.query('SELECT status FROM extraction_state').get() as { status: string } | null;

    expect(memoryCount.count).toBe(1);
    expect(vectorCount.count).toBe(1);
    expect(state?.status).toBe('done');
  });

  test('skips extraction for unchanged completed spans and keeps existing memory index', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archiveDir = join(dir, 'claude-code-projects');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, 'session.jsonl');
    writeFileSync(archivePath, 'same transcript content');

    const parser: ArchiveParser = (_content, context) => [{
      archivePath: context.archivePath,
      lineStart: 1,
      lineEnd: 1,
      sourceKind: context.sourceKind,
      sessionId: 's1',
      project: 'memmem',
      cwd: null,
      gitBranch: null,
      model: null,
      provider: null,
      metadataJson: null,
      observedAt: Date.parse('2026-05-26T00:00:00.000Z'),
      text: 'User prefers durable memory records over exchange indexing.',
    }];

    let completeCalls = 0;
    const provider: LLMProvider = {
      async complete() {
        completeCalls++;
        return {
          text: JSON.stringify([{ kind: 'fact', text: 'Durable fact.', confidence: 1 }]),
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };

    await reindexArchiveFile(db, archivePath, 'claude-code-projects', parser, provider);
    const result = await reindexArchiveFile(db, archivePath, 'claude-code-projects', parser, provider);

    const memoryCount = db.query('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number };
    const vectorCount = db.query('SELECT COUNT(*) AS count FROM vec_memory_records').get() as { count: number };

    expect(result.spansSkipped).toBe(1);
    expect(result.memoryRecordsIndexed).toBe(0);
    expect(completeCalls).toBe(1);
    expect(memoryCount.count).toBe(1);
    expect(vectorCount.count).toBe(1);
  });

  test('prunes memory index for spans no longer returned by the parser', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archiveDir = join(dir, 'claude-code-projects');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, 'session.jsonl');
    writeFileSync(archivePath, 'changed transcript content');

    const makeSpan = (line: number) => ({
      archivePath,
      lineStart: line,
      lineEnd: line,
      sourceKind: 'claude-code-projects',
      sessionId: 's1',
      project: 'memmem',
      cwd: null,
      gitBranch: null,
      model: null,
      provider: null,
      metadataJson: null,
      observedAt: Date.parse('2026-05-26T00:00:00.000Z'),
      text: `Durable fact ${line}.`,
    });
    const firstParser: ArchiveParser = () => [makeSpan(1), makeSpan(2)];
    const secondParser: ArchiveParser = () => [makeSpan(1)];

    let completeCalls = 0;
    const provider: LLMProvider = {
      async complete() {
        completeCalls++;
        return {
          text: JSON.stringify([{ kind: 'fact', text: `Durable fact ${completeCalls}.`, confidence: 1 }]),
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };

    await reindexArchiveFile(db, archivePath, 'claude-code-projects', firstParser, provider);
    const result = await reindexArchiveFile(db, archivePath, 'claude-code-projects', secondParser, provider);

    const rows = db.query('SELECT line_start AS lineStart FROM memory_records ORDER BY line_start').all() as Array<{ lineStart: number }>;
    const vectorCount = db.query('SELECT COUNT(*) AS count FROM vec_memory_records').get() as { count: number };

    expect(result.spansSkipped).toBe(1);
    expect(result.memoryRecordsIndexed).toBe(0);
    expect(completeCalls).toBe(2);
    expect(rows).toEqual([{ lineStart: 1 }]);
    expect(vectorCount.count).toBe(1);
  });

  test('re-extracts a stale pruned span when it returns later', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archiveDir = join(dir, 'claude-code-projects');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, 'session.jsonl');
    writeFileSync(archivePath, 'changed transcript content');

    const makeSpan = (line: number) => ({
      archivePath,
      lineStart: line,
      lineEnd: line,
      sourceKind: 'claude-code-projects',
      sessionId: 's1',
      project: 'memmem',
      cwd: null,
      gitBranch: null,
      model: null,
      provider: null,
      metadataJson: null,
      observedAt: Date.parse('2026-05-26T00:00:00.000Z'),
      text: `Durable fact ${line}.`,
    });
    const bothSpansParser: ArchiveParser = () => [makeSpan(1), makeSpan(2)];
    const firstSpanParser: ArchiveParser = () => [makeSpan(1)];

    let completeCalls = 0;
    const provider: LLMProvider = {
      async complete() {
        completeCalls++;
        return {
          text: JSON.stringify([{ kind: 'fact', text: `Durable fact ${completeCalls}.`, confidence: 1 }]),
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };

    await reindexArchiveFile(db, archivePath, 'claude-code-projects', bothSpansParser, provider);
    await reindexArchiveFile(db, archivePath, 'claude-code-projects', firstSpanParser, provider);
    const result = await reindexArchiveFile(db, archivePath, 'claude-code-projects', bothSpansParser, provider);

    const rows = db.query('SELECT line_start AS lineStart FROM memory_records ORDER BY line_start').all() as Array<{ lineStart: number }>;

    expect(result.spansSkipped).toBe(1);
    expect(result.memoryRecordsIndexed).toBe(1);
    expect(completeCalls).toBe(3);
    expect(rows).toEqual([{ lineStart: 1 }, { lineStart: 2 }]);
  });

  test('keeps duplicate fact from another archive when one archive reindexes empty', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archiveDir = join(dir, 'claude-code-projects');
    mkdirSync(archiveDir, { recursive: true });
    const archivePathA = join(archiveDir, 'session-a.jsonl');
    const archivePathB = join(archiveDir, 'session-b.jsonl');
    writeFileSync(archivePathA, 'same durable fact');
    writeFileSync(archivePathB, 'same durable fact');

    const parser: ArchiveParser = (content, context) => [{
      archivePath: context.archivePath,
      lineStart: 1,
      lineEnd: 1,
      sourceKind: context.sourceKind,
      sessionId: 's1',
      project: 'memmem',
      cwd: null,
      gitBranch: null,
      model: null,
      provider: null,
      metadataJson: null,
      observedAt: Date.parse('2026-05-26T00:00:00.000Z'),
      text: content,
    }];

    let returnEmpty = false;
    const provider: LLMProvider = {
      async complete() {
        return {
          text: JSON.stringify(returnEmpty ? [] : [{ kind: 'fact', text: 'Shared extracted fact.', dedupe_key: 'shared-fact', confidence: 1 }]),
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };

    await reindexArchiveFile(db, archivePathA, 'claude-code-projects', parser, provider);
    await reindexArchiveFile(db, archivePathB, 'claude-code-projects', parser, provider);
    returnEmpty = true;
    writeFileSync(archivePathB, 'changed to no extracted memory');
    await reindexArchiveFile(db, archivePathB, 'claude-code-projects', parser, provider);

    const rows = db.query('SELECT archive_path AS archivePath, dedupe_key AS dedupeKey FROM memory_records ORDER BY archive_path')
      .all() as Array<{ archivePath: string; dedupeKey: string }>;
    const vectorCount = db.query('SELECT COUNT(*) AS count FROM vec_memory_records').get() as { count: number };

    expect(rows).toEqual([{ archivePath: archivePathA, dedupeKey: 'shared-fact' }]);
    expect(vectorCount.count).toBe(1);
  });

  test('preserves existing span index when embedding fails during replacement', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    let embeddingCalls = 0;
    __setModelForTests(async () => {}, async (_kind, _text) => {
      embeddingCalls++;
      return embeddingCalls === 1 ? Array.from({ length: 384 }, () => 0.1) : null;
    });

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archiveDir = join(dir, 'claude-code-projects');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, 'session.jsonl');
    writeFileSync(archivePath, 'transcript content');

    let spanText = 'Original durable fact.';
    const parser: ArchiveParser = (_content, context) => [{
      archivePath: context.archivePath,
      lineStart: 1,
      lineEnd: 1,
      sourceKind: context.sourceKind,
      sessionId: 's1',
      project: 'memmem',
      cwd: null,
      gitBranch: null,
      model: null,
      provider: null,
      metadataJson: null,
      observedAt: null,
      text: spanText,
    }];
    const provider: LLMProvider = {
      async complete() {
        return {
          text: JSON.stringify([{ kind: 'fact', text: spanText, confidence: 1 }]),
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };

    await reindexArchiveFile(db, archivePath, 'claude-code-projects', parser, provider);
    spanText = 'Updated durable fact.';
    const result = await reindexArchiveFile(db, archivePath, 'claude-code-projects', parser, provider);

    const rows = db.query('SELECT text FROM memory_records').all() as Array<{ text: string }>;
    const vectorCount = db.query('SELECT COUNT(*) AS count FROM vec_memory_records').get() as { count: number };

    expect(result.spansErrored).toBe(1);
    expect(result.memoryRecordsIndexed).toBe(0);
    expect(rows).toEqual([{ text: 'Original durable fact.' }]);
    expect(vectorCount.count).toBe(1);
  });

  test('skips retrying an errored span before retry_after', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archiveDir = join(dir, 'claude-code-projects');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, 'session.jsonl');
    writeFileSync(archivePath, 'transcript content');

    const parser: ArchiveParser = (_content, context) => [{
      archivePath: context.archivePath,
      lineStart: 1,
      lineEnd: 1,
      sourceKind: context.sourceKind,
      sessionId: 's1',
      project: 'memmem',
      cwd: null,
      gitBranch: null,
      model: null,
      provider: null,
      metadataJson: null,
      observedAt: null,
      text: 'Retry later fact.',
    }];
    let completeCalls = 0;
    const provider: LLMProvider = {
      async complete() {
        completeCalls++;
        throw new Error('temporary provider failure');
      },
    };

    const firstResult = await reindexArchiveFile(db, archivePath, 'claude-code-projects', parser, provider);
    const secondResult = await reindexArchiveFile(db, archivePath, 'claude-code-projects', parser, provider);

    expect(firstResult.spansErrored).toBe(1);
    expect(secondResult.spansSkipped).toBe(1);
    expect(secondResult.spansErrored).toBe(0);
    expect(completeCalls).toBe(1);
  });

  test('accumulates attempt_count across repeated extraction failures', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archiveDir = join(dir, 'claude-code-projects');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, 'session.jsonl');
    writeFileSync(archivePath, 'transcript content');

    const parser: ArchiveParser = (_content, context) => [{
      archivePath: context.archivePath,
      lineStart: 1,
      lineEnd: 1,
      sourceKind: context.sourceKind,
      sessionId: 's1',
      project: 'memmem',
      cwd: null,
      gitBranch: null,
      model: null,
      provider: null,
      metadataJson: null,
      observedAt: null,
      text: 'Fact to fail on.',
    }];
    const provider: LLMProvider = {
      async complete() {
        throw new Error('provider always fails');
      },
    };

    const firstResult = await reindexArchiveFile(db, archivePath, 'claude-code-projects', parser, provider);
    expect(firstResult.spansErrored).toBe(1);

    const stateAfterFirst = db.query('SELECT status, attempt_count AS attemptCount FROM extraction_state').get() as { status: string; attemptCount: number } | null;
    expect(stateAfterFirst?.status).toBe('errored');
    expect(stateAfterFirst?.attemptCount).toBe(1);

    // Manually set retry_after to past so the span is eligible for retry
    db.query('UPDATE extraction_state SET retry_after = ? WHERE archive_path = ?').run(Date.now() - 1_000, archivePath);

    const secondResult = await reindexArchiveFile(db, archivePath, 'claude-code-projects', parser, provider);
    expect(secondResult.spansErrored).toBe(1);

    const stateAfterSecond = db.query('SELECT status, attempt_count AS attemptCount FROM extraction_state').get() as { status: string; attemptCount: number } | null;
    expect(stateAfterSecond?.status).toBe('errored');
    expect(stateAfterSecond?.attemptCount).toBe(2);
  });

  test('removes existing memory index when conversation marker asks not to index', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archiveDir = join(dir, 'claude-code-projects');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, 'session.jsonl');
    writeFileSync(archivePath, 'transcript content');

    const parser: ArchiveParser = (_content, context) => [{
      archivePath: context.archivePath,
      lineStart: 1,
      lineEnd: 1,
      sourceKind: context.sourceKind,
      sessionId: null,
      project: null,
      cwd: null,
      gitBranch: null,
      model: null,
      provider: null,
      metadataJson: null,
      observedAt: null,
      text: 'Durable fact.',
    }];
    const provider: LLMProvider = {
      async complete() {
        return {
          text: JSON.stringify([{ kind: 'fact', text: 'Durable fact.', confidence: 1 }]),
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };

    await reindexArchiveFile(db, archivePath, 'claude-code-projects', parser, provider);
    writeFileSync(archivePath, 'DO NOT INDEX THIS CONVERSATION');

    const result = await reindexArchiveFile(db, archivePath, 'claude-code-projects', parser, provider);
    const memoryCount = db.query('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number };
    const vectorCount = db.query('SELECT COUNT(*) AS count FROM vec_memory_records').get() as { count: number };

    expect(result).toEqual({
      spansConsidered: 0,
      spansSkipped: 0,
      spansEmpty: 0,
      spansErrored: 0,
      memoryRecordsIndexed: 0,
      extractionsPerformed: 0,
      spansDeferred: 0,
    });
    expect(memoryCount.count).toBe(0);
    expect(vectorCount.count).toBe(0);
  });

  test('stops extracting once the extraction budget is exhausted, leaving remaining spans for a later sync', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archiveDir = join(dir, 'claude-code-projects');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, 'session.jsonl');
    writeFileSync(archivePath, 'transcript content');

    const makeSpan = (line: number) => ({
      archivePath,
      lineStart: line,
      lineEnd: line,
      sourceKind: 'claude-code-projects',
      sessionId: 's1',
      project: 'memmem',
      cwd: null,
      gitBranch: null,
      model: null,
      provider: null,
      metadataJson: null,
      observedAt: null,
      text: `Durable fact ${line}.`,
    });
    const parser: ArchiveParser = () => [makeSpan(1), makeSpan(2), makeSpan(3)];

    let completeCalls = 0;
    const provider: LLMProvider = {
      async complete() {
        completeCalls++;
        return {
          text: JSON.stringify([{ kind: 'fact', text: `Durable fact ${completeCalls}.`, confidence: 1 }]),
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };

    // Budget of 2 → only first two spans are extracted; the third is left untouched.
    const first = await reindexArchiveFile(db, archivePath, 'claude-code-projects', parser, provider, { extractionBudget: 2 });
    expect(first.extractionsPerformed).toBe(2);
    expect(completeCalls).toBe(2);

    const stateCount = db.query("SELECT COUNT(*) AS count FROM extraction_state WHERE status IN ('done','empty')").get() as { count: number };
    expect(stateCount.count).toBe(2);

    // A later sync with budget picks up exactly the remaining span.
    const second = await reindexArchiveFile(db, archivePath, 'claude-code-projects', parser, provider, { extractionBudget: 10 });
    expect(second.extractionsPerformed).toBe(1);
    expect(second.spansSkipped).toBe(2);
    expect(completeCalls).toBe(3);
  });

  test('a zero budget performs no extraction', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archiveDir = join(dir, 'claude-code-projects');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, 'session.jsonl');
    writeFileSync(archivePath, 'transcript content');

    const parser: ArchiveParser = (_content, context) => [{
      archivePath: context.archivePath,
      lineStart: 1,
      lineEnd: 1,
      sourceKind: context.sourceKind,
      sessionId: 's1',
      project: 'memmem',
      cwd: null,
      gitBranch: null,
      model: null,
      provider: null,
      metadataJson: null,
      observedAt: null,
      text: 'Durable fact.',
    }];
    let completeCalls = 0;
    const provider: LLMProvider = {
      async complete() {
        completeCalls++;
        return { text: JSON.stringify([{ kind: 'fact', text: 'f', confidence: 1 }]), usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };

    const result = await reindexArchiveFile(db, archivePath, 'claude-code-projects', parser, provider, { extractionBudget: 0 });
    expect(result.extractionsPerformed).toBe(0);
    expect(completeCalls).toBe(0);
  });
});
