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

const ROOT = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || findRoot(__dirname);

/**
 * Check if dependencies are installed
 * @returns {{ installed: boolean, missing: string[], error?: string }}
 */
export function checkDependencies() {
  const nodeModulesPath = join(ROOT, 'node_modules');

  if (!existsSync(nodeModulesPath)) {
    return { installed: false, missing: ['node_modules'] };
  }

  return { installed: true, missing: [] };
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
 * @param {boolean} silent - Run silently in background
 * @returns {Promise<void>}
 */
export function installDependencies(silent = false) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const bunCommand = isWindows ? 'bun.exe' : 'bun';

    if (!silent) {
      console.error('[memmem] Installing dependencies...');
    }

    let stderrOutput = '';

    const child = spawn(bunCommand, ['install', '--silent'], {
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
        if (!silent) {
          console.error('[memmem] Dependencies installed.');
        }
        resolve();
      } else {
        const error = new Error(`bun install failed with exit code ${code}`);
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

/**
 * Run build using bun
 * @returns {Promise<void>}
 */
export function runBuild() {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const bunCommand = isWindows ? 'bun.exe' : 'bun';

    console.error('[memmem] Building plugin...');

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
        console.error('[memmem] Build completed.');
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
