import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getHelpText, parseSearchArgs, parseReadArgs } from './main.js';
import { runSearchCli } from './search.js';
import { CURRENT_EMBEDDING_VERSION, CURRENT_EXTRACTION_VERSION, initDatabase, insertMemoryRecord } from '../core/db.js';

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

  test('parses read args', () => {
    expect(parseReadArgs(['read', '/archive/session.jsonl', '--start-line', '3', '--end-line', '8'])).toEqual({
      path: '/archive/session.jsonl',
      startLine: 3,
      endLine: 8,
    });
  });

  test('rejects missing read path', () => {
    expect(() => parseReadArgs(['read'])).toThrow('read requires a path');
  });

  test('rejects flag as read path', () => {
    expect(() => parseReadArgs(['read', '--start-line', '3'])).toThrow('read requires a path');
  });

  test('rejects invalid numeric read option', () => {
    expect(() => parseReadArgs(['read', '/archive/session.jsonl', '--start-line', '0'])).toThrow('--start-line must be a positive integer');
  });

  test('rejects start line after end line', () => {
    expect(() => parseReadArgs(['read', '/archive/session.jsonl', '--start-line', '9', '--end-line', '8'])).toThrow('--start-line must be less than or equal to --end-line');
  });

  test('help text mentions only transcript commands', () => {
    const help = getHelpText();
    expect(help).toContain('sync');
    expect(help).toContain('search');
    expect(help).toContain('read');
    expect(help).toContain('memmem - Event/fact memory for Claude Code and Codex transcripts');
    expect(help).toContain('sync      Copy transcripts and extract memory records');
    expect(help).toContain('search    Search indexed memory records');
    expect(help).toContain('read      Read archived transcript lines');
    expect(help).not.toContain('recall');
  });
});


describe('CLI search output', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    delete process.env.TEST_DB_PATH;
    delete process.env.MEMMEM_DISABLE_EMBEDDINGS;
  });

  test('prints memory record fields without snippets', async () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-cli-search-'));
    process.env.TEST_DB_PATH = join(dir, 'test.db');
    process.env.MEMMEM_DISABLE_EMBEDDINGS = 'true';

    const db = initDatabase();
    insertMemoryRecord(db, {
      kind: 'fact',
      text: 'The archive is the source of truth.',
      sourceKind: 'claude-projects',
      archivePath: '/archive/a.jsonl',
      lineStart: 4,
      lineEnd: 8,
      observedAt: Date.UTC(2026, 5, 1),
      project: 'memmem',
      dedupeKey: 'cli-search-memory',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      embeddingVersion: CURRENT_EMBEDDING_VERSION,
    });
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
    expect(output).toContain('## [fact, claude-projects, 2026-06-01] memmem');
    expect(output).toContain('The archive is the source of truth.');
    expect(output).toContain('Source: /archive/a.jsonl:4-8');
    expect(output).not.toContain('snippet');
    expect(output).not.toContain('Path:');
  });
});
