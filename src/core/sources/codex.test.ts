import { describe, expect, test } from 'bun:test';
import { parseCodexJsonl } from './codex.js';

describe('parseCodexJsonl', () => {
  test('parses Codex response items into spans', () => {
    const jsonl = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session', cwd: '/repo', git: { branch: 'main' }, model: 'gpt-5.1', provider: 'openai' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-26T00:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run tests' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"cmd":"bun test"}' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'pass' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-26T00:00:01.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests passed.' }] } }),
    ].join('\n');

    const spans = parseCodexJsonl(jsonl, { archivePath: '/archive/codex-sessions/rollout.jsonl', sourceKind: 'codex-sessions' });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      archivePath: '/archive/codex-sessions/rollout.jsonl',
      sourceKind: 'codex-sessions',
      lineStart: 2,
      lineEnd: 5,
      sessionId: 'codex-session',
      project: null,
      cwd: '/repo',
      gitBranch: 'main',
      model: 'gpt-5.1',
      provider: 'codex',
      metadataJson: JSON.stringify({ source: 'codex' }),
      observedAt: Date.parse('2026-05-26T00:00:00.000Z'),
      text: 'User: Run tests\nAssistant: Tests passed.',
    });
    expect(spans[0].text).toContain('User: Run tests');
    expect(spans[0].text).toContain('Assistant: Tests passed.');
    expect('userText' in spans[0]).toBe(false);
    expect('assistantText' in spans[0]).toBe(false);
    expect(spans[0].messages).toEqual([
      { role: 'user', content: 'Run tests' },
      { role: 'assistant', content: 'Tests passed.' },
    ]);
  });

  test('parses Codex tool variants without exposing tool calls', () => {
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

    const spans = parseCodexJsonl(jsonl, { archivePath: '/archive/codex-sessions/rollout.jsonl', sourceKind: 'codex-sessions' });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ model: 'gpt-5.2', provider: 'codex', observedAt: Date.parse('2026-05-26T00:00:00.000Z') });
    expect(spans[0].text).toBe('User: Search and run\nAssistant: Done.');
    expect('toolCalls' in spans[0]).toBe(false);
  });

  test('snapshots turn context metadata per span', () => {
    const jsonl = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session', model_provider: 'openai' } }),
      JSON.stringify({ type: 'turn_context', payload: { cwd: '/repo-a', model: 'model-a' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-26T00:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-26T00:00:01.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First done.' }] } }),
      JSON.stringify({ type: 'turn_context', payload: { cwd: '/repo-b', model: 'model-b' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-26T00:00:02.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Second' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-26T00:00:03.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Second done.' }] } }),
    ].join('\n');

    const spans = parseCodexJsonl(jsonl, { archivePath: '/archive/codex-sessions/rollout.jsonl', sourceKind: 'codex-sessions' });

    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ model: 'model-a', observedAt: Date.parse('2026-05-26T00:00:00.000Z'), text: 'User: First\nAssistant: First done.' });
    expect(spans[1]).toMatchObject({ model: 'model-b', observedAt: Date.parse('2026-05-26T00:00:02.000Z'), text: 'User: Second\nAssistant: Second done.' });
  });

  test('codex span carries cwd from session_meta payload', () => {
    const jsonl = [
      JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/Users/me/dev/acme/gadget' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] } }),
    ].join('\n');
    const spans = parseCodexJsonl(jsonl, { archivePath: '/archive/codex-sessions/s1.jsonl', sourceKind: 'codex-sessions' });
    expect(spans[0]?.cwd).toBe('/Users/me/dev/acme/gadget');
  });
});
