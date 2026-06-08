import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { verifyMemoryIndex } from './verify.js';
import { getMemoryStats } from './stats.js';

export type DiagnosticStatus = 'ok' | 'warn' | 'fail';

export interface DiagnosticResult {
  name: string;
  status: DiagnosticStatus;
  detail: string;
  suggestion?: string;
}

export interface DiagnosticPaths {
  distDir: string;
  srcDir: string;
}

const REQUIRED_DIST_ARTIFACTS = ['cli-internal.mjs', 'mcp-server.mjs'];

/** Newest mtime (ms epoch) across files with `ext` under `dir`, recursive. 0 if none. */
export function newestMtime(dir: string, ext: string): number {
  let newest = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full, ext));
    } else if (entry.name.endsWith(ext)) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

function checkBuild(paths: DiagnosticPaths): DiagnosticResult {
  const missing = REQUIRED_DIST_ARTIFACTS.filter(
    (name) => !existsSync(join(paths.distDir, name)),
  );
  if (missing.length > 0) {
    return {
      name: 'build',
      status: 'fail',
      detail: `Missing build artifact(s): ${missing.join(', ')}.`,
      suggestion: 'bun run build',
    };
  }

  const srcMtime = newestMtime(paths.srcDir, '.ts');
  const distMtime = Math.min(
    ...REQUIRED_DIST_ARTIFACTS.map((name) => statSync(join(paths.distDir, name)).mtimeMs),
  );
  if (srcMtime > distMtime) {
    return {
      name: 'build',
      status: 'fail',
      detail: 'Source changed after the last build (dist is stale).',
      suggestion: 'bun run build',
    };
  }

  return { name: 'build', status: 'ok', detail: 'Build artifacts are up to date.' };
}

function checkIndex(db: Database): DiagnosticResult {
  const v = verifyMemoryIndex(db);
  const hard =
    v.missingArchives.length +
    v.invalidProvenance.length +
    v.missingVectors.length +
    v.orphanVectors.length;

  if (hard > 0) {
    return {
      name: 'index',
      status: 'fail',
      detail:
        `Integrity issues: ${v.missingArchives.length} missing archives, ` +
        `${v.invalidProvenance.length} invalid provenance, ` +
        `${v.missingVectors.length} missing vectors, ` +
        `${v.orphanVectors.length} orphan vectors.`,
      suggestion: 'memmem sync',
    };
  }

  if (v.retryableExtractionErrors.length > 0) {
    return {
      name: 'index',
      status: 'warn',
      detail: `${v.retryableExtractionErrors.length} retryable extraction error(s).`,
      suggestion: 'memmem sync',
    };
  }

  return { name: 'index', status: 'ok', detail: 'Memory index integrity verified.' };
}

function checkData(db: Database): DiagnosticResult {
  const s = getMemoryStats(db);
  if (s.activeMemoryRecords === 0) {
    return {
      name: 'data',
      status: 'warn',
      detail: 'No active memory records — nothing has been indexed yet.',
      suggestion: 'memmem sync',
    };
  }
  if (s.missingVectors > 0) {
    return {
      name: 'data',
      status: 'warn',
      detail: `${s.missingVectors} active record(s) are not vectorized.`,
      suggestion: 'memmem sync',
    };
  }
  return {
    name: 'data',
    status: 'ok',
    detail: `${s.activeMemoryRecords} active records, all vectorized.`,
  };
}

export function runDiagnostics(db: Database, paths: DiagnosticPaths): DiagnosticResult[] {
  return [checkBuild(paths), checkIndex(db), checkData(db)];
}
