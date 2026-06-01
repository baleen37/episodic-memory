import { describe, expect, mock, test } from 'bun:test';
import { buildMemoryExtractPrompt, extractMemoryRecordsFromSpan, parseMemoryExtractResponse, type TranscriptSpanForExtraction } from './extractor.js';
import type { LLMProvider } from './types.js';

const span: TranscriptSpanForExtraction = {
  sourceKind: 'claude-projects',
  archivePath: '/archive/session.jsonl',
  lineStart: 10,
  lineEnd: 20,
  observedAt: 1780272000000,
  project: 'memmem',
  text: 'User: We should remove exchanges and store fact/event memory records.\nAssistant: Agreed.',
};

describe('memory extractor', () => {
  test('builds prompt with transcript span and memory extraction instructions', () => {
    const prompt = buildMemoryExtractPrompt(span, 5);

    expect(prompt).toContain('<transcript_span');
    expect(prompt).toContain('source_kind="claude-projects"');
    expect(prompt).toContain('archive_path="/archive/session.jsonl"');
    expect(prompt).toContain('lines="10-20"');
    expect(prompt).toContain('fact');
    expect(prompt).toContain('event');
    expect(prompt).toContain('Return []');
    expect(prompt).toContain(span.text);
  });

  test('parses valid fact and event records', () => {
    const response = JSON.stringify([
      { kind: 'fact', text: 'Memmem stores fact/event memory records instead of exchanges.', confidence: 0.9, dedupeKey: 'memory-schema' },
      { kind: 'event', text: 'The team agreed to remove exchanges from core schema.', confidence: 0.7, dedupe_key: 'remove-exchanges' },
    ]);

    const records = parseMemoryExtractResponse(response, 10);

    expect(records).toEqual([
      { kind: 'fact', text: 'Memmem stores fact/event memory records instead of exchanges.', confidence: 0.9, dedupeKey: 'memory-schema' },
      { kind: 'event', text: 'The team agreed to remove exchanges from core schema.', confidence: 0.7, dedupeKey: 'remove-exchanges' },
    ]);
  });

  test('filters malformed unsupported and overlong records', () => {
    const overlong = 'x'.repeat(1000);
    const response = JSON.stringify([
      { kind: 'fact', text: 'A valid durable memory.', confidence: 1.4 },
      { kind: 'summary', text: 'Unsupported kind.', confidence: 1 },
      { kind: 'event', text: overlong, confidence: 1 },
      { kind: 'event', text: '   ', confidence: 1 },
      { kind: 'event', text: 123, confidence: 1 },
      null,
    ]);

    const records = parseMemoryExtractResponse(response, 10);

    expect(records).toEqual([
      { kind: 'fact', text: 'A valid durable memory.', confidence: 1 },
    ]);
  });

  test('calls provider complete and returns parsed records', async () => {
    const complete = mock(async () => ({
      text: JSON.stringify([
        { kind: 'fact', text: 'Memmem extracts durable memory records from transcript spans.', confidence: 0.8 },
      ]),
      usage: { input_tokens: 100, output_tokens: 20 },
    }));
    const provider = { complete } as unknown as LLMProvider;

    const records = await extractMemoryRecordsFromSpan(provider, span, { maxRecords: 3 });

    expect(complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        systemPrompt: expect.stringContaining('durable memory records'),
        maxTokens: 1500,
      }),
    );
    expect(records).toEqual([
      { kind: 'fact', text: 'Memmem extracts durable memory records from transcript spans.', confidence: 0.8 },
    ]);
  });
});
