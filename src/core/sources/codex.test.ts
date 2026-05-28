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

  test('parses Codex tool variants and turn context metadata', () => {
    const jsonl = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session', cwd: '/old', model_provider: 'openai' } }),
      JSON.stringify({ type: 'turn_context', payload: { cwd: '/repo', model: 'gpt-5.2' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-26T00:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Search and run' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', id: 'custom-1', name: 'apply_patch', input: { patch: 'diff' } } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', id: 'custom-1', output: 'patched' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'tool_search_call', call_id: 'search-1', query: 'parser' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'tool_search_call_output', call_id: 'search-1', output: [{ path: 'src/core/sources/codex.ts' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'local_shell_call', call_id: 'shell-1', action: { cmd: 'bun test src/core/sources' } } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'local_shell_call_output', call_id: 'shell-1', output: 'pass' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } }),
    ].join('\n');

    const exchanges = parseCodexJsonl(jsonl, { archivePath: '/archive/codex-sessions/rollout.jsonl', sourceKind: 'codex-sessions' });

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({ cwd: '/repo', model: 'gpt-5.2', provider: 'openai', timestamp: Date.parse('2026-05-26T00:00:00.000Z') });
    expect(exchanges[0].toolCalls).toEqual([
      { toolName: 'apply_patch', callId: 'custom-1', input: '{"patch":"diff"}', output: 'patched', status: 'success' },
      { toolName: 'tool_search_call', callId: 'search-1', input: 'parser', output: '[{"path":"src/core/sources/codex.ts"}]', status: 'success' },
      { toolName: 'local_shell_call', callId: 'shell-1', input: '{"cmd":"bun test src/core/sources"}', output: 'pass', status: 'success' },
    ]);
  });

  test('snapshots turn context metadata per exchange', () => {
    const jsonl = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session', model_provider: 'openai' } }),
      JSON.stringify({ type: 'turn_context', payload: { cwd: '/repo-a', model: 'model-a' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-26T00:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-26T00:00:01.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First done.' }] } }),
      JSON.stringify({ type: 'turn_context', payload: { cwd: '/repo-b', model: 'model-b' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-26T00:00:02.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Second' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-26T00:00:03.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Second done.' }] } }),
    ].join('\n');

    const exchanges = parseCodexJsonl(jsonl, { archivePath: '/archive/codex-sessions/rollout.jsonl', sourceKind: 'codex-sessions' });

    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]).toMatchObject({ userText: 'First', cwd: '/repo-a', model: 'model-a', timestamp: Date.parse('2026-05-26T00:00:00.000Z') });
    expect(exchanges[1]).toMatchObject({ userText: 'Second', cwd: '/repo-b', model: 'model-b', timestamp: Date.parse('2026-05-26T00:00:02.000Z') });
  });
});
