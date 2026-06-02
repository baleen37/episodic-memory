import { Database } from 'bun:sqlite';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import {
  readConversation,
  formatConversationAsMarkdown,
  parseJsonlMessages,
  filterValidMessages,
  formatMetadata,
  formatTokenUsage,
  formatSidechainStart,
  formatSidechainEnd,
  getRoleLabel,
  findToolResult,
  formatUserMessage,
  formatToolInput,
  formatToolResultContent
} from './read.js';

interface ConversationMessage {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  type: 'user' | 'assistant';
  isSidechain: boolean;
  sessionId?: string;
  gitBranch?: string;
  cwd?: string;
  version?: string;
  message: {
    role: string;
    content: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: any }>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  toolUseResult?: Array<{ type: string; text: string }> | string;
}

describe('read.ts', () => {
  let db: Database;
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary database for testing
    dbPath = join(tmpdir(), `test-read-${Date.now()}.db`);
    db = new Database(dbPath);

    // Create temp directory for JSONL files
    tempDir = join(tmpdir(), `test-read-jsonl-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (existsSync(dbPath)) {
      // Use rmSync instead of unlinkSync for directories
      rmSync(dbPath, { force: true });
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const createMessage = (overrides: any = {}): string => {
    const defaults = {
      uuid: 'msg-123',
      parentUuid: null,
      timestamp: '2024-01-01T12:00:00.000Z',
      type: 'user',
      isSidechain: false,
      sessionId: 'session-456',
      gitBranch: 'main',
      cwd: '/project',
      version: '1.0.0',
      message: {
        role: 'user',
        content: 'Hello, world!'
      }
    };
    return JSON.stringify({ ...defaults, ...overrides });
  };

  describe('readConversation()', () => {
    test('returns null when path does not exist', () => {
      const result = readConversation( '/nonexistent/path.jsonl');
      expect(result).toBeNull();
    });

    test('requires both startLine and endLine before reading transcript content', () => {
      const jsonlPath = join(tempDir, 'test-requires-range.jsonl');
      const jsonl = [
        createMessage({ type: 'user', message: { role: 'user', content: 'Do not read all of this' } }),
        createMessage({ type: 'assistant', message: { role: 'assistant', content: 'Use a bounded range' } })
      ].join('\n');

      writeFileSync(jsonlPath, jsonl);

      expect(readConversation(jsonlPath)).toBeNull();
      expect(readConversation(jsonlPath, 1)).toBeNull();
      expect(readConversation(jsonlPath, undefined, 2)).toBeNull();
    });

    test('reads from JSONL file with explicit line range', () => {
      const jsonlPath = join(tempDir, 'test-conversation.jsonl');
      const jsonl = [
        createMessage({ type: 'user', message: { role: 'user', content: 'Hello from JSONL!' } }),
        createMessage({
          type: 'assistant',
          message: { role: 'assistant', content: 'Hi from JSONL!' }
        })
      ].join('\n');

      writeFileSync(jsonlPath, jsonl);

      const result = readConversation( jsonlPath, 1, 2);

      expect(result).not.toBeNull();
      expect(result).toContain('# Conversation');
      expect(result).toContain('Hello from JSONL!');
      expect(result).toContain('Hi from JSONL!');
      expect(result).toContain('**Session ID:** session-456');
    });

    test('reads Codex response_item JSONL as non-empty markdown', () => {
      const jsonlPath = join(tempDir, 'codex-conversation.jsonl');
      const jsonl = [
        JSON.stringify({ type: 'session_meta', payload: { id: 'c1', cwd: '/repo' } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run the focused tests' }] } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The focused tests passed' }] } }),
      ].join('\n');

      writeFileSync(jsonlPath, jsonl);

      const result = readConversation(jsonlPath, 1, 3);

      expect(result).not.toBeNull();
      expect(result).not.toBe('');
      expect(result).toContain('Run the focused tests');
      expect(result).toContain('The focused tests passed');
    });

    test('returns fallback content for non-Claude JSONL that has no renderable messages', () => {
      const jsonlPath = join(tempDir, 'non-claude.jsonl');
      const jsonl = JSON.stringify({ type: 'event', message: 'plain event content' });

      writeFileSync(jsonlPath, jsonl);

      const result = readConversation(jsonlPath, 1, 1);

      expect(result).not.toBeNull();
      expect(result).not.toBe('');
      expect(result).toContain('plain event content');
    });

    test('returns null when JSONL file does not exist', () => {
      const result = readConversation( '/nonexistent/file.jsonl');
      expect(result).toBeNull();
    });

    test('uses explicit line range start when reading from JSONL', () => {
      const jsonlPath = join(tempDir, 'test-pagination.jsonl');
      const jsonl = [
        createMessage({ type: 'user', message: { role: 'user', content: 'Message 1' } }),
        createMessage({
          type: 'assistant',
          message: { role: 'assistant', content: 'Response 1' }
        }),
        createMessage({ type: 'user', message: { role: 'user', content: 'Message 2' } }),
        createMessage({
          type: 'assistant',
          message: { role: 'assistant', content: 'Response 2' }
        })
      ].join('\n');

      writeFileSync(jsonlPath, jsonl);

      const result = readConversation( jsonlPath, 3, 4);

      expect(result).toContain('Message 2');
      expect(result).not.toContain('Message 1');
    });

    test('uses explicit line range end when reading from JSONL', () => {
      const jsonlPath = join(tempDir, 'test-pagination.jsonl');
      const jsonl = [
        createMessage({ type: 'user', message: { role: 'user', content: 'Message 1' } }),
        createMessage({
          type: 'assistant',
          message: { role: 'assistant', content: 'Response 1' }
        }),
        createMessage({ type: 'user', message: { role: 'user', content: 'Message 2' } }),
        createMessage({
          type: 'assistant',
          message: { role: 'assistant', content: 'Response 2' }
        })
      ].join('\n');

      writeFileSync(jsonlPath, jsonl);

      const result = readConversation( jsonlPath, 1, 2);

      expect(result).toContain('Message 1');
      expect(result).toContain('Response 1');
      expect(result).not.toContain('Message 2');
    });

    test('respects startLine and endLine when reading from JSONL', () => {
      const jsonlPath = join(tempDir, 'test-pagination.jsonl');
      const jsonl = [
        createMessage({ type: 'user', message: { role: 'user', content: 'Message 1' } }),
        createMessage({
          type: 'assistant',
          message: { role: 'assistant', content: 'Response 1' }
        }),
        createMessage({ type: 'user', message: { role: 'user', content: 'Message 2' } }),
        createMessage({
          type: 'assistant',
          message: { role: 'assistant', content: 'Response 2' }
        }),
        createMessage({ type: 'user', message: { role: 'user', content: 'Message 3' } })
      ].join('\n');

      writeFileSync(jsonlPath, jsonl);

      const result = readConversation( jsonlPath, 3, 4);

      expect(result).not.toContain('Message 1');
      expect(result).toContain('Message 2');
      expect(result).toContain('Response 2');
      expect(result).not.toContain('Message 3');
    });

    test('formats tool use and results when reading from JSONL', () => {
      const jsonlPath = join(tempDir, 'test-tool.jsonl');
      const jsonl = [
        createMessage({ type: 'user', message: { role: 'user', content: 'Read file' } }),
        createMessage({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will read it' },
              {
                type: 'tool_use',
                id: 'tool-123',
                name: 'read_file',
                input: { file_path: '/path/to/file.txt' }
              }
            ]
          }
        })
      ].join('\n');

      writeFileSync(jsonlPath, jsonl);

      const result = readConversation( jsonlPath, 1, 2);

      expect(result).toContain('**Tool Use:** `read_file`');
      expect(result).toContain('**file_path:**');
      expect(result).toContain('/path/to/file.txt');
    });

    test('handles sidechain messages when reading from JSONL', () => {
      const jsonlPath = join(tempDir, 'test-sidechain.jsonl');
      const jsonl = [
        createMessage({
          type: 'user',
          isSidechain: true,
          message: { role: 'user', content: 'Sidechain user' }
        }),
        createMessage({
          type: 'assistant',
          isSidechain: true,
          message: { role: 'assistant', content: 'Sidechain agent' }
        })
      ].join('\n');

      writeFileSync(jsonlPath, jsonl);

      const result = readConversation( jsonlPath, 1, 2);

      expect(result).toContain('🔀 SIDECHAIN START');
      expect(result).toContain('🔀 SIDECHAIN END');
    });
  });

  describe('formatConversationAsMarkdown()', () => {
    test('formats simple user/assistant conversation', () => {
      const jsonl = [
        createMessage({ type: 'user', message: { role: 'user', content: 'Hello' } }),
        createMessage({
          type: 'assistant',
          message: { role: 'assistant', content: 'Hi there!' }
        })
      ].join('\n');

      const result = formatConversationAsMarkdown(jsonl);

      expect(result).toContain('# Conversation');
      expect(result).toContain('## Metadata');
      expect(result).toContain('**Session ID:** session-456');
      expect(result).toContain('**Git Branch:** main');
      expect(result).toContain('**Working Directory:** /project');
      expect(result).toContain('**Claude Code Version:** 1.0.0');
      expect(result).toContain('## Messages');
      expect(result).toContain('### **User**');
      expect(result).toContain('Hello');
      expect(result).toContain('### **Agent**');
      expect(result).toContain('Hi there!');
    });

    test('omits message UUID and token usage from rendered output', () => {
      const jsonl = [
        createMessage({ type: 'user', message: { role: 'user', content: 'Hello' } }),
        createMessage({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'Hi there!',
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80 },
          },
        }),
      ].join('\n');

      const result = formatConversationAsMarkdown(jsonl);

      expect(result).not.toContain('{#');
      expect(result).not.toContain('cache read:');
      expect(result).not.toContain('_in:');
    });

    test('handles line range with 1-indexed line numbers', () => {
      const jsonl = [
        createMessage({ type: 'user', message: { role: 'user', content: 'Message 1' } }),
        createMessage({
          type: 'assistant',
          message: { role: 'assistant', content: 'Response 1' }
        }),
        createMessage({ type: 'user', message: { role: 'user', content: 'Message 2' } }),
        createMessage({
          type: 'assistant',
          message: { role: 'assistant', content: 'Response 2' }
        })
      ].join('\n');

      // startLine=3 should return from line 3 onwards (1-indexed)
      const result = formatConversationAsMarkdown(jsonl, 3);

      expect(result).toContain('Message 2');
      expect(result).not.toContain('Message 1');
    });

    test('handles empty input', () => {
      const result = formatConversationAsMarkdown('');
      expect(result).toBe('');
    });

    test('filters out system messages', () => {
      const jsonl = [
        createMessage({ type: 'system', message: { role: 'system', content: 'System msg' } }),
        createMessage({ type: 'user', message: { role: 'user', content: 'Hello' } }),
        createMessage({
          type: 'assistant',
          message: { role: 'assistant', content: 'Hi!' }
        })
      ].join('\n');

      const result = formatConversationAsMarkdown(jsonl);

      expect(result).not.toContain('System msg');
      expect(result).toContain('Hello');
    });

    test('groups sidechain content with markers', () => {
      const jsonl = [
        createMessage({
          type: 'user',
          message: { role: 'user', content: 'Main message' }
        }),
        createMessage({
          type: 'assistant',
          message: { role: 'assistant', content: 'Main response' }
        }),
        createMessage({
          type: 'user',
          isSidechain: true,
          message: { role: 'user', content: 'Sidechain user' }
        }),
        createMessage({
          type: 'assistant',
          isSidechain: true,
          message: { role: 'assistant', content: 'Sidechain agent' }
        }),
        createMessage({
          type: 'user',
          message: { role: 'user', content: 'Back to main' }
        })
      ].join('\n');

      const result = formatConversationAsMarkdown(jsonl);

      expect(result).toContain('🔀 SIDECHAIN START');
      expect(result).toContain('🔀 SIDECHAIN END');
      expect(result).toContain('Sidechain user');
      expect(result).toContain('Sidechain agent');
    });
  });
});

describe('filterValidMessages()', () => {
  const createMsg = (overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
    uuid: 'msg-1',
    parentUuid: null,
    timestamp: '2024-01-01T00:00:00Z',
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content: 'Hello' },
    ...overrides
  });

  test('keeps user and assistant messages', () => {
    const messages = [
      createMsg({ type: 'user' }),
      createMsg({ type: 'assistant' })
    ];

    const result = filterValidMessages(messages);

    expect(result).toHaveLength(2);
  });

  test('filters out system messages', () => {
    const messages = [
      createMsg({ type: 'system' as any }),
      createMsg({ type: 'user' })
    ];

    const result = filterValidMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('user');
  });

  test('filters out messages without timestamp', () => {
    const messages = [
      createMsg({ timestamp: '' as any }),
      createMsg({ type: 'user' })
    ];

    const result = filterValidMessages(messages);

    expect(result).toHaveLength(1);
  });

  test('keeps assistant messages with only usage info', () => {
    const messages = [
      createMsg({
        type: 'assistant',
        message: { role: 'assistant', content: '', usage: { input_tokens: 10, output_tokens: 5 } }
      })
    ];

    const result = filterValidMessages(messages);

    expect(result).toHaveLength(1);
  });

  test('filters out messages with empty content array', () => {
    const messages = [
      createMsg({
        type: 'user',
        message: { role: 'user', content: [] }
      })
    ];

    const result = filterValidMessages(messages);

    expect(result).toHaveLength(0);
  });
});

describe('formatTokenUsage()', () => {
  test('formats basic usage', () => {
    const usage = { input_tokens: 100, output_tokens: 50 };

    const result = formatTokenUsage(usage);

    expect(result).toContain('in: 100');
    expect(result).toContain('out: 50');
  });

  test('formats cache read tokens', () => {
    const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80 };

    const result = formatTokenUsage(usage);

    expect(result).toContain('cache read: 80');
  });

  test('formats cache creation tokens', () => {
    const usage = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20 };

    const result = formatTokenUsage(usage);

    expect(result).toContain('cache create: 20');
  });

  test('formats all token types together', () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 200
    };

    const result = formatTokenUsage(usage);

    expect(result).toContain('in: 1,000');
    expect(result).toContain('cache read: 800');
    expect(result).toContain('cache create: 200');
    expect(result).toContain('out: 500');
  });
});

describe('formatSidechainStart()', () => {
  test('returns sidechain start marker', () => {
    const result = formatSidechainStart();

    expect(result).toContain('SIDECHAIN START');
    expect(result).toContain('---');
  });
});

describe('formatSidechainEnd()', () => {
  test('returns sidechain end marker', () => {
    const result = formatSidechainEnd();

    expect(result).toContain('SIDECHAIN END');
    expect(result).toContain('---');
  });
});

describe('getRoleLabel()', () => {
  test('returns User for non-sidechain user message', () => {
    const result = getRoleLabel('user', false);
    expect(result).toBe('User');
  });

  test('returns Agent for non-sidechain assistant message', () => {
    const result = getRoleLabel('assistant', false);
    expect(result).toBe('Agent');
  });

  test('returns Agent for sidechain user message', () => {
    const result = getRoleLabel('user', true);
    expect(result).toBe('Agent');
  });

  test('returns Subagent for sidechain assistant message', () => {
    const result = getRoleLabel('assistant', true);
    expect(result).toBe('Subagent');
  });
});

describe('formatToolInput()', () => {
  test('formats simple string value', () => {
    const input = { file_path: '/path/to/file.txt' };

    const result = formatToolInput(input);

    expect(result).toContain('**file_path:** /path/to/file.txt');
  });

  test('formats multiline string in code block', () => {
    const input = { code: 'line 1\nline 2\nline 3' };

    const result = formatToolInput(input);

    expect(result).toContain('**code:**');
    expect(result).toContain('```');
    expect(result).toContain('line 1');
  });

  test('formats object value as JSON', () => {
    const input = { options: { verbose: true, count: 5 } };

    const result = formatToolInput(input);

    expect(result).toContain('**options:**');
    expect(result).toContain('```json');
    expect(result).toContain('"verbose"');
  });

  test('returns empty string for empty input', () => {
    const result = formatToolInput({});

    expect(result).toBe('\n');
  });
});

describe('formatToolResultContent()', () => {
  test('formats short single-line content inline', () => {
    const result = formatToolResultContent('Short result');

    expect(result).toBe('Short result\n\n');
  });

  test('formats long content in code block', () => {
    const longContent = 'A'.repeat(150);

    const result = formatToolResultContent(longContent);

    expect(result).toContain('```');
    expect(result).toContain(longContent);
  });

  test('formats multiline content in code block', () => {
    const multiline = 'Line 1\nLine 2\nLine 3';

    const result = formatToolResultContent(multiline);

    expect(result).toContain('```');
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
  });

  test('formats array content as JSON', () => {
    const content = [{ foo: 'bar' }, { baz: 'qux' }];

    const result = formatToolResultContent(content);

    expect(result).toContain('```json');
    expect(result).toContain('"foo"');
  });
});

describe('findToolResult()', () => {
  const createMsg = (overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
    uuid: 'msg-1',
    parentUuid: null,
    timestamp: '2024-01-01T00:00:00Z',
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content: 'Hello' },
    ...overrides
  });

  test('finds tool result by tool_use_id', () => {
    const messages: ConversationMessage[] = [
      createMsg({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-123', name: 'read', input: {} }]
        }
      }),
      createMsg({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Some text' },
            { type: 'tool_result', tool_use_id: 'tool-123', content: 'File contents' } as any
          ]
        }
      })
    ];

    const result = findToolResult(messages, 0, 'tool-123');

    expect(result).not.toBeNull();
    expect((result as any).content).toBe('File contents');
  });

  test('returns null when tool result not found', () => {
    const messages: ConversationMessage[] = [
      createMsg({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-123', name: 'read', input: {} }]
        }
      })
    ];

    const result = findToolResult(messages, 0, 'tool-123');

    expect(result).toBeNull();
  });

  test('only searches within 6 messages ahead', () => {
    const messages: ConversationMessage[] = [
      createMsg({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-123', name: 'read', input: {} }]
        }
      }),
      ...Array(6).fill(null).map((_, i) =>
        createMsg({ uuid: `msg-${i}`, type: 'user', message: { role: 'user', content: `msg ${i}` } })
      ),
      createMsg({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-123', content: 'Too far' } as any]
        }
      })
    ];

    const result = findToolResult(messages, 0, 'tool-123');

    expect(result).toBeNull();
  });
});

describe('formatUserMessage()', () => {
  const createMsg = (overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
    uuid: 'msg-1',
    parentUuid: null,
    timestamp: '2024-01-01T00:00:00Z',
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content: 'Hello' },
    ...overrides
  });

  test('formats string content', () => {
    const msg = createMsg({ message: { role: 'user', content: 'Hello world' } });

    const result = formatUserMessage(msg);

    expect(result).toBe('Hello world\n\n');
  });

  test('formats text blocks from array content', () => {
    const msg = createMsg({
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'First part' },
          { type: 'text', text: 'Second part' }
        ]
      }
    });

    const result = formatUserMessage(msg);

    expect(result).toContain('First part');
    expect(result).toContain('Second part');
  });

  test('formats toolUseResult string', () => {
    const msg = createMsg({
      toolUseResult: 'Tool result here',
      message: { role: 'user', content: '' }
    });

    const result = formatUserMessage(msg);

    expect(result).toContain('**Tool Result:**');
    expect(result).toContain('Tool result here');
  });

  test('formats toolUseResult array', () => {
    const msg = createMsg({
      toolUseResult: [{ type: 'text', text: 'Result 1' }, { type: 'text', text: 'Result 2' }],
      message: { role: 'user', content: '' }
    });

    const result = formatUserMessage(msg);

    expect(result).toContain('Result 1');
    expect(result).toContain('Result 2');
  });
});

describe('parseJsonlMessages()', () => {
  test('parses valid JSONL into messages array', () => {
    const jsonl = [
      JSON.stringify({ uuid: '1', type: 'user', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: 'Hello' } }),
      JSON.stringify({ uuid: '2', type: 'assistant', timestamp: '2024-01-01T00:00:01Z', message: { role: 'assistant', content: 'Hi' } })
    ].join('\n');

    const result = parseJsonlMessages(jsonl);

    expect(result).toHaveLength(2);
    expect(result[0].uuid).toBe('1');
    expect(result[1].uuid).toBe('2');
  });

  test('filters out empty lines', () => {
    const jsonl = [
      JSON.stringify({ uuid: '1', type: 'user', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: 'Hello' } }),
      '',
      '   ',
      JSON.stringify({ uuid: '2', type: 'assistant', timestamp: '2024-01-01T00:00:01Z', message: { role: 'assistant', content: 'Hi' } })
    ].join('\n');

    const result = parseJsonlMessages(jsonl);

    expect(result).toHaveLength(2);
  });

  test('applies line range with 1-indexed line numbers', () => {
    const jsonl = [
      JSON.stringify({ uuid: '1', type: 'user', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: 'A' } }),
      JSON.stringify({ uuid: '2', type: 'assistant', timestamp: '2024-01-01T00:00:01Z', message: { role: 'assistant', content: 'B' } }),
      JSON.stringify({ uuid: '3', type: 'user', timestamp: '2024-01-01T00:00:02Z', message: { role: 'user', content: 'C' } })
    ].join('\n');

    const result = parseJsonlMessages(jsonl, 2, 3);

    expect(result).toHaveLength(2);
    expect(result[0].uuid).toBe('2');
    expect(result[1].uuid).toBe('3');
  });
});

describe('formatMetadata()', () => {
  const createMsg = (overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
    uuid: 'msg-1',
    parentUuid: null,
    timestamp: '2024-01-01T00:00:00Z',
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content: 'Hello' },
    ...overrides
  });

  test('formats all metadata fields', () => {
    const msg = createMsg({
      sessionId: 'session-123',
      gitBranch: 'feature-branch',
      cwd: '/home/user/project',
      version: '2.0.0'
    });

    const result = formatMetadata(msg);

    expect(result).toContain('## Metadata');
    expect(result).toContain('**Session ID:** session-123');
    expect(result).toContain('**Git Branch:** feature-branch');
    expect(result).toContain('**Working Directory:** /home/user/project');
    expect(result).toContain('**Claude Code Version:** 2.0.0');
  });

  test('omits missing metadata fields', () => {
    const msg = createMsg({
      sessionId: 'session-123'
    });

    const result = formatMetadata(msg);

    expect(result).toContain('**Session ID:** session-123');
    expect(result).not.toContain('**Git Branch:**');
    expect(result).not.toContain('**Working Directory:**');
    expect(result).not.toContain('**Claude Code Version:**');
  });

  test('returns header only when no metadata present', () => {
    const msg = createMsg();

    const result = formatMetadata(msg);

    expect(result).toBe('## Metadata\n\n---\n\n');
  });
});
