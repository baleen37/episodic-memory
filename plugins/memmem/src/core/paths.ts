import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Ensure a directory exists, creating it if necessary
 */
function ensureDir(dir: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get the memmem directory
 *
 * Precedence:
 * 1. CONVERSATION_MEMORY_CONFIG_DIR env var (primary, documented in CLI)
 * 2. MEMMEM_CONFIG_DIR env var (alternative for backward compatibility)
 * 3. ~/.config/memmem/ (default)
 */
export function getSuperpowersDir(): string {
  let dir: string;

  if (process.env.CONVERSATION_MEMORY_CONFIG_DIR) {
    dir = process.env.CONVERSATION_MEMORY_CONFIG_DIR;
  } else if (process.env.MEMMEM_CONFIG_DIR) {
    dir = process.env.MEMMEM_CONFIG_DIR;
  } else {
    dir = path.join(os.homedir(), '.config', 'memmem');
  }

  return ensureDir(dir);
}

/**
 * Get conversation archive directory
 */
export function getArchiveDir(): string {
  // Allow test override
  if (process.env.TEST_ARCHIVE_DIR) {
    return ensureDir(process.env.TEST_ARCHIVE_DIR);
  }

  return ensureDir(path.join(getSuperpowersDir(), 'conversation-archive'));
}

/**
 * Get conversation index directory
 */
export function getIndexDir(): string {
  return ensureDir(path.join(getSuperpowersDir(), 'conversation-index'));
}

/**
 * Get database path
 */
export function getDbPath(): string {
  // Allow test override with direct DB path
  // CONVERSATION_MEMORY_DB_PATH is the primary env var (documented in CLI)
  // MEMMEM_DB_PATH and TEST_DB_PATH are alternatives for backward compatibility
  if (process.env.CONVERSATION_MEMORY_DB_PATH) {
    return process.env.CONVERSATION_MEMORY_DB_PATH;
  }
  if (process.env.MEMMEM_DB_PATH || process.env.TEST_DB_PATH) {
    return process.env.MEMMEM_DB_PATH || process.env.TEST_DB_PATH!;
  }

  return path.join(getIndexDir(), 'conversations.db');
}

/**
 * Get log directory
 */
export function getLogDir(): string {
  return ensureDir(path.join(getSuperpowersDir(), 'logs'));
}

/**
 * Get log file path for current date
 */
export function getLogFilePath(): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(getLogDir(), `${date}.log`);
}
