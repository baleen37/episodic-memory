// src/core/memory/add.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { createMemorySchema } from './schema.js';
import { addMemories } from './add.js';
import { LLMError } from './extract.js';
import { md5 } from './store.js';
import { EmbeddingError, __setModelForTests, __setBatchModelForTests } from '../embeddings.js';
import { resetRateLimiters, __setLoadConfigForTests } from '../ratelimiter.js';
import type { LLMProvider } from '../llm/types.js';

const EMB = () => { const v = new Array(384).fill(0); v[0] = 1; return v; };

let db: Database;
let prompts: string[];

beforeEach(() => {
  db = new Database(':memory:');
  sqliteVec.load(db);
  createMemorySchema(db);
  prompts = [];
  __setModelForTests(async () => {}, async () => EMB());
  __setBatchModelForTests(async (_kind, texts) => texts.map(() => EMB()));
  __setLoadConfigForTests(() => ({
    ratelimit: { embedding: { requestsPerSecond: 100, burstSize: 100 } },
  }) as any);
  resetRateLimiters();
});
afterEach(() => {
  __setModelForTests(null, null);
  __setBatchModelForTests(null);
  __setLoadConfigForTests(null);
  resetRateLimiters();
});

function provider(text: string): LLMProvider {
  return {
    complete: async (prompt: string) => { prompts.push(prompt); return { text }; },
  } as unknown as LLMProvider;
}

const twoMemories = JSON.stringify({
  memory: [
    { id: '0', text: 'User adopted a beagle puppy named Max', attributed_to: 'user' },
    { id: '1', text: 'User started pottery classes on Tuesdays', attributed_to: 'user' },
  ],
});

const threeMemories = JSON.stringify({
  memory: [
    { id: '0', text: 'User adopted a beagle puppy named Max', attributed_to: 'user' },
    { id: '1', text: 'User started pottery classes on Tuesdays', attributed_to: 'user' },
    { id: '2', text: 'User prefers oat milk in coffee', attributed_to: 'user' },
  ],
});

const base = {
  messages: [{ role: 'user' as const, content: 'I adopted a puppy and started pottery' }],
  filters: { user_id: 'alice' },
};

describe('addMemories', () => {
  test('rejects when embedding fails, so sync can retry the span', async () => {
    __setBatchModelForTests(async () => { throw new Error('model down'); });
    await expect(addMemories({ db, provider: provider(twoMemories), ...base }))
      .rejects.toThrow(EmbeddingError);
  });

  test('embeds all extracted facts in one batch call', async () => {
    let calls = 0;
    __setBatchModelForTests(async (_kind, texts) => {
      calls++;
      return texts.map(() => EMB());
    });
    const out = await addMemories({ db, provider: provider(threeMemories), ...base });
    expect(out.results).toHaveLength(3);
    expect(calls).toBe(1);
  });

  test('persists every extracted memory as an ADD', async () => {
    const out = await addMemories({ db, provider: provider(twoMemories), ...base });
    expect(out.results).toHaveLength(2);
    expect(out.results.every(r => r.event === 'ADD')).toBe(true);
    expect((db.query('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(2);
  });

  test('makes exactly one LLM call per batch', async () => {
    await addMemories({ db, provider: provider(twoMemories), ...base });
    expect(prompts).toHaveLength(1);
  });

  test('assigns UUID ids, not sequential integers', async () => {
    const out = await addMemories({ db, provider: provider(twoMemories), ...base });
    for (const r of out.results) {
      expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  test('stores filters into metadata for later scoping', async () => {
    await addMemories({ db, provider: provider(twoMemories), ...base });
    const row = db.query('SELECT metadata FROM memories LIMIT 1').get() as { metadata: string };
    expect(JSON.parse(row.metadata).user_id).toBe('alice');
  });

  test('skips a repeat ingest of identical text via md5', async () => {
    await addMemories({ db, provider: provider(twoMemories), ...base });
    const out = await addMemories({ db, provider: provider(twoMemories), ...base });
    expect(out.results).toHaveLength(0);
    expect((db.query('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(2);
  });

  test('never emits UPDATE or DELETE even when contradicted', async () => {
    await addMemories({ db, provider: provider(JSON.stringify({
      memory: [{ id: '0', text: 'User lives in Seoul', attributed_to: 'user' }] })), ...base });
    await addMemories({ db, provider: provider(JSON.stringify({
      memory: [{ id: '0', text: 'User lives in Busan', attributed_to: 'user' }] })), ...base });

    const events = (db.query('SELECT DISTINCT event FROM history').all() as Array<{ event: string }>)
      .map(r => r.event);
    expect(events).toEqual(['ADD']);
    // Contradictions accumulate as siblings — mem0 v2's documented tradeoff.
    expect((db.query('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(2);
  });

  test('writes one history row per inserted memory', async () => {
    await addMemories({ db, provider: provider(twoMemories), ...base });
    expect((db.query('SELECT COUNT(*) c FROM history').get() as { c: number }).c).toBe(2);
  });

  test('passes existing memories into the prompt for dedup context', async () => {
    await addMemories({ db, provider: provider(JSON.stringify({
      memory: [{ id: '0', text: 'User has a dog named Max', attributed_to: 'user' }] })), ...base });
    prompts = [];
    await addMemories({ db, provider: provider('{"memory": []}'), ...base });
    expect(prompts[0]).toContain('## Existing Memories');
    expect(prompts[0]).toContain('User has a dog named Max');
  });

  test('remaps existing-memory UUIDs to integer strings in the prompt', async () => {
    await addMemories({ db, provider: provider(JSON.stringify({
      memory: [{ id: '0', text: 'User has a dog named Max', attributed_to: 'user' }] })), ...base });
    const stored = (db.query('SELECT id FROM memories LIMIT 1').get() as { id: string }).id;
    prompts = [];
    await addMemories({ db, provider: provider('{"memory": []}'), ...base });
    expect(prompts[0]).not.toContain(stored);
    expect(prompts[0]).toContain('"id": "0"');
  });

  test('propagates LLMError instead of silently storing nothing', async () => {
    const failing = { complete: async () => { throw new Error('503'); } } as unknown as LLMProvider;
    await expect(addMemories({ db, provider: failing, ...base })).rejects.toThrow(LLMError);
  });

  test('an empty extraction stores nothing and does not throw', async () => {
    const out = await addMemories({ db, provider: provider('{"memory": []}'), ...base });
    expect(out.results).toEqual([]);
    expect((db.query('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(0);
  });

  test('hashes stored match md5 of the memory text', async () => {
    await addMemories({ db, provider: provider(twoMemories), ...base });
    const rows = db.query('SELECT memory, hash FROM memories').all() as Array<{ memory: string; hash: string }>;
    for (const r of rows) expect(r.hash).toBe(md5(r.memory));
  });

  test('links extracted entities to their stored memories (Phase 7)', async () => {
    const out = await addMemories({ db, provider: provider(JSON.stringify({
      memory: [{
        id: '0', text: 'User has a dog named Poppy', attributed_to: 'user',
        entities: [{ type: 'PROPER', text: 'Poppy' }],
      }] })), ...base });

    const row = db.query('SELECT data, entity_type, linked_memory_ids, metadata FROM entities').get() as
      { data: string; entity_type: string; linked_memory_ids: string; metadata: string } | null;
    expect(row).not.toBeNull();
    expect(row!.data).toBe('Poppy');
    expect(row!.entity_type).toBe('PROPER');
    expect(JSON.parse(row!.linked_memory_ids)).toEqual([out.results[0].id]);
    expect(JSON.parse(row!.metadata)).toEqual({ user_id: 'alice' });
  });

  test('deduplicates the same entity across memories in one batch', async () => {
    const out = await addMemories({ db, provider: provider(JSON.stringify({
      memory: [
        { id: '0', text: 'Poppy had a vet checkup', attributed_to: 'user',
          entities: [{ type: 'PROPER', text: 'Poppy' }] },
        { id: '1', text: 'Poppy needs to lose weight', attributed_to: 'user',
          entities: [{ type: 'PROPER', text: 'poppy' }] },
      ] })), ...base });

    const rows = db.query('SELECT linked_memory_ids FROM entities').all() as Array<{ linked_memory_ids: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].linked_memory_ids).sort()).toEqual(out.results.map(r => r.id).sort());
  });

  test('does not link entities of memories dropped by md5 dedup', async () => {
    const withEntities = JSON.stringify({
      memory: [{ id: '0', text: 'User works at Shopify', attributed_to: 'user',
                 entities: [{ type: 'PROPER', text: 'Shopify' }] }] });
    const first = await addMemories({ db, provider: provider(withEntities), ...base });
    await addMemories({ db, provider: provider(withEntities), ...base });

    const rows = db.query('SELECT linked_memory_ids FROM entities').all() as Array<{ linked_memory_ids: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].linked_memory_ids)).toEqual([first.results[0].id]);
  });

  test('entity linking failure is non-fatal: memories are still stored', async () => {
    let batchCalls = 0;
    __setBatchModelForTests(async (_kind, texts) => {
      batchCalls++;
      if (batchCalls > 1) throw new Error('entity embed down');
      return texts.map(() => EMB());
    });
    const out = await addMemories({ db, provider: provider(JSON.stringify({
      memory: [{ id: '0', text: 'A fact that must survive', attributed_to: 'user',
                 entities: [{ type: 'PROPER', text: 'Something' }] }] })), ...base });

    expect(out.results).toHaveLength(1);
    expect((db.query('SELECT COUNT(*) c FROM memories').get() as { c: number }).c).toBe(1);
    expect((db.query('SELECT COUNT(*) c FROM entities').get() as { c: number }).c).toBe(0);
  });

  test('does not persist LLM-invented linked_memory_ids into metadata', async () => {
    const out = await addMemories({ db, provider: provider(JSON.stringify({
      memory: [{ id: '0', text: 'A durable fact', attributed_to: 'user',
                 linked_memory_ids: ['7', 'not-a-real-ref'] }] })), ...base });
    expect(out.results).toHaveLength(1);
    const row = db.query('SELECT metadata FROM memories LIMIT 1').get() as { metadata: string };
    const meta = JSON.parse(row.metadata);
    expect(meta.linked_memory_ids).toBeUndefined();
    expect(JSON.stringify(meta)).not.toContain('not-a-real-ref');
  });
});
