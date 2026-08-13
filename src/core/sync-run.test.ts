import { describe, expect, test } from 'bun:test';
import type { LLMProvider } from './llm/types.js';
import type { SourceAdapter, TranscriptSpan } from './sources/types.js';
import { indexPendingArchives, type IndexableArchiveFile } from './sync-run.js';

const provider = {} as LLMProvider;

function span(lineStart: number): TranscriptSpan {
  return {
    archivePath: '/archive/session.jsonl',
    lineStart,
    lineEnd: lineStart + 1,
    sourceKind: 'test',
    observedAt: null,
    text: 'test span',
    messages: [{ role: 'user', content: 'test' }],
  };
}

function file(spans: TranscriptSpan[]): IndexableArchiveFile {
  const adapter: SourceAdapter = {
    kind: 'test',
    roots: () => [],
    detect: () => true,
    parse: () => spans,
  };
  return { adapter, archivePath: '/archive/session.jsonl', mtimeMs: 1 };
}

describe('indexPendingArchives', () => {
  test('does not mark a file indexed when a span fails', async () => {
    const marked: string[] = [];

    const result = await indexPendingArchives({
      files: [file([span(1)])],
      provider,
      extractionBudget: 1,
      readArchiveFile: () => '{}',
      markIndexed: archivePath => marked.push(archivePath),
      indexSpan: async () => { throw new Error('failed span'); },
    });

    expect(result.filesIndexed).toBe(0);
    expect(result.failed).toBe(1);
    expect(marked).toEqual([]);
  });

  test('stops before starting another file when the budget is exhausted', async () => {
    const indexed: string[] = [];
    let spansIndexed = 0;
    const files = [file([span(1)]), { ...file([span(2)]), archivePath: '/archive/second.jsonl' }];

    const result = await indexPendingArchives({
      files,
      provider,
      extractionBudget: 1,
      readArchiveFile: () => '{}',
      markIndexed: archivePath => indexed.push(archivePath),
      indexSpan: async () => {
        spansIndexed++;
        return 1;
      },
    });

    expect(spansIndexed).toBe(1);
    expect(result.filesIndexed).toBe(1);
    expect(result.memoriesAdded).toBe(1);
    expect(indexed).toEqual(['/archive/session.jsonl']);
  });
});
