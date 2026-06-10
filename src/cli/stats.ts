import { openDatabase } from '../core/db.js';
import { getMemoryStats } from '../core/stats.js';

export function runStatsCli(): void {
  const db = openDatabase();
  try {
    const stats = getMemoryStats(db);
    console.log(`Memory records: ${stats.totalMemoryRecords}`);
    console.log(`Active: ${stats.activeMemoryRecords}`);
    console.log(`Superseded: ${stats.supersededMemoryRecords}`);
    console.log(`Facts: ${stats.factCount}`);
    console.log(`Events: ${stats.eventCount}`);
    console.log(`Missing vectors: ${stats.missingVectors}`);
    console.log(`Extraction errors: ${stats.extractionErroredSpans}`);
  } finally {
    db.close();
  }
}
