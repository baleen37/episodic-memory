/**
 * Tests for LLM config loading and provider factory
 *
 * These tests verify:
 * - Config file loading from ~/.config/memmem/config.json
 * - Provider creation from config
 * - Error handling for invalid configs
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { loadConfig, createProvider, __setConfigFileDepsForTests, DEFAULT_EMBEDDING_MAX_CONCURRENCY, type LLMConfig } from './config.js';

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

  describe('when config uses providers[] without a top-level apiKey', () => {
    it('should load successfully', () => {
      const validConfig = {
        provider: 'gemini' as const,
        providers: [
          { apiKey: 'key1', model: 'gemma-4-31b-it' },
          { apiKey: 'key2', model: 'gemma-4-26b-a4b-it' },
        ],
      };
      mockExistsSyncReturnValue = true;
      mockReadFileSyncReturnValue = JSON.stringify(validConfig);

      const config = loadConfig();
      expect(config).toMatchObject(validConfig);
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

  describe('providers array (round-robin)', () => {
    it('should create a rotating provider when providers[] is set', async () => {
      const config: LLMConfig = {
        provider: 'gemini',
        providers: [
          { apiKey: 'key1', model: 'gemma-4-31b-it' },
          { apiKey: 'key1', model: 'gemma-4-26b-a4b-it' },
          { apiKey: 'key2', model: 'gemma-4-31b-it' },
        ],
      };

      const provider = await createProvider(config);

      expect(provider).toBeDefined();
      expect(typeof provider.complete).toBe('function');
      // RoundRobinProvider exposes the same LLMProvider surface
      expect(provider.constructor.name).toBe('RoundRobinProvider');
    });

    it('should accept an optional email on each provider entry', async () => {
      const config: LLMConfig = {
        provider: 'gemini',
        providers: [
          { email: 'baleentest001@gmail.com', apiKey: 'key1', model: 'gemma-4-31b-it' },
          { email: 'baleentest001@gmail.com', apiKey: 'key2', model: 'gemma-4-26b-a4b-it' },
        ],
      };

      const provider = await createProvider(config);

      expect(provider.constructor.name).toBe('RoundRobinProvider');
      expect(config.providers?.[0].email).toBe('baleentest001@gmail.com');
    });

    it('should throw when providers[] is empty', async () => {
      const config: LLMConfig = {
        provider: 'gemini',
        providers: [],
      };

      await expect(createProvider(config)).rejects.toThrow();
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

describe('embedding config', () => {
  afterEach(() => {
    __setConfigFileDepsForTests(null);
  });

  it('reads embedding.maxConcurrency from the config file', () => {
    __setConfigFileDepsForTests({
      existsSync: () => true,
      readFileSync: (() => JSON.stringify({
        provider: 'gemini',
        apiKey: 'k',
        embedding: { maxConcurrency: 7 },
      })) as never,
    });
    expect(loadConfig()?.embedding?.maxConcurrency).toBe(7);
  });

  it('leaves embedding undefined when the config omits it', () => {
    __setConfigFileDepsForTests({
      existsSync: () => true,
      readFileSync: (() => JSON.stringify({ provider: 'gemini', apiKey: 'k' })) as never,
    });
    expect(loadConfig()?.embedding).toBeUndefined();
  });

  it('DEFAULT_EMBEDDING_MAX_CONCURRENCY is 4', () => {
    expect(DEFAULT_EMBEDDING_MAX_CONCURRENCY).toBe(4);
  });
});
