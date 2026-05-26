import { describe, expect, test } from 'bun:test';
import { parseClaudeJsonl } from './claude.js';

describe('parseClaudeJsonl', () => {
  test('parses user and assistant messages into exchanges', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:00.000Z', sessionId: 's1', cwd: '/repo', gitBranch: 'main', message: { role: 'user', content: 'How do we sync?' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:01.000Z', sessionId: 's1', cwd: '/repo', gitBranch: 'main', message: { role: 'assistant', content: [{ type: 'text', text: 'Copy transcripts into archive.' }] } }),
    ].join('\n');

    const exchanges = parseClaudeJsonl(jsonl, { archivePath: '/archive/claude-projects/s1.jsonl', sourceKind: 'claude-projects' });

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({
      archivePath: '/archive/claude-projects/s1.jsonl',
      sourceKind: 'claude-projects',
      lineStart: 1,
      lineEnd: 2,
      sessionId: 's1',
      cwd: '/repo',
      gitBranch: 'main',
      userText: 'How do we sync?',
      assistantText: 'Copy transcripts into archive.',
    });
  });
});
