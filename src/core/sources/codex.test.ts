import { describe, expect, test } from 'bun:test';
import { parseCodexJsonl } from './codex.js';

describe('parseCodexJsonl', () => {
  test('parses Codex response items into exchanges and tool calls', () => {
    const jsonl = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session', cwd: '/repo', git: { branch: 'main' }, model: 'gpt-5.1', provider: 'openai' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run tests' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"cmd":"bun test"}' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'pass' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests passed.' }] } }),
    ].join('\n');

    const exchanges = parseCodexJsonl(jsonl, { archivePath: '/archive/codex-sessions/rollout.jsonl', sourceKind: 'codex-sessions' });

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].sourceKind).toBe('codex-sessions');
    expect(exchanges[0].sessionId).toBe('codex-session');
    expect(exchanges[0].userText).toBe('Run tests');
    expect(exchanges[0].assistantText).toBe('Tests passed.');
    expect(exchanges[0].toolCalls).toEqual([{ toolName: 'shell', callId: 'call-1', input: '{"cmd":"bun test"}', output: 'pass', status: 'success' }]);
  });
});
