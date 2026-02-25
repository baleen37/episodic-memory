import { runRecordCli } from './record.js';
import { runRecallCli } from './recall.js';
import { runExtractCli } from './extract.js';

const command = process.argv[2];

if (!command || command === '--help' || command === '-h') {
  console.log(`
memmem - Persistent conversation memory for Claude Code

USAGE:
  memmem <command>

COMMANDS:
  recall    SessionStart hook — inject recent context into session
  record    PostToolUse hook — buffer tool event
  extract   Stop hook — extract observations from buffered events

ENVIRONMENT VARIABLES:
  CONVERSATION_MEMORY_CONFIG_DIR   Override config directory
  CONVERSATION_MEMORY_DB_PATH      Override database path
  CLAUDE_SESSION_ID                Session ID (set by hooks system)
  CLAUDE_PROJECT                   Project name (set by hooks system)
`);
  process.exit(0);
}

async function main() {
  switch (command) {
    case 'recall':
      await runRecallCli();
      break;
    case 'record':
      await runRecordCli();
      break;
    case 'extract':
      await runExtractCli();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run with --help for usage information.');
      process.exit(1);
  }
}

main();
