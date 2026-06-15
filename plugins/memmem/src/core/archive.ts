/**
 * JSONL archive copy for conversation backup.
 *
 * Copies session JSONL from ~/.claude/projects/{project-slug}/
 * to ~/.config/memmem/conversation-archive/{project-slug}/
 * so raw conversations survive Claude Code cleanup.
 */

import fs from 'fs';
import path from 'path';

interface ArchiveOptions {
  sessionId: string;
  projectSlug: string;
  claudeProjectsDir: string;
  archiveDir: string;
}

/**
 * Find session JSONL file in Claude projects directory.
 * Returns the full path, or null if not found.
 */
function findSessionJsonl(projectsDir: string, sessionId: string): string | null {
  const jsonlPath = path.join(projectsDir, `${sessionId}.jsonl`);
  if (fs.existsSync(jsonlPath)) {
    return jsonlPath;
  }
  return null;
}

/**
 * Copy session JSONL to archive, preserving project-slug directory structure.
 * Skips silently if source doesn't exist or archive already exists.
 */
export function archiveSession(options: ArchiveOptions): void {
  const { sessionId, projectSlug, claudeProjectsDir, archiveDir } = options;

  const srcDir = path.join(claudeProjectsDir, projectSlug);
  const srcPath = findSessionJsonl(srcDir, sessionId);
  if (!srcPath) {
    return;
  }

  const dstDir = path.join(archiveDir, projectSlug);
  const dstPath = path.join(dstDir, `${sessionId}.jsonl`);

  if (fs.existsSync(dstPath)) {
    return;
  }

  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(srcPath, dstPath);
}
