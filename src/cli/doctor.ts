import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from '../core/db.js';
import { runDiagnostics, type DiagnosticStatus } from '../core/doctor.js';

const STATUS_ICON: Record<DiagnosticStatus, string> = {
  ok: '✓',
  warn: '⚠',
  fail: '✗',
};

/** Resolve the package root from this module's location (src/cli or dist). */
function resolveRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/cli/doctor.ts -> ../..  ;  dist/cli-internal.mjs -> ..
  return here.endsWith('cli') ? join(here, '..', '..') : join(here, '..');
}

export function runDoctorCli(): void {
  const db = openDatabase();
  try {
    const root = resolveRoot();
    const results = runDiagnostics(db, {
      distDir: join(root, 'dist'),
      srcDir: join(root, 'src'),
    });

    let hasFail = false;
    for (const r of results) {
      console.log(`${STATUS_ICON[r.status]} ${r.name}: ${r.detail}`);
      if (r.suggestion) {
        console.log(`    → run: ${r.suggestion}`);
      }
      if (r.status === 'fail') hasFail = true;
    }

    if (hasFail) {
      process.exitCode = 1;
    } else {
      console.log('\nmemmem is healthy.');
    }
  } finally {
    db.close();
  }
}
