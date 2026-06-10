// Preload script for bun test
// Sets custom SQLite before any module loads bun:sqlite
import { Database } from 'bun:sqlite';

// macOS: Use Homebrew SQLite which supports extensions
if (process.platform === 'darwin') {
  try {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  } catch {
    // Ignore if already set or not available
  }
}
