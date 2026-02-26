/**
 * sync - Reindex missing embeddings into vec_observations.
 *
 * Finds observations without a corresponding vec_observations entry
 * and generates embeddings for them.
 */

import { Database } from 'bun:sqlite';
import { openDatabase } from '../core/db.js';
import { generateEmbedding, initEmbeddings } from '../core/embeddings.js';

export interface SyncResult {
  total: number;
  synced: number;
  failed: number;
}

export async function syncEmbeddings(db: Database): Promise<SyncResult> {
  await initEmbeddings();

  const missing = db.query(`
    SELECT o.id, o.title, o.content
    FROM observations o
    LEFT JOIN vec_observations v ON v.id = CAST(o.id AS TEXT)
    WHERE v.id IS NULL
  `).all() as Array<{ id: number; title: string; content: string }>;

  const total = (db.query('SELECT COUNT(*) as cnt FROM observations').get() as { cnt: number }).cnt;
  let synced = 0;
  let failed = 0;

  for (const obs of missing) {
    const embedding = await generateEmbedding(`${obs.title}\n${obs.content}`);
    if (!embedding) {
      failed++;
      continue;
    }
    db.query('INSERT INTO vec_observations (id, embedding) VALUES (?, ?)').run(
      String(obs.id),
      Buffer.from(new Float32Array(embedding).buffer),
    );
    synced++;
  }

  return { total, synced, failed };
}

export async function runSyncCli(): Promise<void> {
  const db = openDatabase();
  try {
    console.log('Syncing embeddings...');
    const result = await syncEmbeddings(db);
    console.log(`Done. total=${result.total} synced=${result.synced} failed=${result.failed}`);
  } finally {
    db.close();
  }
}
