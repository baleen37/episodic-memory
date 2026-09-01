import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MODULE_URL = new URL('./check-dependencies.mjs', import.meta.url).href;

function runDependencyModule(expression: string, root?: string): unknown {
  const child = Bun.spawnSync({
    cmd: [
      'bun',
      '-e',
      `const module = await import(process.env.MODULE_URL); console.log(JSON.stringify(${expression}));`,
    ],
    env: {
      PATH: process.env.PATH ?? '',
      MODULE_URL,
      ...(root ? { CHECK_ROOT: root } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = new TextDecoder().decode(child.stdout).trim();
  const stderr = new TextDecoder().decode(child.stderr).trim();
  if (child.exitCode !== 0) {
    throw new Error(`dependency module subprocess failed: ${stderr}`);
  }
  return JSON.parse(stdout);
}

let tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

describe('native sqlite-vec dependency checks', () => {
  test.each([
    ['darwin', 'arm64', 'sqlite-vec-darwin-arm64'],
    ['darwin', 'x64', 'sqlite-vec-darwin-x64'],
    ['linux', 'arm64', 'sqlite-vec-linux-arm64'],
    ['linux', 'x64', 'sqlite-vec-linux-x64'],
    ['win32', 'x64', 'sqlite-vec-windows-x64'],
  ] as const)('maps %s/%s to %s', (platform, architecture, expected) => {
    expect(runDependencyModule(`module.getNativeSqliteVecPackageName('${platform}', '${architecture}')`)).toBe(expected);
  });

  test('returns no package for an unsupported platform and architecture', () => {
    expect(runDependencyModule("module.getNativeSqliteVecPackageName('linux', 'ia32')")).toBeNull();
  });

  test('reports the native extension when node_modules exists but its binary is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'episodic-memory-deps-'));
    tempRoots.push(root);
    mkdirSync(join(root, 'node_modules', 'sqlite-vec'), { recursive: true });

    const result = runDependencyModule('module.checkDependencies(process.env.CHECK_ROOT)', root) as {
      installed: boolean;
      missing: string[];
    };
    const packageName = runDependencyModule('module.getNativeSqliteVecPackageName()') as string;

    expect(packageName).not.toBeNull();
    expect(result.installed).toBe(false);
    expect(result.missing).toContain(packageName);
  });

  test('accepts a node_modules tree with the native extension installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'episodic-memory-deps-'));
    tempRoots.push(root);
    mkdirSync(join(root, 'node_modules', 'sqlite-vec'), { recursive: true });

    const extensionPath = runDependencyModule(
      'module.getNativeSqliteVecExtensionPath(process.env.CHECK_ROOT)',
      root,
    ) as string;
    expect(extensionPath).not.toBeNull();
    mkdirSync(join(extensionPath!, '..'), { recursive: true });
    writeFileSync(extensionPath!, 'native extension');

    expect(existsSync(extensionPath!)).toBe(true);
    expect(runDependencyModule('module.checkDependencies(process.env.CHECK_ROOT)', root)).toEqual({
      installed: true,
      missing: [],
    });
  });
});
