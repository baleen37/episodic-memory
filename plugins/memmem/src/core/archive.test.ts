/**
 * Tests for JSONL archive copy logic.
 *
 * Copies JSONL from ~/.claude/projects/{project-slug}/
 * to ~/.config/memmem/conversation-archive/{project-slug}/
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { archiveSession } from './archive.js';

describe('archiveSession', () => {
  let srcDir: string;
  let dstDir: string;

  beforeEach(() => {
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memmem-src-'));
    dstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memmem-dst-'));
  });

  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true });
    fs.rmSync(dstDir, { recursive: true });
  });

  test('copies JSONL to archive preserving project structure', () => {
    const sessionId = 'abc123';
    const projectSlug = '-Users-jito-hello-dev-myproject';
    const srcProjectDir = path.join(srcDir, projectSlug);
    fs.mkdirSync(srcProjectDir, { recursive: true });

    const content = '{"uuid":"test","type":"user"}\n';
    fs.writeFileSync(path.join(srcProjectDir, `${sessionId}.jsonl`), content);

    archiveSession({
      sessionId,
      projectSlug,
      claudeProjectsDir: srcDir,
      archiveDir: dstDir,
    });

    const archivedPath = path.join(dstDir, projectSlug, `${sessionId}.jsonl`);
    expect(fs.existsSync(archivedPath)).toBe(true);
    expect(fs.readFileSync(archivedPath, 'utf-8')).toBe(content);
  });

  test('creates destination directory if it does not exist', () => {
    const sessionId = 'abc123';
    const projectSlug = '-Users-jito-hello-dev-myproject';
    const srcProjectDir = path.join(srcDir, projectSlug);
    fs.mkdirSync(srcProjectDir, { recursive: true });
    fs.writeFileSync(path.join(srcProjectDir, `${sessionId}.jsonl`), 'data\n');

    const newDstDir = path.join(dstDir, 'nonexistent', 'nested');

    archiveSession({
      sessionId,
      projectSlug,
      claudeProjectsDir: srcDir,
      archiveDir: newDstDir,
    });

    const archivedPath = path.join(newDstDir, projectSlug, `${sessionId}.jsonl`);
    expect(fs.existsSync(archivedPath)).toBe(true);
  });

  test('skips silently when source JSONL does not exist', () => {
    expect(() => {
      archiveSession({
        sessionId: 'nonexistent',
        projectSlug: '-Users-jito-dev-myproject',
        claudeProjectsDir: srcDir,
        archiveDir: dstDir,
      });
    }).not.toThrow();
  });

  test('does not overwrite existing archive', () => {
    const sessionId = 'abc123';
    const projectSlug = '-Users-jito-hello-dev-myproject';
    const srcProjectDir = path.join(srcDir, projectSlug);
    fs.mkdirSync(srcProjectDir, { recursive: true });
    fs.writeFileSync(path.join(srcProjectDir, `${sessionId}.jsonl`), 'new content\n');

    const dstProjectDir = path.join(dstDir, projectSlug);
    fs.mkdirSync(dstProjectDir, { recursive: true });
    const existingContent = 'original content\n';
    fs.writeFileSync(path.join(dstProjectDir, `${sessionId}.jsonl`), existingContent);

    archiveSession({
      sessionId,
      projectSlug,
      claudeProjectsDir: srcDir,
      archiveDir: dstDir,
    });

    const archivedPath = path.join(dstProjectDir, `${sessionId}.jsonl`);
    expect(fs.readFileSync(archivedPath, 'utf-8')).toBe(existingContent);
  });
});
