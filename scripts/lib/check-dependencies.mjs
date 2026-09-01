#!/usr/bin/env bun
/**
 * Shared dependency checking logic for CLI and MCP wrappers
 * Returns: { installed: boolean, missing: string[] }
 */

import { existsSync, statSync, readdirSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Walk up from `start` until a directory containing package.json is found. */
function findRoot(start) {
  let dir = start;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return start;
}

const NATIVE_SQLITE_VEC_PACKAGES = {
  darwin: {
    arm64: 'sqlite-vec-darwin-arm64',
    x64: 'sqlite-vec-darwin-x64',
  },
  linux: {
    arm64: 'sqlite-vec-linux-arm64',
    x64: 'sqlite-vec-linux-x64',
  },
  win32: {
    x64: 'sqlite-vec-windows-x64',
  },
};

const NATIVE_SQLITE_VEC_EXTENSIONS = {
  darwin: 'dylib',
  linux: 'so',
  win32: 'dll',
};

/** Return the platform package that sqlite-vec loads at runtime. */
export function getNativeSqliteVecPackageName(platformName = process.platform, architecture = process.arch) {
  return NATIVE_SQLITE_VEC_PACKAGES[platformName]?.[architecture] || null;
}

/** Return the loadable extension path expected by sqlite-vec. */
export function getNativeSqliteVecExtensionPath(
  root = ROOT,
  platformName = process.platform,
  architecture = process.arch,
) {
  const packageName = getNativeSqliteVecPackageName(platformName, architecture);
  const extension = NATIVE_SQLITE_VEC_EXTENSIONS[platformName];
  if (!packageName || !extension) return null;
  return join(root, 'node_modules', packageName, `vec0.${extension}`);
}

const ROOT = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || findRoot(__dirname);

/**
 * Check if dependencies are installed
 * @returns {{ installed: boolean, missing: string[], error?: string }}
 */
export function checkDependencies(root = ROOT) {
  const nodeModulesPath = join(root, 'node_modules');

  if (!existsSync(nodeModulesPath)) {
    return { installed: false, missing: ['node_modules'] };
  }

  const missing = [];
  if (!existsSync(join(nodeModulesPath, 'sqlite-vec'))) {
    missing.push('sqlite-vec');
  }

  const nativePackage = getNativeSqliteVecPackageName();
  const nativeExtensionPath = getNativeSqliteVecExtensionPath(root);
  if (nativePackage && nativeExtensionPath && !existsSync(nativeExtensionPath)) {
    missing.push(nativePackage);
  }

  return { installed: missing.length === 0, missing };
}

/**
 * Check if build is needed
 * @returns {{ needsBuild: boolean, reason: string }}
 */
export function checkBuildNeeded() {
  const mcpServerPath = join(ROOT, 'dist', 'mcp-server.mjs');
  const packageJsonPath = join(ROOT, 'package.json');

  if (!existsSync(mcpServerPath)) {
    return { needsBuild: true, reason: 'dist/mcp-server.mjs not found' };
  }

  const mcpServerMtime = statSync(mcpServerPath).mtimeMs;

  if (existsSync(packageJsonPath)) {
    const packageJsonMtime = statSync(packageJsonPath).mtimeMs;
    if (packageJsonMtime > mcpServerMtime) {
      return { needsBuild: true, reason: 'package.json newer than dist' };
    }
  }

  // Rebuild when any source file is newer than the build output. The bundled
  // plugin ships without src/, so skip this check when src/ is absent.
  const srcDir = join(ROOT, 'src');
  if (existsSync(srcDir)) {
    const newest = newestSourceMtime(srcDir);
    if (newest > mcpServerMtime) {
      return { needsBuild: true, reason: 'src newer than dist' };
    }
  }

  return { needsBuild: false, reason: '' };
}

/**
 * Find the newest mtime among non-test source files under a directory.
 * @param {string} dir
 * @returns {number} newest mtimeMs found, or 0
 */
function newestSourceMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

/**
 * Install dependencies using bun
 * @param {boolean} silent - Suppress installer output and run detached
 * @returns {Promise<void>}
 */
function runBunCommand(args, silent) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const bunCommand = isWindows ? 'bun.exe' : 'bun';

    let stderrOutput = '';

    const child = spawn(bunCommand, args, {
      cwd: ROOT,
      stdio: silent ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      detached: silent
    });

    if (!silent) {
      child.stdout?.on('data', (data) => {
        process.stderr.write(data);
      });

      child.stderr?.on('data', (data) => {
        stderrOutput += data.toString();
        process.stderr.write(data);
      });
    }

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const error = new Error(`bun ${args[0]} failed with exit code ${code}`);
        error.stderr = stderrOutput;
        reject(error);
      }
    });

    child.on('error', (err) => {
      reject(err);
    });

    if (silent) {
      child.unref();
    }
  });
}

export async function installDependencies(silent = false) {
  if (!silent) {
    console.error('[episodic-memory] Installing dependencies...');
  }
  await runBunCommand(['install', '--silent'], silent);

  const nativePackage = getNativeSqliteVecPackageName();
  const nativeExtensionPath = getNativeSqliteVecExtensionPath();
  if (nativePackage && nativeExtensionPath && !existsSync(nativeExtensionPath)) {
    if (!silent) {
      console.error(`[episodic-memory] Installing native dependency ${nativePackage}...`);
    }
    await runBunCommand(['add', '--no-save', '--ignore-scripts', nativePackage], silent);
    if (!existsSync(nativeExtensionPath)) {
      throw new Error(`native dependency install did not provide ${nativePackage}`);
    }
  }

  if (!silent) {
    console.error('[episodic-memory] Dependencies installed.');
  }
}

/**
 * Run build using bun
 * @returns {Promise<void>}
 */
export function runBuild() {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const bunCommand = isWindows ? 'bun.exe' : 'bun';

    console.error('[episodic-memory] Building plugin...');

    let stderrOutput = '';

    const child = spawn(bunCommand, ['run', 'build', '--silent'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows
    });

    child.stdout.on('data', (data) => {
      process.stderr.write(data);
    });

    child.stderr.on('data', (data) => {
      stderrOutput += data.toString();
      process.stderr.write(data);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        console.error('[episodic-memory] Build completed.');
        resolve();
      } else {
        const error = new Error(`bun run build failed with exit code ${code}`);
        error.stderr = stderrOutput;
        reject(error);
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Analyze bun error and suggest fix
 * @param {Error} error
 * @returns {{ cause: string, fix: string }}
 */
export function analyzeError(error) {
  const stderr = error.stderr || error.message || '';

  if (stderr.includes('EACCES') || stderr.includes('permission denied')) {
    return {
      cause: 'Permission denied',
      fix: 'Check permissions for the project directory and Bun cache'
    };
  }

  if (stderr.includes('ENOSPC')) {
    return {
      cause: 'Disk space full',
      fix: 'Free up disk space and retry'
    };
  }

  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(stderr)) {
    return {
      cause: 'Network error',
      fix: 'Check internet connection and retry'
    };
  }

  return {
    cause: error.message || 'Unknown error',
    fix: `Manual fallback: cd "${ROOT}" && bun install`
  };
}
