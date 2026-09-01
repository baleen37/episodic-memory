#!/usr/bin/env bun
/**
 * Graceful CLI wrapper - checks dependencies before running actual CLI.
 * Prevents missing dependency errors on first run by completing installation
 * before importing the actual CLI.
 */

import { checkDependencies, installDependencies } from '../scripts/lib/check-dependencies.mjs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, '..', 'dist', 'cli-internal.mjs');

async function main() {
  const { installed, missing } = checkDependencies();

  if (!installed) {
    // Wait for the platform-native sqlite-vec extension before importing the CLI.
    await installDependencies(false);
  }

  // Run CLI regardless
  try {
    await import(CLI_PATH);
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('Error: Missing dependencies. Installing now...');
      console.error('Please run: bun install');
      if (missing.length > 0) {
        console.error(`Missing: ${missing.join(', ')}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error('CLI failed:', error.message);
  process.exit(1);
});
