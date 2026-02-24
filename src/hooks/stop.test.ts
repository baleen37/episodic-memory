/**
 * Tests for Stop hook - batch LLM extraction from pending_events.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, getObservation } from '../core/db.js';
import { handlePostToolUse } from './post-tool-use.js';
import { handleStop, type StopHookOptions } from './stop.js';
import type { LLMProvider } from '../core/llm/index.js';

const TEST_SESSION_ID = 'test-session-123';
const TEST_PROJECT = 'test-project';

// Mock LLM provider
const mockLLMProvider = {
  complete: vi.fn(),
} as unknown as LLMProvider;

// Use vi.hoisted to create mock embedding array before vi.mock is hoisted
const mockEmbedding = vi.hoisted(() => new Array(384).fill(0.1));

// Mock embeddings module
vi.mock('../core/embeddings.js', () => ({
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  generateEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
}));

function addReadEvents(db: Database, sessionId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    handlePostToolUse(db, sessionId, TEST_PROJECT, 'Read', {
      file_path: `/src/file${i}.ts`,
      lines: 100,
    });
  }
}

function createStopOptions(overrides?: Partial<StopHookOptions>): StopHookOptions {
  return {
    provider: mockLLMProvider,
    sessionId: TEST_SESSION_ID,
    project: TEST_PROJECT,
    ...overrides,
  };
}

describe('Stop Hook', () => {
  let db: Database;
  let tmpSrcDir: string;
  let tmpDstDir: string;

  beforeEach(() => {
    process.env.CONVERSATION_MEMORY_DB_PATH = ':memory:';
    db = initDatabase();
    vi.clearAllMocks();

    tmpSrcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memmem-src-'));
    tmpDstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memmem-dst-'));
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    fs.rmSync(tmpSrcDir, { recursive: true });
    fs.rmSync(tmpDstDir, { recursive: true });
  });

  describe('handleStop', () => {
    test('skips extraction when less than 3 events', async () => {
      handlePostToolUse(db, TEST_SESSION_ID, TEST_PROJECT, 'Read', { file_path: '/src/test.ts', lines: 100 });
      handlePostToolUse(db, TEST_SESSION_ID, TEST_PROJECT, 'Bash', { command: 'echo test', exitCode: 0 });

      await handleStop(db, createStopOptions());

      expect(mockLLMProvider.complete).not.toHaveBeenCalled();
      expect(getObservation(db, 1)).toBeNull();
    });

    test('extracts and stores observations when threshold is met', async () => {
      const mockComplete = vi.fn().mockResolvedValue({
        text: JSON.stringify([
          {
            title: 'Fixed auth bug',
            content: 'Resolved JWT validation issue',
            content_original: 'JWT 검증 문제를 해결함',
          },
        ]),
        usage: { input_tokens: 100, output_tokens: 20 },
      });
      mockLLMProvider.complete = mockComplete;

      handlePostToolUse(db, TEST_SESSION_ID, TEST_PROJECT, 'Read', { file_path: '/src/auth.ts', lines: 100 });
      handlePostToolUse(db, TEST_SESSION_ID, TEST_PROJECT, 'Edit', {
        file_path: '/src/auth.ts',
        old_string: 'old',
        new_string: 'new',
      });
      handlePostToolUse(db, TEST_SESSION_ID, TEST_PROJECT, 'Bash', { command: 'npm test', exitCode: 0 });

      await handleStop(db, createStopOptions());

      expect(mockComplete).toHaveBeenCalledTimes(1);

      const obs = getObservation(db, 1);
      expect(obs).not.toBeNull();
      expect(obs?.title).toBe('Fixed auth bug');
      expect(obs?.content).toBe('Resolved JWT validation issue');
      expect(obs?.contentOriginal).toBe('JWT 검증 문제를 해결함');
      expect(obs?.sessionId).toBe(TEST_SESSION_ID);
      expect(obs?.project).toBe(TEST_PROJECT);
    });

    test('handles empty LLM response without storing observations', async () => {
      const mockComplete = vi.fn().mockResolvedValue({
        text: JSON.stringify([]),
        usage: { input_tokens: 50, output_tokens: 5 },
      });
      mockLLMProvider.complete = mockComplete;

      addReadEvents(db, TEST_SESSION_ID, 3);

      await handleStop(db, createStopOptions());

      expect(mockComplete).toHaveBeenCalledTimes(1);
      expect(getObservation(db, 1)).toBeNull();
    });

    test('handles LLM errors gracefully', async () => {
      const mockComplete = vi.fn().mockRejectedValue(new Error('API error'));
      mockLLMProvider.complete = mockComplete;

      addReadEvents(db, TEST_SESSION_ID, 3);

      await expect(handleStop(db, createStopOptions())).resolves.toBeUndefined();
      expect(getObservation(db, 1)).toBeNull();
    });
  });

  describe('batching behavior', () => {
    test('uses default batch size when batchSize is not provided', async () => {
      const mockComplete = vi.fn().mockResolvedValue({
        text: JSON.stringify([{ title: 'Test', content: 'Content' }]),
        usage: { input_tokens: 100, output_tokens: 20 },
      });
      mockLLMProvider.complete = mockComplete;

      addReadEvents(db, TEST_SESSION_ID, 30);

      await handleStop(db, createStopOptions());

      expect(mockComplete).toHaveBeenCalledTimes(2);
    });

    test('uses custom batch size when provided', async () => {
      const mockComplete = vi.fn().mockResolvedValue({
        text: JSON.stringify([{ title: 'Test', content: 'Content' }]),
        usage: { input_tokens: 100, output_tokens: 20 },
      });
      mockLLMProvider.complete = mockComplete;

      addReadEvents(db, TEST_SESSION_ID, 30);

      await handleStop(db, createStopOptions({ batchSize: 10 }));

      expect(mockComplete).toHaveBeenCalledTimes(3);
    });

    test('passes previous observations context to the next batch', async () => {
      const firstBatchTitle = 'First batch signal';
      let callCount = 0;
      const mockComplete = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: JSON.stringify([
              { title: firstBatchTitle, content: 'First batch content' },
            ]),
            usage: { input_tokens: 100, output_tokens: 20 },
          };
        }

        return {
          text: JSON.stringify([{ title: 'Second batch result', content: 'Second batch content' }]),
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      });
      mockLLMProvider.complete = mockComplete;

      addReadEvents(db, TEST_SESSION_ID, 20);

      await handleStop(db, createStopOptions());

      expect(mockComplete).toHaveBeenCalledTimes(2);

      const firstPrompt = mockComplete.mock.calls[0]?.[0] as string;
      const secondPrompt = mockComplete.mock.calls[1]?.[0] as string;

      expect(firstPrompt).not.toContain(firstBatchTitle);
      expect(secondPrompt).toContain(firstBatchTitle);
    });
  });

  describe('archive', () => {
    test('archives JSONL when summarization completes', async () => {
      const mockComplete = vi.fn().mockResolvedValue({
        text: JSON.stringify([{ title: 'Test', content: 'Content' }]),
        usage: { input_tokens: 100, output_tokens: 20 },
      });
      mockLLMProvider.complete = mockComplete;

      const sessionId = 'session-archive-test';
      const projectSlug = '-Users-jito-test-project';

      const srcProjectDir = path.join(tmpSrcDir, projectSlug);
      fs.mkdirSync(srcProjectDir, { recursive: true });
      fs.writeFileSync(path.join(srcProjectDir, `${sessionId}.jsonl`), '{"type":"user"}\n');

      handlePostToolUse(db, sessionId, TEST_PROJECT, 'Read', { file_path: '/src/a.ts', lines: 10 });
      handlePostToolUse(db, sessionId, TEST_PROJECT, 'Edit', { file_path: '/src/a.ts', old_string: 'a', new_string: 'b' });
      handlePostToolUse(db, sessionId, TEST_PROJECT, 'Bash', { command: 'npm test', exitCode: 0 });

      await handleStop(db, {
        provider: mockLLMProvider,
        sessionId,
        project: TEST_PROJECT,
        projectSlug,
        claudeProjectsDir: tmpSrcDir,
        archiveDir: tmpDstDir,
      });

      const archivedPath = path.join(tmpDstDir, projectSlug, `${sessionId}.jsonl`);
      expect(fs.existsSync(archivedPath)).toBe(true);
    });

    test('skips archive when fewer than 3 events (no summarization)', async () => {
      const sessionId = 'session-skip-archive';
      const projectSlug = '-Users-jito-test-project';

      const srcProjectDir = path.join(tmpSrcDir, projectSlug);
      fs.mkdirSync(srcProjectDir, { recursive: true });
      fs.writeFileSync(path.join(srcProjectDir, `${sessionId}.jsonl`), '{"type":"user"}\n');

      handlePostToolUse(db, sessionId, TEST_PROJECT, 'Read', { file_path: '/src/a.ts', lines: 10 });
      handlePostToolUse(db, sessionId, TEST_PROJECT, 'Read', { file_path: '/src/b.ts', lines: 10 });

      await handleStop(db, {
        provider: mockLLMProvider,
        sessionId,
        project: TEST_PROJECT,
        projectSlug,
        claudeProjectsDir: tmpSrcDir,
        archiveDir: tmpDstDir,
      });

      const archivedPath = path.join(tmpDstDir, projectSlug, `${sessionId}.jsonl`);
      expect(fs.existsSync(archivedPath)).toBe(false);
    });
  });
});
