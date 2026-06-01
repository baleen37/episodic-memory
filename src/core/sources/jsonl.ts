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
