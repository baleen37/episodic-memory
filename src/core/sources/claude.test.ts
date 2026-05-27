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

  test('keeps tool_result user messages in the current exchange', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:00.000Z', sessionId: 's1', message: { role: 'user', content: 'Inspect the file' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:01.000Z', sessionId: 's1', message: { role: 'assistant', model: 'claude-sonnet', content: [{ type: 'text', text: 'I will read it.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/core/sources/claude.ts' } }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:02.000Z', sessionId: 's1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file content' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:03.000Z', sessionId: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'The file defines the parser.' }] } }),
    ].join('\n');

    const exchanges = parseClaudeJsonl(jsonl, { archivePath: '/archive/claude-projects/s1.jsonl', sourceKind: 'claude-projects' });

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].userText).toBe('Inspect the file');
    expect(exchanges[0].assistantText).toBe('I will read it.\nThe file defines the parser.');
    expect(exchanges[0].model).toBe('claude-sonnet');
    expect(exchanges[0].toolCalls).toEqual([{ toolName: 'Read', callId: 'toolu_1', input: '{"file_path":"src/core/sources/claude.ts"}', output: 'file content', status: 'success' }]);
  });

  test('records unmatched error tool results', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:00.000Z', sessionId: 's1', message: { role: 'user', content: 'Run command' } }),
      JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:01.000Z', sessionId: 's1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'failed', is_error: true }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:02.000Z', sessionId: 's1', message: { role: 'assistant', content: 'Command failed.' } }),
    ].join('\n');

    const exchanges = parseClaudeJsonl(jsonl, { archivePath: '/archive/claude-projects/s1.jsonl', sourceKind: 'claude-projects' });

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].userText).toBe('Run command');
    expect(exchanges[0].toolCalls).toEqual([{ toolName: null, callId: 'missing', input: null, output: 'failed', status: 'error' }]);
  });
});
