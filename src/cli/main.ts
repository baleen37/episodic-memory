import { runReadCli } from './read.js';
import { runSearchCli } from './search.js';
import { runSyncCli } from './sync.js';

interface SearchCliArgs {
  query: string;
  limit?: number;
  after?: string;
  before?: string;
  sourceKind?: string;
}

interface ReadCliArgs {
  path: string;
  startLine?: number;
  endLine?: number;
}

export function parseSearchArgs(args: string[]): SearchCliArgs {
  const parsed: SearchCliArgs = { query: args[1] ?? '' };

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === '--after') {
      parsed.after = value;
      i++;
    } else if (arg === '--before') {
      parsed.before = value;
      i++;
    } else if (arg === '--source-kind') {
      parsed.sourceKind = value;
      i++;
    } else if (arg === '--limit') {
      parsed.limit = Number(value);
      i++;
    }
  }

  return parsed;
}

export function parseReadArgs(args: string[]): ReadCliArgs {
  const parsed: ReadCliArgs = { path: args[1] ?? '' };

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === '--start-line') {
      parsed.startLine = Number(value);
      i++;
    } else if (arg === '--end-line') {
      parsed.endLine = Number(value);
      i++;
    }
  }

  return parsed;
}

function printHelp(): void {
  console.log(`
memmem - Persistent conversation memory for Claude Code

USAGE:
  memmem <command>

COMMANDS:
  sync      Copy and index transcripts
  search    Search indexed transcripts
  read      Read an archived transcript

ENVIRONMENT VARIABLES:
  CONVERSATION_MEMORY_CONFIG_DIR   Override config directory
  CONVERSATION_MEMORY_DB_PATH      Override database path
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  switch (command) {
    case 'sync':
      await runSyncCli();
      break;
    case 'search':
      await runSearchCli(parseSearchArgs(args));
      break;
    case 'read':
      runReadCli(parseReadArgs(args));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run with --help for usage information.');
      process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
