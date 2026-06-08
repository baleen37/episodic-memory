import { describe, expect, test } from 'bun:test';
import { resolveProject, parseOrgRepo } from './project.js';

const noGit = { readRemoteOrgRepo: () => null };

describe('resolveProject (fallback, no git)', () => {
  test('strips worktree suffix and uses leaf segment', () => {
    const r = resolveProject(
      '/Users/jito.hello/dev/wooto/ssulmeta/.worktrees/00058-proud-harbor-bachman',
      { gitReader: noGit },
    );
    expect(r).toEqual({ project: 'ssulmeta', projectName: 'ssulmeta' });
  });

  test('plain repo path uses leaf segment', () => {
    const r = resolveProject('/Users/jito.hello/dev/search', { gitReader: noGit });
    expect(r).toEqual({ project: 'search', projectName: 'search' });
  });

  test('non-standard path uses leaf segment', () => {
    const r = resolveProject('/private/tmp', { gitReader: noGit });
    expect(r).toEqual({ project: 'tmp', projectName: 'tmp' });
  });

  test('null cwd yields unknown', () => {
    const r = resolveProject(null, { gitReader: noGit });
    expect(r).toEqual({ project: 'unknown', projectName: 'unknown' });
  });

  test('trailing slash is tolerated', () => {
    const r = resolveProject('/Users/jito.hello/dev/search/', { gitReader: noGit });
    expect(r).toEqual({ project: 'search', projectName: 'search' });
  });
});

describe('parseOrgRepo', () => {
  test('https url', () => {
    expect(parseOrgRepo('https://github.com/croquis/memmem.git')).toBe('croquis/memmem');
  });
  test('https url without .git', () => {
    expect(parseOrgRepo('https://github.com/croquis/memmem')).toBe('croquis/memmem');
  });
  test('ssh scp-like url', () => {
    expect(parseOrgRepo('git@github.com:croquis/memmem.git')).toBe('croquis/memmem');
  });
  test('ssh url with protocol', () => {
    expect(parseOrgRepo('ssh://git@github.com/croquis/memmem.git')).toBe('croquis/memmem');
  });
  test('trailing slash tolerated', () => {
    expect(parseOrgRepo('https://github.com/croquis/memmem/')).toBe('croquis/memmem');
  });
  test('unparseable returns null', () => {
    expect(parseOrgRepo('not-a-url')).toBeNull();
  });
});

describe('resolveProject (git remote wins)', () => {
  test('uses org/repo from gitReader, name is repo basename', () => {
    const gitReader = { readRemoteOrgRepo: () => 'croquis/memmem' };
    const r = resolveProject('/Users/jito.hello/dev/wooto/memmem', { gitReader });
    expect(r).toEqual({ project: 'croquis/memmem', projectName: 'memmem' });
  });

  test('worktree cwd still resolves via repoRoot git', () => {
    const seen: string[] = [];
    const gitReader = {
      readRemoteOrgRepo: (root: string) => {
        seen.push(root);
        return 'croquis/memmem';
      },
    };
    const r = resolveProject(
      '/Users/jito.hello/dev/wooto/memmem/.worktrees/00008-x',
      { gitReader },
    );
    expect(r).toEqual({ project: 'croquis/memmem', projectName: 'memmem' });
    expect(seen).toEqual(['/Users/jito.hello/dev/wooto/memmem']);
  });
});
