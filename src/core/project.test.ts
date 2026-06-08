import { describe, expect, test } from 'bun:test';
import { resolveProject } from './project.js';

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
