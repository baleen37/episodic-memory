import { describe, expect, test } from 'bun:test';
import { parseClaudeJsonl } from './claude.js';

describe('parseClaudeJsonl', () => {
  test('parses user and assistant messages into spans', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:00.000Z', sessionId: 's1', cwd: '/repo', gitBranch: 'main', message: { role: 'user', content: 'How do we sync?' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:01.000Z', sessionId: 's1', cwd: '/repo', gitBranch: 'main', message: { role: 'assistant', content: [{ type: 'text', text: 'Copy transcripts into archive.' }] } }),
    ].join('\n');

    const spans = parseClaudeJsonl(jsonl, { archivePath: '/archive/claude-code-projects/s1.jsonl', sourceKind: 'claude-code-projects' });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      archivePath: '/archive/claude-code-projects/s1.jsonl',
      sourceKind: 'claude-code-projects',
      lineStart: 1,
      lineEnd: 2,
      sessionId: 's1',
      project: null,
      cwd: '/repo',
      gitBranch: 'main',
      observedAt: Date.parse('2026-05-26T00:00:00.000Z'),
      text: 'User: How do we sync?\nAssistant: Copy transcripts into archive.',
    });
    expect(spans[0].text).toContain('User: How do we sync?');
    expect(spans[0].text).toContain('Assistant: Copy transcripts into archive.');
    expect('userText' in spans[0]).toBe(false);
    expect('assistantText' in spans[0]).toBe(false);
  });

  test('keeps tool_result user messages in the current span', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:00.000Z', sessionId: 's1', message: { role: 'user', content: 'Inspect the file' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:01.000Z', sessionId: 's1', message: { role: 'assistant', model: 'claude-sonnet', content: [{ type: 'text', text: 'I will read it.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/core/sources/claude.ts' } }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:02.000Z', sessionId: 's1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file content' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:03.000Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'The file defines the parser.' }] } }),
    ].join('\n');

    const spans = parseClaudeJsonl(jsonl, { archivePath: '/archive/claude-code-projects/s1.jsonl', sourceKind: 'claude-code-projects' });

    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('User: Inspect the file\nAssistant: I will read it.\nThe file defines the parser.');
    expect(spans[0].model).toBe('claude-sonnet');
    expect(spans[0].lineEnd).toBe(4);
  });

  test('emits user-only spans when compact text is non-empty', () => {
    const jsonl = JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:00.000Z', sessionId: 's1', message: { role: 'user', content: 'Run command' } });

    const spans = parseClaudeJsonl(jsonl, { archivePath: '/archive/claude-code-projects/s1.jsonl', sourceKind: 'claude-code-projects' });

    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('User: Run command');
  });
});
