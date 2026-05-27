import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ParsedExchange, ParseContext, SourceAdapter, ToolCallRecord } from './types.js';

type JsonObject = Record<string, unknown>;

interface PendingClaudeExchange {
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  sourceKind: string;
  sessionId: string | null;
  project: string | null;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  provider: string | null;
  metadataJson: string | null;
  timestamp: number | null;
  userText: string;
  assistantTexts: string[];
  toolCalls: ToolCallRecord[];
}

export function parseClaudeJsonl(content: string, context: ParseContext): ParsedExchange[] {
  const exchanges: ParsedExchange[] = [];
  let current: PendingClaudeExchange | null = null;

  const flushCurrent = () => {
    if (!current) return;

    const assistantText = current.assistantTexts.join('\n').trim();
    if (!assistantText) {
      current = null;
      return;
    }

    exchanges.push({
      archivePath: current.archivePath,
      lineStart: current.lineStart,
      lineEnd: current.lineEnd,
      sourceKind: current.sourceKind,
      sessionId: current.sessionId,
      project: current.project,
      cwd: current.cwd,
      gitBranch: current.gitBranch,
      model: current.model,
      provider: current.provider,
      metadataJson: current.metadataJson,
      timestamp: current.timestamp,
      userText: current.userText,
      assistantText,
      embeddingText: [current.userText, assistantText].filter(Boolean).join('\n'),
      toolCalls: current.toolCalls,
    });
    current = null;
  };

  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;

    const item = parseJsonObject(line);
    if (!item) continue;

    const lineNumber = index + 1;
    const message = asObject(item.message);
    const role = asString(message?.role) ?? asString(item.type);
    const messageContent = message && 'content' in message ? message.content : undefined;

    if (role === 'user') {
      flushCurrent();
      const userText = extractText(messageContent).trim();
      current = {
        archivePath: context.archivePath,
        lineStart: lineNumber,
        lineEnd: lineNumber,
        sourceKind: context.sourceKind,
        sessionId: asString(item.sessionId),
        project: null,
        cwd: asString(item.cwd),
        gitBranch: asString(item.gitBranch),
        model: asString(item.model),
        provider: asString(item.provider),
        metadataJson: null,
        timestamp: parseTimestamp(item.timestamp),
        userText,
        assistantTexts: [],
        toolCalls: [],
      };
      continue;
    }

    if (!current) continue;

    current.lineEnd = lineNumber;
    current.sessionId ??= asString(item.sessionId);
    current.cwd ??= asString(item.cwd);
    current.gitBranch ??= asString(item.gitBranch);
    current.model ??= asString(item.model);
    current.provider ??= asString(item.provider);

    if (role === 'assistant') {
      const text = extractText(messageContent).trim();
      if (text) current.assistantTexts.push(text);
      current.toolCalls.push(...extractToolCalls(messageContent));
    }
  }

  flushCurrent();
  return exchanges;
}

export function createClaudeProjectsAdapter(): SourceAdapter {
  return createClaudeAdapter('claude-projects', 'projects');
}

export function createClaudeTranscriptsAdapter(): SourceAdapter {
  return createClaudeAdapter('claude-transcripts', 'transcripts');
}

function createClaudeAdapter(kind: string, dirname: string): SourceAdapter {
  return {
    kind,
    roots() {
      const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), dirname);
      return existsSync(root) ? [root] : [];
    },
    detect(filePath: string) {
      return filePath.endsWith('.jsonl');
    },
    parse: parseClaudeJsonl,
  };
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';

  return value
    .map(block => {
      const object = asObject(block);
      if (!object) return '';
      if (typeof object.text === 'string') return object.text;
      if (typeof object.content === 'string') return object.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractToolCalls(value: unknown): ToolCallRecord[] {
  if (!Array.isArray(value)) return [];

  const calls: ToolCallRecord[] = [];
  for (const block of value) {
    const object = asObject(block);
    if (!object) continue;

    if (object.type === 'tool_use') {
      calls.push({
        toolName: asString(object.name),
        callId: asString(object.id),
        input: stringifyValue(object.input),
        output: null,
        status: null,
      });
      continue;
    }

    if (object.type === 'tool_result') {
      const callId = asString(object.tool_use_id);
      const existing = calls.find(call => call.callId === callId && call.output === null);
      const output = stringifyValue(object.content);
      const status = object.is_error === true ? 'error' : 'success';
      if (existing) {
        existing.output = output;
        existing.status = status;
      } else {
        calls.push({ toolName: null, callId, input: null, output, status });
      }
    }
  }

  return calls;
}

function parseJsonObject(line: string): JsonObject | null {
  try {
    return asObject(JSON.parse(line));
  } catch {
    return null;
  }
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function stringifyValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
