/**
 * Level-gated logger. Writes to stderr and mirrors output to a dated log file
 * at ~/.config/memmem/logs/YYYY-MM-DD.log (buffered; file writes are suppressed
 * under `bun test` / NODE_ENV=test to avoid polluting the real logs directory).
 *
 * Control via MEMMEM_LOG_LEVEL env var:
 *   error | warn | info | debug   (default: info)
 *   silent                         (disables all output)
 */

import { appendFileSync, readdirSync, unlinkSync } from 'fs';
import { getLogFilePath, getLogDir } from './paths.js';
import { join } from 'path';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<string, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function getThreshold(): number {
  const raw = (process.env.MEMMEM_LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'silent') return -1;
  return LEVELS[raw] ?? LEVELS['info'];
}

const FLUSH_LINE_THRESHOLD = 64;
let buffer: string[] = [];

const FLUSH_INTERVAL_MS = 1000;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushLogBuffer();
  }, FLUSH_INTERVAL_MS);
  // Do not keep a finishing CLI process alive just for a pending flush.
  flushTimer.unref?.();
}

const RETENTION_DAYS = 14;
let retentionDone = false;

function pruneOldLogs(): void {
  const dir = getLogDir();
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const cutoff = todayUtc - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const match = name.match(/^(\d{4})-(\d{2})-(\d{2})\.log$/);
    if (!match) continue;
    const fileTime = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (fileTime < cutoff) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // ignore individual delete failures
      }
    }
  }
}

function flushLogBuffer(force = false): void {
  if (buffer.length === 0) return;
  // Under `bun test` (NODE_ENV=test) skip automatic file writes so suites that
  // don't override the config dir don't pollute the real logs directory.
  // Explicit flushes (force) still write — logger's own tests rely on this.
  if (process.env.NODE_ENV === 'test' && !force) {
    buffer = [];
    return;
  }
  // Prune old log files once per process on the first real write.
  if (!retentionDone) {
    retentionDone = true;
    pruneOldLogs();
  }
  const lines = buffer.join(''); // each buffered entry already ends with '\n'
  buffer = [];
  try {
    appendFileSync(getLogFilePath(), lines);
  } catch {
    // Logging must never break the primary operation; drop on failure.
  }
}

function bufferLine(line: string): void {
  buffer.push(line);
  if (buffer.length >= FLUSH_LINE_THRESHOLD) {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushLogBuffer();
  } else {
    scheduleFlush();
  }
}

function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (getThreshold() < LEVELS[level]) return;
  const ts = new Date().toISOString();
  const line = meta !== undefined
    ? `[${ts}] ${level.toUpperCase()} ${msg} ${JSON.stringify(meta)}\n`
    : `[${ts}] ${level.toUpperCase()} ${msg}\n`;
  process.stderr.write(line);
  bufferLine(line);
}

export const log = {
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => emit('warn',  msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => emit('info',  msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
};

// ---------------------------------------------------------------------------
// Exit hooks — flush the buffer so the tail is always written on process exit.
// ---------------------------------------------------------------------------

let exitHooksRegistered = false;

function registerExitHooks(): void {
  if (exitHooksRegistered) return;
  exitHooksRegistered = true;
  process.on('exit', () => flushLogBuffer());
  process.on('SIGINT', () => {
    flushLogBuffer();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    flushLogBuffer();
    process.exit(143);
  });
}

registerExitHooks();

// ---------------------------------------------------------------------------
// Legacy shims — keep for existing callers in src/core/llm/
// ---------------------------------------------------------------------------

/** @deprecated use log.info */
export function logInfo(message: string, data?: Record<string, unknown>): void {
  log.info(message, data);
}

/** @deprecated use log.warn */
export function logWarn(message: string, data?: Record<string, unknown>): void {
  log.warn(message, data);
}

/** @deprecated use log.error */
export function logError(message: string, error?: unknown, data?: Record<string, unknown>): void {
  const errorMeta = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : error !== undefined ? { error } : undefined;
  const combined = errorMeta
    ? { ...(data ?? {}), ...(errorMeta as Record<string, unknown>) }
    : data;
  log.error(message, combined);
}

/** @deprecated use log.debug */
export function logDebug(message: string, data?: Record<string, unknown>): void {
  log.debug(message, data);
}

/** Test-only: synchronously flush the file buffer. */
export function __flushForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushLogBuffer(true);
}

/** Test-only: allow retention to run again on the next flush. */
export function __resetRetentionForTests(): void {
  retentionDone = false;
}
