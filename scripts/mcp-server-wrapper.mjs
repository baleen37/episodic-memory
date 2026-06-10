#!/usr/bin/env bun
/**
 * Cross-platform wrapper script for MCP server that ensures dependencies are installed
 * This runs before the MCP server starts and works on Windows, macOS, and Linux
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  checkDependencies,
  checkBuildNeeded,
  installDependencies,
  runBuild,
  analyzeError
} from './lib/check-dependencies.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Determine plugin root directory (respect CLAUDE_PLUGIN_ROOT env var)
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..');

async function ensureDependenciesAndBuild() {
  const { installed } = checkDependencies();

  if (!installed) {
    try {
      console.error('[memmem] Installing dependencies (first run only)...');
      console.error('This may take 30-60 seconds...');
      await installDependencies(false);
      console.error('[memmem] Dependencies installed successfully.');
    } catch (error) {
      const analysis = analyzeError(error);
      console.error('[memmem] ERROR: Failed to install dependencies.');
      console.error(`Cause: ${analysis.cause}`);
      console.error(`Fix: ${analysis.fix}`);
      throw error;
    }
  }

  const { needsBuild, reason } = checkBuildNeeded();

  if (needsBuild) {
    try {
      console.error(`[memmem] Building plugin (${reason})...`);
      await runBuild();
      console.error('[memmem] Build completed successfully.');
    } catch (error) {
      const analysis = analyzeError(error);
      console.error('[memmem] ERROR: Build failed.');
      console.error(`Cause: ${analysis.cause}`);
      console.error(`Fix: ${analysis.fix}`);
      throw error;
    }
  }
}

async function main() {
  try {
    await ensureDependenciesAndBuild();

    // Start the MCP server
    const mcpServerPath = join(PLUGIN_ROOT, 'dist', 'mcp-server.mjs');

    if (!existsSync(mcpServerPath)) {
      console.error(`[memmem] ERROR: MCP server not found at ${mcpServerPath}`);
      console.error('Please run: bun run build');
      process.exit(1);
    }

    // Spawn the MCP server with Bun because it imports bun:sqlite.
    const child = spawn('bun', [mcpServerPath], {
      stdio: 'inherit',
      shell: false
    });

    // Forward signals to the child process
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.on('SIGINT', () => child.kill('SIGINT'));

    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
      } else {
        process.exit(code || 0);
      }
    });

    child.on('error', (err) => {
      console.error(`[memmem] ERROR: Failed to start MCP server: ${err.message}`);
      process.exit(1);
    });

  } catch (error) {
    console.error(`[memmem] ERROR: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[memmem] Unexpected error: ${error.message}`);
  process.exit(1);
});
