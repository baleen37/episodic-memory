import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMemorySchema } from './memory/schema.js';
import { runDiagnostics, newestMtime } from './doctor.js';

let db: Database | null = null;
let dir: string | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function newMemoryDb(): Database {
  const database = new Database(':memory:');
  sqliteVec.load(database);
  createMemorySchema(database);
  return database;
}

function insertMemory(database: Database, id: string, memory: string): void {
  database.query(
    'INSERT INTO memories (id, memory, hash, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run(id, memory, `hash-${id}`, '{}', Date.now(), Date.now());
}

function insertVector(database: Database, rowid: number): void {
  database.query('INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)').run(
    rowid, Buffer.from(new Float32Array(Array.from({ length: 384 }, () => 0.01)).buffer),
  );
}

function setMtime(path: string, epochSeconds: number): void {
  utimesSync(path, epochSeconds, epochSeconds);
}

describe('newestMtime', () => {
  test('returns the max mtime across .ts files, ignoring other extensions', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-doctor-mtime-'));
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    const other = join(dir, 'note.md');
    writeFileSync(a, '');
    writeFileSync(b, '');
    writeFileSync(other, '');
    setMtime(a, 1000);
    setMtime(b, 2000);
    setMtime(other, 9000);

    expect(newestMtime(dir, '.ts')).toBe(2000_000);
  });

  test('recurses into subdirectories', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-doctor-mtime-'));
    writeFileSync(join(dir, 'top.ts'), '');
    setMtime(join(dir, 'top.ts'), 1000);
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'deep.ts'), '');
    setMtime(join(nested, 'deep.ts'), 3000);

    expect(newestMtime(dir, '.ts')).toBe(3000_000);
  });
});

describe('runDiagnostics', () => {
  function freshBuildDirs(): { distDir: string; srcDir: string } {
    const distDir = join(dir!, 'dist');
    const srcDir = join(dir!, 'src');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'main.ts'), '');
    setMtime(join(srcDir, 'main.ts'), 1000);
    writeFileSync(join(distDir, 'cli-internal.mjs'), '');
    writeFileSync(join(distDir, 'mcp-server.mjs'), '');
    setMtime(join(distDir, 'cli-internal.mjs'), 2000);
    setMtime(join(distDir, 'mcp-server.mjs'), 2000);
    return { distDir, srcDir };
  }

  test('all ok when build fresh and index clean with data', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-doctor-'));
    db = newMemoryDb();
    insertMemory(db, 'mem-1', 'A clean record.');
    const rowid = (db.query('SELECT rowid AS r FROM memories WHERE id = ?').get('mem-1') as { r: number }).r;
    insertVector(db, rowid);

    const results = runDiagnostics(db, freshBuildDirs());
    const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));

    expect(byName['build']).toBe('ok');
    expect(byName['index']).toBe('ok');
    expect(byName['data']).toBe('ok');
  });

  test('build fail when a dist artifact is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-doctor-'));
    db = newMemoryDb();
    const distDir = join(dir, 'dist');
    const srcDir = join(dir, 'src');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'main.ts'), '');
    writeFileSync(join(distDir, 'cli-internal.mjs'), '');

    const results = runDiagnostics(db, { distDir, srcDir });
    const build = results.find((r) => r.name === 'build')!;
    expect(build.status).toBe('fail');
    expect(build.suggestion).toBe('bun run build');
  });

  test('build fail when src newer than dist', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-doctor-'));
    db = newMemoryDb();
    const distDir = join(dir, 'dist');
    const srcDir = join(dir, 'src');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(distDir, 'cli-internal.mjs'), '');
    writeFileSync(join(distDir, 'mcp-server.mjs'), '');
    setMtime(join(distDir, 'cli-internal.mjs'), 1000);
    setMtime(join(distDir, 'mcp-server.mjs'), 1000);
    writeFileSync(join(srcDir, 'main.ts'), '');
    setMtime(join(srcDir, 'main.ts'), 5000);

    const results = runDiagnostics(db, { distDir, srcDir });
    expect(results.find((r) => r.name === 'build')!.status).toBe('fail');
  });

  test('data warn when no records', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-doctor-'));
    db = newMemoryDb();

    const results = runDiagnostics(db, freshBuildDirs());
    const data = results.find((r) => r.name === 'data')!;
    expect(data.status).toBe('warn');
    expect(data.suggestion).toBe('memmem sync');
  });

  test('index fail when a memory is missing its vector', () => {
    dir = mkdtempSync(join(tmpdir(), 'memmem-doctor-'));
    db = newMemoryDb();
    insertMemory(db, 'mem-1', 'Record without a vector.');

    const results = runDiagnostics(db, freshBuildDirs());
    expect(results.find((r) => r.name === 'index')!.status).toBe('fail');
    expect(results.find((r) => r.name === 'data')!.status).toBe('warn');
  });
});
