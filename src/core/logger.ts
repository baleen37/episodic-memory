/**
 * Level-gated logger. Outputs to stderr only.
 *
 * Control via MEMMEM_LOG_LEVEL env var:
 *   error | warn | info | debug   (default: info)
 *   silent                         (disables all output)
 */

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

function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (getThreshold() < LEVELS[level]) return;
  const ts = new Date().toISOString();
  const line = meta !== undefined
    ? `[${ts}] ${level.toUpperCase()} ${msg} ${JSON.stringify(meta)}\n`
    : `[${ts}] ${level.toUpperCase()} ${msg}\n`;
  process.stderr.write(line);
}

export const log = {
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => emit('warn',  msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => emit('info',  msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
};

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
