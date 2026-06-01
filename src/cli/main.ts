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

function requireOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export function parseSearchArgs(args: string[]): SearchCliArgs {
  const parsed: SearchCliArgs = { query: '' };
  const queryParts: string[] = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--after') {
      parsed.after = requireOptionValue(args, i, arg);
      i++;
    } else if (arg === '--before') {
      parsed.before = requireOptionValue(args, i, arg);
      i++;
    } else if (arg === '--source-kind') {
      parsed.sourceKind = requireOptionValue(args, i, arg);
      i++;
    } else if (arg === '--limit') {
      parsed.limit = parsePositiveInteger(requireOptionValue(args, i, arg), arg);
      i++;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      queryParts.push(arg);
    }
  }

  parsed.query = queryParts.join(' ').trim();
  if (!parsed.query) {
    throw new Error('search requires a query');
  }

  return parsed;
}

export function parseReadArgs(args: string[]): ReadCliArgs {
  const path = args[1];
  if (!path || path.startsWith('--')) {
    throw new Error('read requires a path');
  }

  const parsed: ReadCliArgs = { path };

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--start-line') {
      parsed.startLine = parsePositiveInteger(requireOptionValue(args, i, arg), arg);
      i++;
    } else if (arg === '--end-line') {
      parsed.endLine = parsePositiveInteger(requireOptionValue(args, i, arg), arg);
      i++;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (parsed.startLine !== undefined && parsed.endLine !== undefined && parsed.startLine > parsed.endLine) {
    throw new Error('--start-line must be less than or equal to --end-line');
  }

  return parsed;
}

export function getHelpText(): string {
  return `
memmem - Event/fact memory for Claude Code and Codex transcripts

USAGE:
  memmem <command>

COMMANDS:
  sync      Copy transcripts and extract memory records
  search    Search indexed memory records
  read      Read archived transcript lines

ENVIRONMENT VARIABLES:
  CONVERSATION_MEMORY_CONFIG_DIR   Override config directory
  CONVERSATION_MEMORY_DB_PATH      Override database path
`;
}

function printHelp(): void {
  console.log(getHelpText());
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
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
