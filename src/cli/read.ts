import { readConversation } from '../core/read.js';

export function runReadCli(args: { path: string; startLine?: number; endLine?: number }): void {
  const output = readConversation(args.path, args.startLine, args.endLine);
  if (output === null) {
    console.error(`File not found: ${args.path}`);
    process.exit(1);
  }
  console.log(output);
}
