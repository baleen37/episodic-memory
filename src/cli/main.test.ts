import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getHelpText, parseSearchArgs } from './main.js';
import { runSearchCli } from './search.js';
import { createMemorySchema } from '../core/memory/schema.js';
import { getDbPath } from '../core/paths.js';
import { __setModelForTests } from '../core/embeddings.js';

describe('CLI argument parsing', () => {
  test('parses search args', () => {
    expect(parseSearchArgs(['search', 'semantic memory', '--after', '2026-05-01', '--source-kind', 'codex-sessions', '--limit', '5'])).toEqual({
      query: 'semantic memory',
      after: '2026-05-01',
      before: undefined,
      sourceKind: 'codex-sessions',
      limit: 5,
    });
  });

  test('parses multi-token search query', () => {
    expect(parseSearchArgs(['search', 'semantic', 'memory', '--limit', '5'])).toEqual({
      query: 'semantic memory',
      after: undefined,
      before: undefined,
      sourceKind: undefined,
      limit: 5,
    });
  });

  test('rejects invalid numeric search option', () => {
    expect(() => parseSearchArgs(['search', 'semantic memory', '--limit', '0'])).toThrow('--limit must be a positive integer');
  });

  test('rejects missing search option value', () => {
    expect(() => parseSearchArgs(['search', 'semantic memory', '--after'])).toThrow('--after requires a value');
  });

  test('rejects empty search query', () => {
    expect(() => parseSearchArgs(['search', '--limit', '5'])).toThrow('search requires a query');
  });

  test('help text mentions commands, options, and examples', () => {
    const help = getHelpText();
    expect(help).toContain('sync');
    expect(help).toContain('search');
    expect(help).toContain('stats');
    expect(help).toContain('verify');
    expect(help).toContain('episodic-memory - Event/fact memory for Claude Code and Codex transcripts');
    expect(help).toContain('sync      Copy transcripts and extract memory records');
    expect(help).toContain('search    Search indexed memory records');
    expect(help).toContain('stats     Print memory index statistics');
    expect(help).toContain('verify    Verify memory index integrity');
    expect(help).toContain('--limit <number>');
    expect(help).toContain('--source-kind <kind>');
    expect(help).toContain('episodic-memory search "source of truth" --limit 5');
    expect(help).not.toContain('recall');
  });

  test('help text flags --after/--before as unsupported rather than silently accepted', () => {
    const help = getHelpText();
    expect(help).toContain('--after <YYYY-MM-DD>    Not yet supported; errors (mem0 v2 surface)');
    expect(help).toContain('--before <YYYY-MM-DD>   Not yet supported; errors (mem0 v2 surface)');
  });
});

describe('CLI search behavior', () => {
  let dir: string | null = null;

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    delete process.env.EPISODIC_MEMORY_DISABLE_EMBEDDINGS;
    __setModelForTests(null, null);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test('--after throws a clear "not yet supported" error rather than silently ignoring the filter', async () => {
    await expect(runSearchCli({ query: 'anything', after: '2026-05-01' }))
      .rejects.toThrow('--after/--before are not yet supported in the mem0 v2 surface');
  });

  test('--before throws a clear "not yet supported" error rather than silently ignoring the filter', async () => {
    await expect(runSearchCli({ query: 'anything', before: '2026-05-01' }))
      .rejects.toThrow('--after/--before are not yet supported in the mem0 v2 surface');
  });

  test('prints matched memory text and score', async () => {
    dir = mkdtempSync(join(tmpdir(), 'episodic-memory-cli-search-'));
    process.env.TEST_DB_PATH = join(dir, 'test.db');
    __setModelForTests(async () => {}, async () => Array.from({ length: 384 }, () => 0.1));

    const db = new Database(getDbPath());
    sqliteVec.load(db);
    createMemorySchema(db);
    db.query(
      'INSERT INTO memories (id, memory, hash, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run('mem-1', 'The archive is the source of truth.', 'hash-1', JSON.stringify({ user_id: 'local' }), Date.now(), Date.now());
    db.query('INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)').run(
      1, Buffer.from(new Float32Array(Array.from({ length: 384 }, () => 0.1)).buffer),
    );
    db.close();

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => { lines.push(String(value ?? '')); };
    try {
      await runSearchCli({ query: 'source of truth', limit: 10 });
    } finally {
      console.log = originalLog;
    }

    const output = lines.join('\n');
    expect(output).toContain('## The archive is the source of truth.');
    expect(output).toMatch(/Score: \d+%/);
  });
});
