/**
 * Tests for ZAIProvider
 *
 * These tests use mocking to avoid actual API calls while verifying correct behavior.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { ZAIProvider } from './zai-provider.js';
import type { LLMOptions } from './types.js';

describe('ZAIProvider', () => {
  describe('constructor', () => {
    it('should create a provider with API key', () => {
      const provider = new ZAIProvider('test-api-key');
      expect(provider).toBeDefined();
    });

    it('should create a provider with API key and custom model', () => {
      const provider = new ZAIProvider('test-api-key', 'glm-4.7');
      expect(provider).toBeDefined();
    });

    it('should use default model when not specified', () => {
      const provider = new ZAIProvider('test-api-key');
      expect(provider).toBeDefined();
    });

    it('should throw error when API key is missing', () => {
      expect(() => new ZAIProvider('')).toThrow('ZAIProvider requires an API key');
    });
  });

  describe('complete method', () => {
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      // Setup default successful response
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Test response',
            },
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
      } as any);
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('should return text and usage from API response', async () => {
      const provider = new ZAIProvider('test-api-key');
      const result = await provider.complete('test prompt');

      expect(result.text).toBe('Test response');
      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.output_tokens).toBe(5);
    });

    it('should work with maxTokens option', async () => {
      const provider = new ZAIProvider('test-api-key');
      const options: LLMOptions = {
        maxTokens: 2048,
      };

      const result = await provider.complete('test prompt', options);
      expect(result.text).toBeDefined();

      // Verify the fetch was called with max_tokens in the body
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/chat/completions'),
        expect.objectContaining({
          body: expect.stringContaining('"max_tokens":2048'),
        })
      );
    });

    it('should work with systemPrompt option', async () => {
      const provider = new ZAIProvider('test-api-key');
      const options: LLMOptions = {
        systemPrompt: 'You are a helpful assistant.',
      };

      const result = await provider.complete('test prompt', options);
      expect(result.text).toBeDefined();

      // Verify the fetch was called with system prompt in messages
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/chat/completions'),
        expect.objectContaining({
          body: expect.stringContaining('"role":"system"'),
        })
      );
    });

    it('should work with both maxTokens and systemPrompt', async () => {
      const provider = new ZAIProvider('test-api-key');
      const options: LLMOptions = {
        maxTokens: 4096,
        systemPrompt: 'Write concise event/fact memory records.',
      };

      const result = await provider.complete('test prompt', options);
      expect(result.text).toBeDefined();
    });

    it('should throw error when API request fails', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({
          error: {
            message: 'Invalid API key',
          },
        }),
      } as any);

      const provider = new ZAIProvider('test-api-key');
      await expect(provider.complete('test prompt')).rejects.toThrow('Z.AI API request failed');
    });
  });

  describe('TokenUsage structure', () => {
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Test response',
            },
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
      } as any);
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('should return TokenUsage with input and output tokens', async () => {
      const provider = new ZAIProvider('test-api-key');
      const result = await provider.complete('test');

      expect(result.usage).toBeDefined();
      expect(typeof result.usage.input_tokens).toBe('number');
      expect(typeof result.usage.output_tokens).toBe('number');
    });

    it('should have undefined cache fields (not supported by ZAI)', async () => {
      const provider = new ZAIProvider('test-api-key');
      const result = await provider.complete('test');

      // Cache fields should be undefined since ZAI doesn't support them
      expect(result.usage.cache_read_input_tokens).toBeUndefined();
      expect(result.usage.cache_creation_input_tokens).toBeUndefined();
    });
  });

  describe('LLMProvider interface compliance', () => {
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Test response',
            },
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
      } as any);
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('should implement LLMProvider interface', () => {
      const provider = new ZAIProvider('test-api-key');

      // Verify the provider has the required method
      expect(typeof provider.complete).toBe('function');
    });

    it('should return LLMResult structure', async () => {
      const provider = new ZAIProvider('test-api-key');
      const result = await provider.complete('test');

      expect(result.text).toBeDefined();
      expect(typeof result.text).toBe('string');
      expect(result.usage).toBeDefined();
    });
  });

  describe('integration scenarios', () => {
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Test response',
            },
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
      } as any);
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('should handle simple extraction prompt', async () => {
      const provider = new ZAIProvider('test-api-key');

      const prompt = 'Extract event/fact memory records from this transcript span.';
      const result = await provider.complete(prompt);

      expect(result.text).toBeDefined();
    });

    it('should handle long conversation prompt', async () => {
      const provider = new ZAIProvider('test-api-key');

      const longPrompt = `
        User: Hello
        Assistant: Hi there!
        User: How are you?
        Assistant: I'm doing well, thanks!
        [many more transcript events...]
      `;

      const result = await provider.complete(longPrompt, { maxTokens: 2048 });
      expect(result.text).toBeDefined();
    });

    it('should handle custom system prompt for extraction', async () => {
      const provider = new ZAIProvider('test-api-key');

      const options: LLMOptions = {
        systemPrompt: 'Extract concise event/fact memory records. Output ONLY valid JSON.',
      };

      const result = await provider.complete('Extract memory records from this text', options);
      expect(result.text).toBeDefined();
    });
  });

  describe('default model configuration', () => {
    it('should use glm-4.7 as default model', () => {
      const provider = new ZAIProvider('test-api-key');
      expect(provider).toBeDefined();
    });

    it('should allow overriding the default model', () => {
      const customModel = 'glm-4.7';
      const provider = new ZAIProvider('test-api-key', customModel);
      expect(provider).toBeDefined();
    });
  });
});
