import { describe, expect, test } from 'bun:test';
import { parseExtractionResponse, extractMemories, LLMError } from './extract.js';
import type { LLMProvider } from '../llm/types.js';

function provider(text: string): LLMProvider {
  return { complete: async () => ({ text }) } as unknown as LLMProvider;
}
function failing(err: Error): LLMProvider {
  return { complete: async () => { throw err; } } as unknown as LLMProvider;
}

describe('parseExtractionResponse', () => {
  test('parses the mem0 output schema', () => {
    const out = parseExtractionResponse(JSON.stringify({
      memory: [{ id: '0', text: 'User adopted a puppy', attributed_to: 'user', linked_memory_ids: ['uuid-1'] }],
    }));
    expect(out).toEqual([
      { id: '0', text: 'User adopted a puppy', attributed_to: 'user', linked_memory_ids: ['uuid-1'] },
    ]);
  });

  test('defaults linked_memory_ids to empty array when omitted', () => {
    const out = parseExtractionResponse('{"memory":[{"id":"0","text":"t","attributed_to":"user"}]}');
    expect(out[0].linked_memory_ids).toEqual([]);
  });

  test('returns empty for an explicit empty extraction', () => {
    expect(parseExtractionResponse('{"memory": []}')).toEqual([]);
  });

  test('strips markdown fences', () => {
    const out = parseExtractionResponse('```json\n{"memory":[{"id":"0","text":"t","attributed_to":"user"}]}\n```');
    expect(out).toHaveLength(1);
  });

  test('strips fences preceded by an English preamble', () => {
    const out = parseExtractionResponse(
      'Here is the result:\n```json\n{"memory":[{"id":"0","text":"t","attributed_to":"user"}]}\n```');
    expect(out).toHaveLength(1);
  });

  test('strips fences preceded by a Korean preamble', () => {
    const out = parseExtractionResponse(
      '다음과 같습니다:\n```json\n{"memory":[{"id":"0","text":"t","attributed_to":"user"}]}\n```');
    expect(out).toHaveLength(1);
  });

  test('strips trailing prose after the closing fence', () => {
    const out = parseExtractionResponse(
      '```json\n{"memory":[{"id":"0","text":"t","attributed_to":"user"}]}\n```\nHope that helps!');
    expect(out).toHaveLength(1);
  });

  test('strips a bare fence with no language tag', () => {
    const out = parseExtractionResponse(
      '```\n{"memory":[{"id":"0","text":"t","attributed_to":"user"}]}\n```');
    expect(out).toHaveLength(1);
  });

  test('parses unfenced JSON with no fence at all', () => {
    const out = parseExtractionResponse('{"memory":[{"id":"0","text":"t","attributed_to":"user"}]}');
    expect(out).toHaveLength(1);
  });

  test('parses an opening fence with no closing fence', () => {
    const out = parseExtractionResponse(
      '```json\n{"memory":[{"id":"0","text":"t","attributed_to":"user"}]}');
    expect(out).toHaveLength(1);
  });

  test('drops entries missing required fields', () => {
    const out = parseExtractionResponse(JSON.stringify({
      memory: [
        { id: '0', text: 'keep', attributed_to: 'user' },
        { id: '1', attributed_to: 'user' },
        { id: '2', text: '', attributed_to: 'user' },
        { id: '3', text: 'bad role', attributed_to: 'system' },
      ],
    }));
    expect(out.map(m => m.text)).toEqual(['keep']);
  });

  test('raises LLMError on unparseable output', () => {
    expect(() => parseExtractionResponse('not json at all')).toThrow(LLMError);
  });

  test('raises LLMError when the memory key is missing', () => {
    expect(() => parseExtractionResponse('{"facts": []}')).toThrow(LLMError);
  });
});

describe('extractMemories', () => {
  const args = { newMessages: [{ role: 'user' as const, content: 'hi' }] };

  test('returns parsed memories on success', async () => {
    const out = await extractMemories(
      provider('{"memory":[{"id":"0","text":"a fact","attributed_to":"user"}]}'), args);
    expect(out[0].text).toBe('a fact');
  });

  test('wraps provider failure in LLMError rather than returning []', async () => {
    await expect(extractMemories(failing(new Error('503 upstream')), args)).rejects.toThrow(LLMError);
  });

  test('distinguishes provider failure from a genuinely empty extraction', async () => {
    await expect(extractMemories(provider('{"memory": []}'), args)).resolves.toEqual([]);
  });
});
