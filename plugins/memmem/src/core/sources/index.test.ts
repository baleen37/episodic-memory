import { describe, expect, test } from 'bun:test';
import { getBuiltInSourceAdapters } from './index.js';

describe('getBuiltInSourceAdapters', () => {
  test('returns stable source kinds for first adapters', () => {
    const kinds = getBuiltInSourceAdapters().map(adapter => adapter.kind);
    expect(kinds).toEqual(['claude-projects', 'claude-transcripts', 'codex-sessions']);
  });
});
