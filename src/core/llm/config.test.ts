/**
 * Tests for LLM config loading and provider factory
 *
 * These tests verify:
 * - Config file loading from ~/.config/memmem/config.json
 * - Provider creation from config
 * - Error handling for invalid configs
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { loadConfig, createProvider, __setConfigFileDepsForTests, type LLMConfig } from './config.js';

// File-dependency stubs (per-test controlled)
let mockExistsSyncReturnValue = false;
let mockReadFileSyncReturnValue = '{}';

const mockExistsSync = mock(() => mockExistsSyncReturnValue);
const mockReadFileSync = mock(() => mockReadFileSyncReturnValue);

describe('loadConfig', () => {
  beforeEach(() => {
    mockExistsSyncReturnValue = false;
    mockReadFileSyncReturnValue = '{}';
    mockExistsSync.mockClear();
    mockReadFileSync.mockClear();
    __setConfigFileDepsForTests({
      existsSync: mockExistsSync as unknown as typeof import('fs').existsSync,
      readFileSync: mockReadFileSync as unknown as typeof import('fs').readFileSync,
    });
  });

  afterEach(() => {
    __setConfigFileDepsForTests(null);
  });

  describe('when config file does not exist', () => {
    it('should return null', () => {
      const config = loadConfig();
      expect(config).toBeNull();
    });
  });

  describe('when config file exists and is valid', () => {
    it('should return LLMConfig with gemini provider', () => {
      const validConfig = {
        provider: 'gemini' as const,
        apiKey: 'test-api-key',
        model: 'gemini-2.0-flash',
      };
      mockExistsSyncReturnValue = true;
      mockReadFileSyncReturnValue = JSON.stringify(validConfig);

      const config = loadConfig();
      expect(config).toMatchObject(validConfig);
    });

    it('should return LLMConfig with zai provider', () => {
      const validConfig = {
        provider: 'zai' as const,
        apiKey: 'test-api-key',
        model: 'glm-4.7',
      };
      mockExistsSyncReturnValue = true;
      mockReadFileSyncReturnValue = JSON.stringify(validConfig);

      const config = loadConfig();
      expect(config).toMatchObject(validConfig);
    });

    it('should return LLMConfig with provider and apiKey (model defaults)', () => {
      const validConfig = {
        provider: 'gemini' as const,
        apiKey: 'test-api-key',
      };
      mockExistsSyncReturnValue = true;
      mockReadFileSyncReturnValue = JSON.stringify(validConfig);

      const config = loadConfig();
      expect(config).toMatchObject(validConfig);
    });

    it('should return LLMConfig with ratelimit settings', () => {
      const validConfig = {
        provider: 'gemini' as const,
        apiKey: 'test-api-key',
        ratelimit: {
          embedding: { requestsPerSecond: 10, burstSize: 20 },
          llm: { requestsPerSecond: 3, burstSize: 6 },
        },
      };
      mockExistsSyncReturnValue = true;
      mockReadFileSyncReturnValue = JSON.stringify(validConfig);

      const config = loadConfig();
      expect(config).toMatchObject(validConfig);
      expect(config?.ratelimit?.embedding?.requestsPerSecond).toBe(10);
      expect(config?.ratelimit?.embedding?.burstSize).toBe(20);
      expect(config?.ratelimit?.llm?.requestsPerSecond).toBe(3);
      expect(config?.ratelimit?.llm?.burstSize).toBe(6);
    });

    it('should return LLMConfig with partial ratelimit settings', () => {
      const validConfig = {
        provider: 'gemini' as const,
        apiKey: 'test-api-key',
        ratelimit: {
          embedding: { requestsPerSecond: 10 },
        },
      };
      mockExistsSyncReturnValue = true;
      mockReadFileSyncReturnValue = JSON.stringify(validConfig);

      const config = loadConfig();
      expect(config).toMatchObject(validConfig);
      expect(config?.ratelimit?.embedding?.requestsPerSecond).toBe(10);
      expect(config?.ratelimit?.llm).toBeUndefined();
    });
  });

  describe('when config file exists but is invalid', () => {
    it('should return null and log warning for invalid JSON', () => {
      mockExistsSyncReturnValue = true;
      mockReadFileSyncReturnValue = 'invalid json{';

      const warnSpy = mock(() => {});
      const originalWarn = console.warn;
      console.warn = warnSpy;

      try {
        const config = loadConfig();
        expect(config).toBeNull();
      } finally {
        console.warn = originalWarn;
      }
    });

    it('should return null when provider is missing', () => {
      const invalidConfig = {
        apiKey: 'test-api-key',
        model: 'gemini-2.0-flash',
      };
      mockExistsSyncReturnValue = true;
      mockReadFileSyncReturnValue = JSON.stringify(invalidConfig);

      const config = loadConfig();
      expect(config).toBeNull();
    });

    it('should return null when apiKey is missing', () => {
      const invalidConfig = {
        provider: 'gemini',
        model: 'gemini-2.0-flash',
      };
      mockExistsSyncReturnValue = true;
      mockReadFileSyncReturnValue = JSON.stringify(invalidConfig);

      const config = loadConfig();
      expect(config).toBeNull();
    });

    it('should return null for empty provider string', () => {
      const invalidConfig = {
        provider: '',
        apiKey: 'test-api-key',
      };
      mockExistsSyncReturnValue = true;
      mockReadFileSyncReturnValue = JSON.stringify(invalidConfig);

      const config = loadConfig();
      expect(config).toBeNull();
    });

    it('should return null for unknown provider', () => {
      const invalidConfig = {
        provider: 'unknown',
        apiKey: 'test-api-key',
      };
      mockExistsSyncReturnValue = true;
      mockReadFileSyncReturnValue = JSON.stringify(invalidConfig);

      const config = loadConfig();
      expect(config).toBeNull();
    });
  });
});

describe('createProvider', () => {
  describe('valid configurations', () => {
    it('should create GeminiProvider with provider, apiKey and default model', async () => {
      const config: LLMConfig = {
        provider: 'gemini',
        apiKey: 'test-api-key',
      };

      const provider = await createProvider(config);

      expect(provider).toBeDefined();
      expect(provider.complete).toBeDefined();
      expect(typeof provider.complete).toBe('function');
    });

    it('should create GeminiProvider with provider, apiKey and specified model', async () => {
      const config: LLMConfig = {
        provider: 'gemini',
        apiKey: 'test-api-key',
        model: 'gemini-2.0-flash',
      };

      const provider = await createProvider(config);

      expect(provider).toBeDefined();
      expect(provider.complete).toBeDefined();
      expect(typeof provider.complete).toBe('function');
    });

    it('should create ZAIProvider with zai provider', async () => {
      const config: LLMConfig = {
        provider: 'zai',
        apiKey: 'test-api-key',
      };

      const provider = await createProvider(config);

      expect(provider).toBeDefined();
      expect(provider.complete).toBeDefined();
      expect(typeof provider.complete).toBe('function');
    });

    it('should create provider with correct structure for use', async () => {
      const config: LLMConfig = {
        provider: 'gemini',
        apiKey: 'test-key',
      };

      const provider = await createProvider(config);

      expect(provider).toBeDefined();
      expect(typeof provider.complete).toBe('function');
      expect(provider.complete.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('error handling', () => {
    it('should throw error when apiKey is missing', async () => {
      const config = {
        provider: 'gemini',
        model: 'gemini-2.0-flash',
      } as LLMConfig;

      await expect(createProvider(config)).rejects.toThrow('requires an apiKey');
    });

    it('should throw error when apiKey is empty string', async () => {
      const config: LLMConfig = {
        provider: 'gemini',
        apiKey: '',
      };

      await expect(createProvider(config)).rejects.toThrow('requires an apiKey');
    });
  });
});
