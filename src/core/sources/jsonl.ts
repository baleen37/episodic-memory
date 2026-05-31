import type { ToolCallRecord } from './types.js';

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function stringifyValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Iterate JSONL content as (object, lineNumber) pairs. Blank lines and lines
 * that fail to parse into an object are skipped. lineNumber is 1-based.
 */
export function eachJsonLine(content: string, fn: (item: JsonObject, lineNumber: number) => void): void {
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let item: JsonObject | null;
    try {
      item = asObject(JSON.parse(line));
    } catch {
      continue;
    }
    if (item) fn(item, index + 1);
  }
}

/**
 * Attach a tool result to its matching call by callId: fill the first call with
 * the same callId that has no output yet, or push an output-only stub if none.
 */
export function attachToolResult(
  calls: ToolCallRecord[],
  result: { callId: string | null; output: string | null; status: string | null },
): void {
  const existing = calls.find(call => call.callId === result.callId && call.output === null);
  if (existing) {
    existing.output = result.output;
    existing.status = result.status;
  } else {
    calls.push({ toolName: null, callId: result.callId, input: null, output: result.output, status: result.status });
  }
}
