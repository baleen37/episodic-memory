/**
 * Tests for extractor
 *
 * These tests use mocking to avoid actual API calls while verifying correct behavior.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { buildBatchExtractPrompt, parseBatchExtractResponse, extractFromBatch } from './extractor.js';
import type { LLMProvider } from './types.js';

// Mock the LLM provider
const mockLLMProvider = {
  complete: mock(async () => ({ text: '', usage: { input_tokens: 0, output_tokens: 0 } })),
} as unknown as LLMProvider;

describe('extractor', () => {
  beforeEach(() => {
    // Reset mock
    mockLLMProvider.complete = mock(async () => ({ text: '', usage: { input_tokens: 0, output_tokens: 0 } }));
  });

  describe('buildBatchExtractPrompt', () => {
    it('should build prompt with events and previous observations', () => {
      const events = [
        { toolName: 'Read', summary: 'Read /src/auth.ts (245 lines)', timestamp: 1234567890 },
        { toolName: 'Edit', summary: 'Edited /src/auth.ts: const auth = true → const auth = false', timestamp: 1234567891 },
      ];

      const previousObservations = [
        { title: 'Fixed authentication bug', content: 'Fixed auth check in login flow' },
      ];

      const prompt = buildBatchExtractPrompt(events, previousObservations);

      expect(prompt).toContain('<tool_events>');
      expect(prompt).toContain('Read /src/auth.ts (245 lines)');
      expect(prompt).toContain('Edited /src/auth.ts:');
      expect(prompt).toContain('<previous_observations>');
      expect(prompt).toContain('Fixed authentication bug');
      expect(prompt).toContain('title (under 50 characters)');
      expect(prompt).toContain('content (English canonical summary under 200 characters)');
      expect(prompt).toContain('content_original (optional original-language/source text when available)');
    });

    it('should build prompt without previous observations when none provided', () => {
      const events = [
        { toolName: 'Bash', summary: 'Ran `npm test` → exit 0', timestamp: 1234567890 },
      ];

      const prompt = buildBatchExtractPrompt(events, []);

      expect(prompt).toContain('<tool_events>');
      expect(prompt).toContain('Ran `npm test` → exit 0');
      expect(prompt).not.toContain('<previous_observations>');
    });

    it('should include instructions to return empty array for low-value batches', () => {
      const events = [
        { toolName: 'Read', summary: 'Read package.json', timestamp: 1234567890 },
      ];

      const prompt = buildBatchExtractPrompt(events, []);

      expect(prompt).toContain('empty array');
      expect(prompt).toContain('low-value');
    });

    it('should limit previous observations to last 3', () => {
      const events = [{ toolName: 'Write', summary: 'Created test.ts', timestamp: 1234567890 }];

      const previousObservations = [
        { title: 'Obs 1', content: 'Content 1' },
        { title: 'Obs 2', content: 'Content 2' },
        { title: 'Obs 3', content: 'Content 3' },
        { title: 'Obs 4', content: 'Content 4' },
        { title: 'Obs 5', content: 'Content 5' },
      ];

      const prompt = buildBatchExtractPrompt(events, previousObservations);

      // Should only include last 3
      expect(prompt).toContain('Obs 3');
      expect(prompt).toContain('Obs 4');
      expect(prompt).toContain('Obs 5');
      expect(prompt).not.toContain('Obs 1');
      expect(prompt).not.toContain('Obs 2');
    });
  });

  describe('parseBatchExtractResponse', () => {
    it('should parse valid JSON response with observations', () => {
      const json = JSON.stringify([
        { title: 'Fixed parser bug', content: 'Fixed edge case in regex parsing' },
        { title: 'Added tests', content: 'Added unit tests for parser module' },
      ]);

      const result = parseBatchExtractResponse(json);

      expect(result).toEqual([
        { title: 'Fixed parser bug', content: 'Fixed edge case in regex parsing' },
        { title: 'Added tests', content: 'Added unit tests for parser module' },
      ]);
    });

    it('should parse optional content_original field when present', () => {
      const json = JSON.stringify([
        {
          title: 'Clarified billing rule',
          content: 'Documented billing validation behavior',
          content_original: '청구 검증 동작을 문서화함',
        },
      ]);

      const result = parseBatchExtractResponse(json);

      expect(result).toEqual([
        {
          title: 'Clarified billing rule',
          content: 'Documented billing validation behavior',
          contentOriginal: '청구 검증 동작을 문서화함',
        },
      ]);
    });

    it('should parse empty array response', () => {
      const json = JSON.stringify([]);

      const result = parseBatchExtractResponse(json);

      expect(result).toEqual([]);
    });

    it('should handle malformed JSON gracefully', () => {
      const invalidJson = 'This is not valid JSON';

      const result = parseBatchExtractResponse(invalidJson);

      expect(result).toEqual([]);
    });

    it('should handle JSON with markdown code blocks', () => {
      const jsonWithMarkdown = '```json\n' + JSON.stringify([
        { title: 'Test observation', content: 'Test content' },
      ]) + '\n```';

      const result = parseBatchExtractResponse(jsonWithMarkdown);

      expect(result).toEqual([
        { title: 'Test observation', content: 'Test content' },
      ]);
    });

    it('should filter out observations with missing required fields', () => {
      const json = JSON.stringify([
        { title: 'Valid obs', content: 'Valid content' },
        { title: 'Missing content' }, // Missing content field
        { content: 'Missing title' }, // Missing title field
        {}, // Empty object
      ]);

      const result = parseBatchExtractResponse(json);

      expect(result).toEqual([
        { title: 'Valid obs', content: 'Valid content' },
      ]);
    });

    it('should ignore non-string content_original and keep valid observation', () => {
      const json = JSON.stringify([
        { title: 'Valid obs', content: 'Valid content', content_original: '원문 텍스트' },
        { title: 'Invalid original', content: 'Content', content_original: 123 },
      ]);

      const result = parseBatchExtractResponse(json);

      expect(result).toEqual([
        { title: 'Valid obs', content: 'Valid content', contentOriginal: '원문 텍스트' },
        { title: 'Invalid original', content: 'Content' },
      ]);
    });
  });

  describe('extractFromBatch', () => {
    it('should call LLM provider with built prompt', async () => {
      const mockComplete = mock(async () => ({
        text: JSON.stringify([{ title: 'Test', content: 'Content' }]),
        usage: { input_tokens: 100, output_tokens: 20 },
      }));

      mockLLMProvider.complete = mockComplete;

      const events = [
        { toolName: 'Read', summary: 'Read file.ts', timestamp: 1234567890 },
      ];

      const previousObservations = [{ title: 'Previous', content: 'Previous content' }];

      const result = await extractFromBatch(
        mockLLMProvider,
        events,
        previousObservations
      );

      expect(mockComplete).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          systemPrompt: expect.stringContaining('observation extractor'),
        })
      );

      // Verify the prompt contains key elements
      const calls = (mockComplete as any).mock?.calls;
      if (calls && calls.length > 0) {
        const prompt = calls[0][0] as string;
        expect(prompt).toContain('Read file.ts');
        expect(prompt).toContain('Previous');
      }

      expect(result).toEqual([{ title: 'Test', content: 'Content' }]);
    });

    it('should return empty array when LLM returns empty array', async () => {
      const mockComplete = mock(async () => ({
        text: JSON.stringify([]),
        usage: { input_tokens: 50, output_tokens: 5 },
      }));

      mockLLMProvider.complete = mockComplete;

      const events = [{ toolName: 'Bash', summary: 'Ran echo test', timestamp: 1234567890 }];

      const result = await extractFromBatch(mockLLMProvider, events, []);

      expect(result).toEqual([]);
    });

    it('should return empty array when LLM call fails', async () => {
      const mockComplete = mock(async () => { throw new Error('API error'); });

      mockLLMProvider.complete = mockComplete;

      const events = [{ toolName: 'Read', summary: 'Read file', timestamp: 1234567890 }];

      const result = await extractFromBatch(mockLLMProvider, events, []);

      expect(result).toEqual([]);
    });

    it('should handle malformed LLM response gracefully', async () => {
      const mockComplete = mock(async () => ({
        text: 'This is not valid JSON',
        usage: { input_tokens: 50, output_tokens: 10 },
      }));

      mockLLMProvider.complete = mockComplete;

      const events = [{ toolName: 'Edit', summary: 'Edited file', timestamp: 1234567890 }];

      const result = await extractFromBatch(mockLLMProvider, events, []);

      expect(result).toEqual([]);
    });

    it('should include system prompt guidance for canonical and original content', async () => {
      const mockComplete = mock(async () => ({
        text: JSON.stringify([{ title: 'Test', content: 'Content' }]),
        usage: { input_tokens: 100, output_tokens: 20 },
      }));

      mockLLMProvider.complete = mockComplete;

      const events = [{ toolName: 'Write', summary: 'Created file', timestamp: 1234567890 }];

      await extractFromBatch(mockLLMProvider, events, []);

      expect(mockComplete).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          systemPrompt: expect.stringContaining('content: English canonical summary'),
        })
      );
      expect(mockComplete).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          systemPrompt: expect.stringContaining('content_original: Optional original-language/source text when available'),
        })
      );
    });
  });

  describe('integration scenarios', () => {
    it('should handle a realistic batch of tool events', async () => {
      const mockComplete = mock(async () => ({
        text: JSON.stringify([
          { title: 'Implemented auth feature', content: 'Added JWT authentication to login endpoint' },
          { title: 'Fixed memory leak', content: 'Resolved memory leak in event handler' },
        ]),
        usage: { input_tokens: 200, output_tokens: 40 },
      }));

      mockLLMProvider.complete = mockComplete;

      const events = [
        { toolName: 'Read', summary: 'Read /src/auth/login.ts', timestamp: 1234567890 },
        { toolName: 'Edit', summary: 'Edited /src/auth/login.ts: added JWT verify', timestamp: 1234567891 },
        { toolName: 'Bash', summary: 'Ran `npm test` → exit 0', timestamp: 1234567892 },
        { toolName: 'Read', summary: 'Read /src/event/handler.ts', timestamp: 1234567893 },
        { toolName: 'Edit', summary: 'Edited /src/event/handler.ts: fixed cleanup', timestamp: 1234567894 },
      ];

      const previousObservations = [
        { title: 'Started auth implementation', content: 'Began work on authentication system' },
      ];

      const result = await extractFromBatch(
        mockLLMProvider,
        events,
        previousObservations
      );

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('Implemented auth feature');
      expect(result[1].title).toBe('Fixed memory leak');
    });

    it('should handle low-value batch by returning empty array', async () => {
      const mockComplete = mock(async () => ({
        text: JSON.stringify([]),
        usage: { input_tokens: 100, output_tokens: 5 },
      }));

      mockLLMProvider.complete = mockComplete;

      const events = [
        { toolName: 'Bash', summary: 'Ran `git status`', timestamp: 1234567890 },
        { toolName: 'Bash', summary: 'Ran `ls -la`', timestamp: 1234567891 },
      ];

      const result = await extractFromBatch(mockLLMProvider, events, []);

      expect(result).toEqual([]);
    });
  });
});
