# read.ts Refactoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor `formatConversationAsMarkdown` from a 199-line monolithic function into small, testable, single-responsibility functions.

**Architecture:** Extract parsing, filtering, and formatting into separate pure functions. Keep the main `formatConversationAsMarkdown` as an orchestrator that composes these functions. This reduces cognitive load and makes each piece independently testable.

**Tech Stack:** TypeScript, Vitest, Node.js

---

## Task 1: Extract JSONL Parsing Function

**Files:**
- Modify: `src/core/read.ts`
- Test: `src/core/read.test.ts`

**Step 1: Write the failing test**

Add to `src/core/read.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npm test src/core/read.test.ts`
Expected: FAIL - `parseJsonlMessages is not defined`

**Step 3: Write minimal implementation**

Add to `src/core/read.ts` (before `formatConversationAsMarkdown`):

```typescript
/**
 * Parse JSONL string into array of conversation messages.
 * Optionally filters by line range (1-indexed, inclusive).
 *
 * @param jsonl - JSONL string containing conversation messages
 * @param startLine - Starting line number (1-indexed, inclusive)
 * @param endLine - Ending line number (1-indexed, inclusive)
 * @returns Array of parsed messages
 */
export function parseJsonlMessages(
  jsonl: string,
  startLine?: number,
  endLine?: number
): ConversationMessage[] {
  const allLines = jsonl.trim().split('\n').filter(line => line.trim());

  const lines = startLine !== undefined || endLine !== undefined
    ? allLines.slice(
        startLine !== undefined ? startLine - 1 : 0,
        endLine !== undefined ? endLine : undefined
      )
    : allLines;

  return lines.map(line => JSON.parse(line));
}
```

**Step 4: Run test to verify it passes**

Run: `npm test src/core/read.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/read.ts src/core/read.test.ts
git commit -m "refactor(read): extract parseJsonlMessages function"
```

---

## Task 2: Extract Message Filtering Function

**Files:**
- Modify: `src/core/read.ts`
- Test: `src/core/read.test.ts`

**Step 1: Write the failing test**

Add to `src/core/read.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npm test src/core/read.test.ts`
Expected: FAIL - `filterValidMessages is not defined`

**Step 3: Write minimal implementation**

Add to `src/core/read.ts` (after `parseJsonlMessages`):

```typescript
/**
 * Filter out invalid messages (system, no timestamp, no content).
 * Keeps assistant messages that have usage info even without content.
 *
 * @param messages - Array of conversation messages
 * @returns Filtered array of valid messages
 */
export function filterValidMessages(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.filter(msg => {
    if (msg.type !== 'user' && msg.type !== 'assistant') return false;
    if (!msg.timestamp) return false;
    if (!msg.message || !msg.message.content) {
      if (msg.type === 'assistant' && msg.message?.usage) return true;
      return false;
    }
    if (Array.isArray(msg.message.content) && msg.message.content.length === 0) {
      if (msg.type === 'assistant' && msg.message?.usage) return true;
      return false;
    }
    return true;
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npm test src/core/read.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/read.ts src/core/read.test.ts
git commit -m "refactor(read): extract filterValidMessages function"
```

---

## Task 3: Extract Metadata Formatting Function

**Files:**
- Modify: `src/core/read.ts`
- Test: `src/core/read.test.ts`

**Step 1: Write the failing test**

Add to `src/core/read.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npm test src/core/read.test.ts`
Expected: FAIL - `formatMetadata is not defined`

**Step 3: Write minimal implementation**

Add to `src/core/read.ts` (after `filterValidMessages`):

```typescript
/**
 * Format conversation metadata from first message.
 *
 * @param firstMessage - First message in conversation
 * @returns Markdown formatted metadata section
 */
export function formatMetadata(firstMessage: ConversationMessage): string {
  let output = '## Metadata\n\n';

  if (firstMessage.sessionId) {
    output += `**Session ID:** ${firstMessage.sessionId}\n\n`;
  }
  if (firstMessage.gitBranch) {
    output += `**Git Branch:** ${firstMessage.gitBranch}\n\n`;
  }
  if (firstMessage.cwd) {
    output += `**Working Directory:** ${firstMessage.cwd}\n\n`;
  }
  if (firstMessage.version) {
    output += `**Claude Code Version:** ${firstMessage.version}\n\n`;
  }

  output += '---\n\n';
  return output;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test src/core/read.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/read.ts src/core/read.test.ts
git commit -m "refactor(read): extract formatMetadata function"
```

---

## Task 4: Extract Sidechain Formatting Functions

**Files:**
- Modify: `src/core/read.ts`
- Test: `src/core/read.test.ts`

**Step 1: Write the failing test**

Add to `src/core/read.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npm test src/core/read.test.ts`
Expected: FAIL - functions are not defined

**Step 3: Write minimal implementation**

Add to `src/core/read.ts` (after `formatMetadata`):

```typescript
/**
 * Format sidechain start marker.
 *
 * @returns Markdown formatted sidechain start
 */
export function formatSidechainStart(): string {
  return '\n---\n**🔀 SIDECHAIN START**\n---\n\n';
}

/**
 * Format sidechain end marker.
 *
 * @returns Markdown formatted sidechain end
 */
export function formatSidechainEnd(): string {
  return '\n---\n**🔀 SIDECHAIN END**\n---\n\n';
}

/**
 * Get role label based on message type and sidechain status.
 *
 * @param type - Message type (user or assistant)
 * @param isSidechain - Whether message is in sidechain
 * @returns Human-readable role label
 */
export function getRoleLabel(type: 'user' | 'assistant', isSidechain: boolean): string {
  if (isSidechain) {
    return type === 'user' ? 'Agent' : 'Subagent';
  }
  return type === 'user' ? 'User' : 'Agent';
}
```

**Step 4: Run test to verify it passes**

Run: `npm test src/core/read.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/read.ts src/core/read.test.ts
git commit -m "refactor(read): extract sidechain formatting functions"
```

---

## Task 5: Extract Tool Result Lookup Function

**Files:**
- Modify: `src/core/read.ts`
- Test: `src/core/read.test.ts`

**Step 1: Write the failing test**

Add to `src/core/read.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npm test src/core/read.test.ts`
Expected: FAIL - `findToolResult is not defined`

**Step 3: Write minimal implementation**

Add to `src/core/read.ts` (after `getRoleLabel`):

```typescript
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | any[];
}

/**
 * Find tool result in messages following a tool use.
 * Searches up to 6 messages ahead for matching tool_use_id.
 *
 * @param messages - All conversation messages
 * @param toolUseIndex - Index of the message containing tool use
 * @param toolUseId - ID of the tool use to match
 * @returns Tool result block or null if not found
 */
export function findToolResult(
  messages: ConversationMessage[],
  toolUseIndex: number,
  toolUseId: string
): ToolResultBlock | null {
  for (let j = toolUseIndex + 1; j < Math.min(toolUseIndex + 6, messages.length); j++) {
    const laterMsg = messages[j];
    if (laterMsg.type === 'user' && Array.isArray(laterMsg.message.content)) {
      for (const resultBlock of laterMsg.message.content) {
        if (resultBlock.type === 'tool_result' && (resultBlock as any).tool_use_id === toolUseId) {
          return resultBlock as ToolResultBlock;
        }
      }
    }
  }
  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test src/core/read.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/read.ts src/core/read.test.ts
git commit -m "refactor(read): extract findToolResult function"
```

---

## Task 6: Extract Tool Result Formatting Function

**Files:**
- Modify: `src/core/read.ts`
- Test: `src/core/read.test.ts`

**Step 1: Write the failing test**

Add to `src/core/read.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npm test src/core/read.test.ts`
Expected: FAIL - `formatToolResultContent is not defined`

**Step 3: Write minimal implementation**

Add to `src/core/read.ts` (after `findToolResult`):

```typescript
/**
 * Format tool result content for display.
 *
 * @param content - Tool result content (string or array)
 * @returns Markdown formatted result
 */
export function formatToolResultContent(content: string | any[]): string {
  if (typeof content === 'string') {
    if (content.includes('\n') || content.length > 100) {
      return '```\n' + content + '\n```\n\n';
    }
    return `${content}\n\n`;
  }

  if (Array.isArray(content)) {
    return '```json\n' + JSON.stringify(content, null, 2) + '\n```\n\n';
  }

  return '';
}
```

**Step 4: Run test to verify it passes**

Run: `npm test src/core/read.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/read.ts src/core/read.test.ts
git commit -m "refactor(read): extract formatToolResultContent function"
```

---

## Task 7: Extract Token Usage Formatting Function

**Files:**
- Modify: `src/core/read.ts`
- Test: `src/core/read.test.ts`

**Step 1: Write the failing test**

Add to `src/core/read.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npm test src/core/read.test.ts`
Expected: FAIL - `formatTokenUsage is not defined`

**Step 3: Write minimal implementation**

Add to `src/core/read.ts` (after `formatToolResultContent`):

```typescript
/**
 * Format token usage information.
 *
 * @param usage - Token usage object
 * @returns Markdown formatted usage string
 */
export function formatTokenUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): string {
  let output = `_in: ${(usage.input_tokens || 0).toLocaleString()}`;

  if (usage.cache_read_input_tokens) {
    output += ` | cache read: ${usage.cache_read_input_tokens.toLocaleString()}`;
  }
  if (usage.cache_creation_input_tokens) {
    output += ` | cache create: ${usage.cache_creation_input_tokens.toLocaleString()}`;
  }

  output += ` | out: ${(usage.output_tokens || 0).toLocaleString()}_\n\n`;
  return output;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test src/core/read.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/read.ts src/core/read.test.ts
git commit -m "refactor(read): extract formatTokenUsage function"
```

---

## Task 8: Extract User Message Formatting Function

**Files:**
- Modify: `src/core/read.ts`
- Test: `src/core/read.test.ts`

**Step 1: Write the failing test**

Add to `src/core/read.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npm test src/core/read.test.ts`
Expected: FAIL - `formatUserMessage is not defined`

**Step 3: Write minimal implementation**

Add to `src/core/read.ts` (after `formatTokenUsage`):

```typescript
/**
 * Format user message content.
 *
 * @param msg - User message to format
 * @returns Markdown formatted message content
 */
export function formatUserMessage(msg: ConversationMessage): string {
  let output = '';

  // Handle tool results
  if (msg.toolUseResult) {
    output += '**Tool Result:**\n\n';
    if (typeof msg.toolUseResult === 'string') {
      output += `${msg.toolUseResult}\n\n`;
    } else if (Array.isArray(msg.toolUseResult)) {
      for (const result of msg.toolUseResult) {
        output += `${(result as any).text || String(result)}\n\n`;
      }
    }
    return output;
  }

  // Handle regular content
  if (typeof msg.message.content === 'string') {
    output += `${msg.message.content}\n\n`;
  } else if (Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) {
        output += `${block.text}\n\n`;
      }
    }
  }

  return output;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test src/core/read.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/read.ts src/core/read.test.ts
git commit -m "refactor(read): extract formatUserMessage function"
```

---

## Task 9: Extract Tool Input Formatting Function

**Files:**
- Modify: `src/core/read.ts`
- Test: `src/core/read.test.ts`

**Step 1: Write the failing test**

Add to `src/core/read.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npm test src/core/read.test.ts`
Expected: FAIL - `formatToolInput is not defined`

**Step 3: Write minimal implementation**

Add to `src/core/read.ts` (after `formatUserMessage`):

```typescript
/**
 * Format tool input parameters.
 *
 * @param input - Tool input object
 * @returns Markdown formatted input parameters
 */
export function formatToolInput(input: Record<string, any>): string {
  let output = '';

  if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && value.includes('\n')) {
        output += `- **${key}:**\n\`\`\`\n${value}\n\`\`\`\n`;
      } else if (typeof value === 'string') {
        output += `- **${key}:** ${value}\n`;
      } else {
        output += `- **${key}:**\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
      }
    }
    output += '\n';
  }

  return output;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test src/core/read.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/read.ts src/core/read.test.ts
git commit -m "refactor(read): extract formatToolInput function"
```

---

## Task 10: Refactor formatConversationAsMarkdown to Use Extracted Functions

**Files:**
- Modify: `src/core/read.ts`

**Step 1: Verify all tests still pass before refactor**

Run: `npm test src/core/read.test.ts`
Expected: All tests PASS

**Step 2: Refactor formatConversationAsMarkdown**

Replace the existing `formatConversationAsMarkdown` function with:

```typescript
/**
 * Format JSONL conversation as markdown.
 *
 * @param jsonl - JSONL string containing conversation messages
 * @param startLine - Starting line number (1-indexed, inclusive)
 * @param endLine - Ending line number (1-indexed, inclusive)
 * @returns Markdown formatted conversation
 */
export function formatConversationAsMarkdown(
  jsonl: string,
  startLine?: number,
  endLine?: number
): string {
  // Parse and filter messages using extracted functions
  const allMessages = parseJsonlMessages(jsonl, startLine, endLine);
  const messages = filterValidMessages(allMessages);

  if (messages.length === 0) {
    return '';
  }

  // Build output using extracted functions
  let output = '# Conversation\n\n';
  output += formatMetadata(messages[0]);
  output += '## Messages\n\n';

  let inSidechain = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const timestamp = new Date(msg.timestamp).toLocaleString();
    const messageId = msg.uuid || `msg-${i}`;

    // Skip user messages that are just tool results
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      const hasOnlyToolResults = msg.message.content.every(block => block.type === 'tool_result');
      if (hasOnlyToolResults) {
        continue;
      }
    }

    // Handle sidechain grouping
    if (msg.isSidechain && !inSidechain) {
      output += formatSidechainStart();
      inSidechain = true;
    } else if (!msg.isSidechain && inSidechain) {
      output += formatSidechainEnd();
      inSidechain = false;
    }

    // Format message header
    const roleLabel = getRoleLabel(msg.type, msg.isSidechain);
    output += `### **${roleLabel}** (${timestamp}) {#${messageId}}\n\n`;

    // Format message content
    if (msg.type === 'user') {
      output += formatUserMessage(msg);
    } else if (msg.type === 'assistant') {
      output += formatAssistantMessage(messages, i, msg);
    }
  }

  // Close sidechain if still open
  if (inSidechain) {
    output += formatSidechainEnd();
  }

  return output;
}
```

**Step 3: Add formatAssistantMessage helper**

Add after `formatToolInput`:

```typescript
/**
 * Format assistant message content including tool uses.
 *
 * @param messages - All messages (for tool result lookup)
 * @param index - Current message index
 * @param msg - Assistant message to format
 * @returns Markdown formatted message content
 */
function formatAssistantMessage(
  messages: ConversationMessage[],
  index: number,
  msg: ConversationMessage
): string {
  let output = '';
  const content = msg.message.content;

  if (typeof content === 'string') {
    output += `${content}\n\n`;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        output += `${block.text}\n\n`;
      } else if (block.type === 'tool_use') {
        output += `**Tool Use:** \`${block.name}\`\n\n`;
        output += formatToolInput(block.input || {});

        // Look for corresponding tool result
        const toolUseId = (block as any).id;
        if (toolUseId) {
          const result = findToolResult(messages, index, toolUseId);
          if (result) {
            output += '**Result:**\n';
            output += formatToolResultContent(result.content);
          }
        }
      }
    }
  }

  // Add token usage if present
  if (msg.message.usage) {
    output += formatTokenUsage(msg.message.usage);
  }

  return output;
}
```

**Step 4: Run all tests to verify behavior is preserved**

Run: `npm test src/core/read.test.ts`
Expected: All tests PASS (same as before refactor)

**Step 5: Commit**

```bash
git add src/core/read.ts
git commit -m "refactor(read): compose formatConversationAsMarkdown from extracted functions"
```

---

## Task 11: Run Full Test Suite

**Files:**
- None (verification only)

**Step 1: Run all tests**

Run: `npm test`
Expected: All 634 tests PASS

**Step 2: Build the project**

Run: `npm run build`
Expected: Build succeeds without errors

**Step 3: Type check**

Run: `npm run typecheck`
Expected: No TypeScript errors

**Step 4: Final commit if needed**

If any fixes were needed:

```bash
git add -A
git commit -m "fix: address test/build issues from read.ts refactor"
```

---

## Summary

| Metric | Before | After |
|--------|--------|-------|
| `formatConversationAsMarkdown` lines | 199 | ~70 |
| Functions | 2 | 13 |
| Test coverage | Good | Better (new functions tested) |
| Max nesting depth | 4+ | 2 |

The refactored code:
- Each function has a single responsibility
- Each function is independently testable
- The main function orchestrates smaller functions
- Cognitive load is significantly reduced
