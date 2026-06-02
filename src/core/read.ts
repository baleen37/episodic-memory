/**
 * Read tool for Layer 3 of progressive disclosure - reading raw conversation transcripts.
 *
 * This module provides functions to read conversation data from JSONL files.
 * In V3, raw conversation data is stored directly in JSONL files, not in the database.
 *
 * The read tool supports startLine/endLine pagination for large conversations
 * using 1-indexed line numbers as per spec.
 */

import * as fs from 'fs';

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
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  toolUseResult?: Array<{ type: string; text: string }> | string;
}

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
  return selectJsonlLines(jsonl, startLine, endLine).flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function selectJsonlLines(jsonl: string, startLine?: number, endLine?: number): string[] {
  const allLines = jsonl.trim().split('\n').filter(line => line.trim());

  return startLine !== undefined || endLine !== undefined
    ? allLines.slice(
        startLine !== undefined ? startLine - 1 : 0,
        endLine !== undefined ? endLine : undefined
      )
    : allLines;
}

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

/**
 * Read conversation from JSONL file.
 *
 * In V3, conversations are read directly from JSONL files.
 * The database is not used for storing raw conversation data.
 *
 * @param path - Path to JSONL file
 * @param startLine - Starting line number (1-indexed, inclusive)
 * @param endLine - Ending line number (1-indexed, inclusive)
 * @returns Markdown formatted conversation or null if not found
 */
export function readConversation(
  path: string,
  startLine?: number,
  endLine?: number
): string | null {
  // Check if file exists
  if (!fs.existsSync(path)) {
    return null;
  }

  // Always require an explicit bounded line range before reading transcript content.
  if (startLine === undefined || endLine === undefined) {
    return null;
  }

  // Read and format JSONL file
  const jsonlContent = fs.readFileSync(path, 'utf-8');
  return formatConversationAsMarkdown(jsonlContent, startLine, endLine);
}

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
    return formatNonClaudeJsonlFallback(selectJsonlLines(jsonl, startLine, endLine));
  }

  // Build output using extracted functions
  let output = '# Conversation\n\n';
  output += formatMetadata(messages[0]);
  output += '## Messages\n\n';

  let inSidechain = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const timestamp = new Date(msg.timestamp).toLocaleString();

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
    output += `### **${roleLabel}** (${timestamp})\n\n`;

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

/**
 * Format assistant message content including tool uses.
 *
 * @param messages - All messages (for tool result lookup)
 * @param index - Current message index
 * @param msg - Assistant message to format
 * @returns Markdown formatted message content
 */
function formatNonClaudeJsonlFallback(lines: string[]): string {
  const renderedLines = lines.flatMap((line, index) => {
    try {
      const record = JSON.parse(line);
      const codexMessage = formatCodexResponseItem(record, index);
      if (codexMessage) return [codexMessage];
      return ['```json\n' + JSON.stringify(record, null, 2) + '\n```'];
    } catch {
      return [line];
    }
  });

  if (renderedLines.length === 0) {
    return '';
  }

  return '# Conversation\n\n## Messages\n\n' + renderedLines.join('\n\n') + '\n';
}

function formatCodexResponseItem(record: any, index: number): string | null {
  if (record?.type !== 'response_item' || record.payload?.type !== 'message') {
    return null;
  }

  const role = record.payload.role === 'assistant' ? 'Agent' : 'User';
  const text = extractCodexMessageText(record.payload.content);
  if (!text) {
    return null;
  }

  return `### **${role}** {#codex-${index + 1}}\n\n${text}\n`;
}

function extractCodexMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map(block => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object' && 'text' in block && typeof (block as any).text === 'string') {
        return (block as any).text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

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

  return output;
}
