import { openMemoryDb } from '../core/memory/schema.js';
import { verifyMemoryIndex } from '../core/verify.js';

export function runVerifyCli(): void {
  const db = openMemoryDb();
  try {
    const result = verifyMemoryIndex(db);
    const issueCount = result.missingVectors.length + result.orphanVectors.length;

    console.log(`Total memories: ${result.totalMemories}`);

    if (issueCount === 0) {
      console.log('No memory index issues found.');
      return;
    }

    console.log(`Memory index issues: ${issueCount}`);
    console.log(`Missing vectors: ${result.missingVectors.length}`);
    console.log(`Orphan vectors: ${result.orphanVectors.length}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
