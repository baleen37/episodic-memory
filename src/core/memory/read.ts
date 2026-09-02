import type { Database } from 'bun:sqlite';

export interface MemoryRecord {
  id: string;
  memory: string;
  hash: string;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

interface MemoryRow {
  id: string;
  memory: string;
  hash: string;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function readMemories(
  db: Database,
  ids: string[],
): { results: MemoryRecord[]; missing: string[] } {
  if (ids.length === 0) return { results: [], missing: [] };

  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.query(`
    SELECT id, memory, hash, metadata, created_at, updated_at
    FROM memories
    WHERE id IN (${placeholders})
  `).all(...ids) as MemoryRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const results: MemoryRecord[] = [];
  const missing: string[] = [];

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      missing.push(id);
      continue;
    }
    results.push({
      id: row.id,
      memory: row.memory,
      hash: row.hash,
      metadata: parseMetadata(row.metadata),
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }

  return { results, missing };
}
