import { openDatabase } from '../core/db.js';
import { verifyMemoryIndex } from '../core/verify.js';

export function runVerifyCli(): void {
  const db = openDatabase();
  try {
    const result = verifyMemoryIndex(db);
    const issueCount = result.missingArchives.length
      + result.invalidProvenance.length
      + result.missingVectors.length
      + result.orphanVectors.length
      + result.retryableExtractionErrors.length;

    if (issueCount === 0) {
      console.log('No memory index issues found.');
      return;
    }

    console.log(`Memory index issues: ${issueCount}`);
    console.log(`Missing archives: ${result.missingArchives.length}`);
    console.log(`Invalid provenance: ${result.invalidProvenance.length}`);
    console.log(`Missing vectors: ${result.missingVectors.length}`);
    console.log(`Orphan vectors: ${result.orphanVectors.length}`);
    console.log(`Retryable extraction errors: ${result.retryableExtractionErrors.length}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
