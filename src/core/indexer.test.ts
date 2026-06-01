import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase } from './db.js';
import { resetRateLimiters } from './ratelimiter.js';
import { __setModelForTests } from './embeddings.js';
import { reindexArchiveFile, type ArchiveParser } from './indexer.js';
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

describe('reindexArchiveFile', () => {
  test('extracts memory records from transcript spans and indexes vectors', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, (_, i) => i / 384));

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archiveDir = join(dir, 'claude-projects');
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

    const result = await reindexArchiveFile(db, archivePath, 'claude-projects', parser, provider);

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
    const archiveDir = join(dir, 'claude-projects');
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

    await reindexArchiveFile(db, archivePath, 'claude-projects', parser, provider);
    const result = await reindexArchiveFile(db, archivePath, 'claude-projects', parser, provider);

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
    const archiveDir = join(dir, 'claude-projects');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, 'session.jsonl');
    writeFileSync(archivePath, 'changed transcript content');

    const makeSpan = (line: number) => ({
      archivePath,
      lineStart: line,
      lineEnd: line,
      sourceKind: 'claude-projects',
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

    await reindexArchiveFile(db, archivePath, 'claude-projects', firstParser, provider);
    const result = await reindexArchiveFile(db, archivePath, 'claude-projects', secondParser, provider);

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
    const archiveDir = join(dir, 'claude-projects');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, 'session.jsonl');
    writeFileSync(archivePath, 'changed transcript content');

    const makeSpan = (line: number) => ({
      archivePath,
      lineStart: line,
      lineEnd: line,
      sourceKind: 'claude-projects',
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

    await reindexArchiveFile(db, archivePath, 'claude-projects', bothSpansParser, provider);
    await reindexArchiveFile(db, archivePath, 'claude-projects', firstSpanParser, provider);
    const result = await reindexArchiveFile(db, archivePath, 'claude-projects', bothSpansParser, provider);

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
    const archiveDir = join(dir, 'claude-projects');
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

    await reindexArchiveFile(db, archivePathA, 'claude-projects', parser, provider);
    await reindexArchiveFile(db, archivePathB, 'claude-projects', parser, provider);
    returnEmpty = true;
    writeFileSync(archivePathB, 'changed to no extracted memory');
    await reindexArchiveFile(db, archivePathB, 'claude-projects', parser, provider);

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
    const archiveDir = join(dir, 'claude-projects');
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

    await reindexArchiveFile(db, archivePath, 'claude-projects', parser, provider);
    spanText = 'Updated durable fact.';
    const result = await reindexArchiveFile(db, archivePath, 'claude-projects', parser, provider);

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
    const archiveDir = join(dir, 'claude-projects');
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

    const firstResult = await reindexArchiveFile(db, archivePath, 'claude-projects', parser, provider);
    const secondResult = await reindexArchiveFile(db, archivePath, 'claude-projects', parser, provider);

    expect(firstResult.spansErrored).toBe(1);
    expect(secondResult.spansSkipped).toBe(1);
    expect(secondResult.spansErrored).toBe(0);
    expect(completeCalls).toBe(1);
  });

  test('removes existing memory index when conversation marker asks not to index', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async (_kind, _text) => Array.from({ length: 384 }, () => 0.1));

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archiveDir = join(dir, 'claude-projects');
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

    await reindexArchiveFile(db, archivePath, 'claude-projects', parser, provider);
    writeFileSync(archivePath, 'DO NOT INDEX THIS CONVERSATION');

    const result = await reindexArchiveFile(db, archivePath, 'claude-projects', parser, provider);
    const memoryCount = db.query('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number };
    const vectorCount = db.query('SELECT COUNT(*) AS count FROM vec_memory_records').get() as { count: number };

    expect(result).toEqual({
      spansConsidered: 0,
      spansSkipped: 0,
      spansEmpty: 0,
      spansErrored: 0,
      memoryRecordsIndexed: 0,
    });
    expect(memoryCount.count).toBe(0);
    expect(vectorCount.count).toBe(0);
  });
});
