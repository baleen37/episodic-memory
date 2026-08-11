import { runDoctorCli } from './doctor.js';
import { runMcpCli } from './mcp.js';
import { runSearchCli } from './search.js';
import { runStatsCli } from './stats.js';
import { runSyncCli } from './sync.js';
import { runVerifyCli } from './verify.js';

interface SearchCliArgs {
  query: string;
  limit?: number;
  after?: string;
  before?: string;
  sourceKind?: string;
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

export function getHelpText(): string {
  return `
memmem - Event/fact memory for Claude Code and Codex transcripts

USAGE:
  memmem <command>

COMMANDS:
  sync      Copy transcripts and extract memory records
  search    Search indexed memory records
  stats     Print memory index statistics
  verify    Verify memory index integrity
  doctor    Diagnose build, index, and data health
  mcp       Start the MCP server (used by .mcp.json)

SEARCH OPTIONS:
  --limit <number>        Maximum number of results
  --after <YYYY-MM-DD>    Only include records after this date
  --before <YYYY-MM-DD>   Only include records before this date
  --source-kind <kind>    Filter by transcript source kind

EXAMPLES:
  memmem search "source of truth" --limit 5

ENVIRONMENT VARIABLES:
  CONVERSATION_MEMORY_CONFIG_DIR   Override config directory
  CONVERSATION_MEMORY_DB_PATH      Override database path
`;
}

function printHelp(): void {
  console.log(getHelpText());
}

/**
 * Re-spawn `sync` detached and exit immediately so hook runners (Claude Code,
 * Codex) are not blocked while transcripts are indexed. Hook hosts wait for
 * the command's stdio to close, so the child must not inherit any of it.
 */
function spawnBackgroundSync(): void {
  Bun.spawn([process.execPath, process.argv[1], 'sync'], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  }).unref();
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
      if (args.includes('--background')) {
        spawnBackgroundSync();
        break;
      }
      await runSyncCli();
      break;
    case 'search':
      await runSearchCli(parseSearchArgs(args));
      break;
    case 'stats':
      runStatsCli();
      break;
    case 'verify':
      runVerifyCli();
      break;
    case 'doctor':
      runDoctorCli();
      break;
    case 'mcp':
      await runMcpCli();
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
