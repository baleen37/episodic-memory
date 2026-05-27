import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase } from './db.js';
import { __setModelForTests } from './embeddings.js';
import { reindexArchiveFile } from './indexer.js';
import { parseClaudeJsonl } from './sources/claude.js';

let dir: string | null = null;
let db: ReturnType<typeof initDatabase> | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  __setModelForTests(null, null);
});

describe('reindexArchiveFile', () => {
  test('reindexes a file from scratch and replaces old rows', async () => {
    process.env.TEST_DB_PATH = ':memory:';
    db = initDatabase();
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, (_, i) => i / 384));

    dir = mkdtempSync(join(tmpdir(), 'memmem-indexer-'));
    const archiveDir = join(dir, 'claude-projects');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, 'session.jsonl');
    writeFileSync(archivePath, [
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:00.000Z', sessionId: 's1', message: { role: 'user', content: 'First question' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:01.000Z', sessionId: 's1', message: { role: 'assistant', content: 'First answer' } }),
    ].join('\n'));

    await reindexArchiveFile(db, archivePath, 'claude-projects', parseClaudeJsonl);
    await reindexArchiveFile(db, archivePath, 'claude-projects', parseClaudeJsonl);

    const count = db.query('SELECT COUNT(*) AS count FROM exchanges').get() as { count: number };
    const vectorCount = db.query('SELECT COUNT(*) AS count FROM vec_exchanges').get() as { count: number };

    expect(count.count).toBe(1);
    expect(vectorCount.count).toBe(1);
  });
});
