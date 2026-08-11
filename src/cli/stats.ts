import { openMemoryDb } from '../core/memory/schema.js';
import { getMemoryStats } from '../core/stats.js';

export function runStatsCli(): void {
  const db = openMemoryDb();
  try {
    const stats = getMemoryStats(db);
    console.log(`Total memories: ${stats.totalMemories}`);
    console.log(`Vectorized: ${stats.vectorizedMemories}`);
    console.log(`Missing vectors: ${stats.missingVectors}`);
  } finally {
    db.close();
  }
}
