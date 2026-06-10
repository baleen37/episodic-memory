import { describe, expect, test } from 'bun:test';
import { resolveProject } from './project.js';

// Guards the indexer contract: a span.cwd must map to project/projectName
// via resolveProject. (Indexer wiring is exercised indirectly; this locks the
// mapping the indexer relies on.)
test('indexer maps span cwd to project via resolveProject (fallback)', () => {
  const noGit = { readRemoteOrgRepo: () => null };
  const info = resolveProject('/Users/me/dev/acme/gadget', { gitReader: noGit });
  expect(info).toEqual({ project: 'gadget', projectName: 'gadget' });
});
