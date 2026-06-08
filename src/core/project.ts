export interface ProjectInfo {
  project: string;
  projectName: string;
}

export interface GitReader {
  readRemoteOrgRepo(repoRoot: string): string | null;
}

export interface ResolveProjectOptions {
  gitReader?: GitReader;
}

const UNKNOWN: ProjectInfo = { project: 'unknown', projectName: 'unknown' };

export function normalizeRepoRoot(cwd: string): string {
  const marker = '/.worktrees/';
  const i = cwd.indexOf(marker);
  const root = i >= 0 ? cwd.slice(0, i) : cwd;
  return root.replace(/\/+$/, '');
}

function leaf(repoRoot: string): string {
  const parts = repoRoot.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'unknown';
}

export function parseOrgRepo(remoteUrl: string): string | null {
  let s = remoteUrl.trim();
  if (!s) return null;
  const scp = s.match(/^[^@]+@[^:]+:(.+)$/);
  if (scp) {
    s = scp[1];
  } else {
    const proto = s.match(/^[a-z]+:\/\/[^/]+\/(.+)$/i);
    if (proto) s = proto[1];
    else if (s.includes('://') || s.includes('@')) return null;
    else if (!s.includes('/')) return null;
  }
  s = s.replace(/\.git$/, '').replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

export function resolveProject(
  cwd: string | null,
  opts: ResolveProjectOptions = {},
): ProjectInfo {
  if (!cwd) return UNKNOWN;
  const repoRoot = normalizeRepoRoot(cwd);
  if (!repoRoot) return UNKNOWN;

  const orgRepo = opts.gitReader?.readRemoteOrgRepo(repoRoot) ?? null;
  if (orgRepo) {
    const name = orgRepo.split('/').filter(Boolean).pop() ?? orgRepo;
    return { project: orgRepo, projectName: name };
  }

  const name = leaf(repoRoot);
  return { project: name, projectName: name };
}
