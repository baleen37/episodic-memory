import { describe, expect, test } from 'bun:test';
import { ADDITIVE_EXTRACTION_PROMPT, generateAdditiveExtractionPrompt, PAST_MESSAGE_TRUNCATION_LIMIT } from './prompts.js';

describe('ADDITIVE_EXTRACTION_PROMPT', () => {
  test('declares ADD as the sole operation', () => {
    expect(ADDITIVE_EXTRACTION_PROMPT).toContain('Your sole operation is ADD');
  });
  test('documents the output schema fields', () => {
    expect(ADDITIVE_EXTRACTION_PROMPT).toContain('linked_memory_ids');
    expect(ADDITIVE_EXTRACTION_PROMPT).toContain('attributed_to');
    expect(ADDITIVE_EXTRACTION_PROMPT).toContain('{"memory": []}');
  });
  test('omits the use_input_language block so storage stays English', () => {
    expect(ADDITIVE_EXTRACTION_PROMPT).not.toContain('Language Requirement');
    expect(ADDITIVE_EXTRACTION_PROMPT).not.toContain('SAME LANGUAGE');
  });
  test('is the full upstream prompt, not a paraphrase', () => {
    expect(ADDITIVE_EXTRACTION_PROMPT.length).toBeGreaterThan(10000);
  });
  test('prompt is byte-identical to the upstream source', async () => {
    const upstream = await Bun.file(
      `${import.meta.dir}/../../../.superpowers/sdd/2026-08-11-mem0-v2-architecture/additive-extraction-prompt.txt`
    ).text();
    expect(ADDITIVE_EXTRACTION_PROMPT).toBe(upstream);
  });
});

describe('generateAdditiveExtractionPrompt', () => {
  const base = { newMessages: [{ role: 'user' as const, content: 'I adopted a puppy' }] };

  test('emits sections in mem0 order', () => {
    const out = generateAdditiveExtractionPrompt(base);
    const order = ['## Summary', '## Last k Messages', '## Recently Extracted Memories',
      '## Existing Memories', '## New Messages', '## Observation Date', '## Current Date', '# Output:'];
    let cursor = -1;
    for (const section of order) {
      const at = out.indexOf(section);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test('serializes existing memories as id/text JSON', () => {
    const out = generateAdditiveExtractionPrompt({
      ...base,
      existingMemories: [{ id: 'a1b2', text: 'User has a dog' }],
    });
    expect(out).toContain('"id": "a1b2"');
    expect(out).toContain('"text": "User has a dog"');
  });

  test('includes custom instructions only when provided', () => {
    expect(generateAdditiveExtractionPrompt(base)).not.toContain('## Custom Instructions');
    expect(generateAdditiveExtractionPrompt({ ...base, customInstructions: 'focus on pets' }))
      .toContain('## Custom Instructions\nfocus on pets');
  });

  test('uses the supplied observation date as the temporal anchor', () => {
    const out = generateAdditiveExtractionPrompt({ ...base, observationDate: '2025-03-10' });
    expect(out).toContain('## Observation Date\n2025-03-10');
  });

  test('truncates long past messages at the upstream limit', () => {
    const out = generateAdditiveExtractionPrompt({
      ...base,
      lastKMessages: [{ role: 'user', content: 'x'.repeat(500) }],
    });
    expect(out).toContain('x'.repeat(PAST_MESSAGE_TRUNCATION_LIMIT));
    expect(out).not.toContain('x'.repeat(PAST_MESSAGE_TRUNCATION_LIMIT + 1));
  });

  test('does not truncate new messages', () => {
    const out = generateAdditiveExtractionPrompt({
      newMessages: [{ role: 'user', content: 'y'.repeat(500) }],
    });
    expect(out).toContain('y'.repeat(500));
  });

  test('renders empty collections without crashing', () => {
    const out = generateAdditiveExtractionPrompt({ newMessages: [] });
    expect(out).toContain('## Existing Memories\n[]');
  });
});
