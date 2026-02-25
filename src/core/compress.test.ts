import { describe, test, expect } from 'bun:test';
import { compressEvent } from './compress.js';

describe('compressEvent', () => {
  describe('Read tool compression', () => {
    test('compresses Read tool result with file content', () => {
      const toolData = {
        file_path: '/src/auth.ts',
        content: 'export function authenticate() {\n  return true;\n}\n',
        lines: 245
      };
      const result = compressEvent('Read', toolData);
      expect(result).toBe('Read /src/auth.ts (245 lines)');
    });

    test('handles Read with missing lines count', () => {
      const toolData = {
        file_path: '/src/config.ts',
        content: 'config data'
      };
      const result = compressEvent('Read', toolData);
      expect(result).toBe('Read /src/config.ts');
    });

    test('handles Read with missing file_path', () => {
      const toolData = {
        content: 'some content'
      };
      const result = compressEvent('Read', toolData);
      expect(result).toBe('Read');
    });

    test('handles Read with null data', () => {
      const result = compressEvent('Read', null);
      expect(result).toBe('Read');
    });

    test('handles Read with undefined data', () => {
      const result = compressEvent('Read', undefined);
      expect(result).toBe('Read');
    });
  });

  describe('Edit tool compression', () => {
    test('compresses Edit tool result with old and new string', () => {
      const toolData = {
        file_path: '/src/auth.ts',
        old_string: 'export function hello() {\n  console.log("hi");\n}',
        new_string: 'export function hello() {\n  console.log("bye");\n}'
      };
      const result = compressEvent('Edit', toolData);
      expect(result).toBe('Edited /src/auth.ts: export function hello() { → export function hello() {');
    });

    test('truncates old_string and new_string to 40 chars', () => {
      const longString = 'a'.repeat(60);
      const toolData = {
        file_path: '/test.ts',
        old_string: longString,
        new_string: longString
      };
      const result = compressEvent('Edit', toolData);
      expect(result).toBe(`Edited /test.ts: ${'a'.repeat(37)}... → ${'a'.repeat(37)}...`);
    });

    test('handles Edit with missing new_string', () => {
      const toolData = {
        file_path: '/src/test.ts',
        old_string: 'old content'
      };
      const result = compressEvent('Edit', toolData);
      expect(result).toBe('Edited /src/test.ts: old content → (no new string)');
    });

    test('handles Edit with missing old_string', () => {
      const toolData = {
        file_path: '/src/test.ts',
        new_string: 'new content'
      };
      const result = compressEvent('Edit', toolData);
      expect(result).toBe('Edited /src/test.ts: (no old string) → new content');
    });

    test('handles Edit with missing file_path', () => {
      const toolData = {
        old_string: 'old',
        new_string: 'new'
      };
      const result = compressEvent('Edit', toolData);
      expect(result).toBe('Edited unknown file: old → new');
    });

    test('handles Edit with null data', () => {
      const result = compressEvent('Edit', null);
      expect(result).toBe('Edited');
    });
  });

  describe('Write tool compression', () => {
    test('compresses Write tool result', () => {
      const toolData = {
        file_path: '/src/auth.ts',
        lines: 120
      };
      const result = compressEvent('Write', toolData);
      expect(result).toBe('Created /src/auth.ts (120 lines)');
    });

    test('handles Write with missing lines count', () => {
      const toolData = {
        file_path: '/src/config.ts'
      };
      const result = compressEvent('Write', toolData);
      expect(result).toBe('Created /src/config.ts');
    });

    test('handles Write with missing file_path', () => {
      const toolData = {
        lines: 50
      };
      const result = compressEvent('Write', toolData);
      expect(result).toBe('Created (50 lines)');
    });

    test('handles Write with null data', () => {
      const result = compressEvent('Write', null);
      expect(result).toBe('Created');
    });
  });

  describe('Bash tool compression', () => {
    test('compresses successful Bash command', () => {
      const toolData = {
        command: 'npm test',
        exitCode: 0,
        stdout: 'PASS test suite',
        stderr: ''
      };
      const result = compressEvent('Bash', toolData);
      expect(result).toBe('Ran `npm test` → exit 0');
    });

    test('compresses failed Bash command with error summary', () => {
      const toolData = {
        command: 'npm test',
        exitCode: 1,
        stdout: 'FAIL',
        stderr: 'Error: Test failed\n  at test.js:10'
      };
      const result = compressEvent('Bash', toolData);
      expect(result).toBe('Ran `npm test` → exit 1: Error: Test failed');
    });

    test('truncates error summary to 100 chars', () => {
      const longError = 'Error: '.repeat(30);
      const toolData = {
        command: 'npm test',
        exitCode: 1,
        stderr: longError
      };
      const result = compressEvent('Bash', toolData);
      expect(result).toBe(`Ran \`npm test\` → exit 1: ${longError.substring(0, 97)}...`);
    });

    test('handles Bash with missing stderr on failure', () => {
      const toolData = {
        command: 'npm test',
        exitCode: 1
      };
      const result = compressEvent('Bash', toolData);
      expect(result).toBe('Ran `npm test` → exit 1');
    });

    test('handles Bash with missing command', () => {
      const toolData = {
        exitCode: 0
      };
      const result = compressEvent('Bash', toolData);
      expect(result).toBe('Ran `command` → exit 0');
    });

    test('handles Bash with null data', () => {
      const result = compressEvent('Bash', null);
      expect(result).toBe('Ran');
    });
  });

  describe('Grep tool compression', () => {
    test('compresses Grep result with matches', () => {
      const toolData = {
        pattern: 'TODO',
        path: '/src',
        matches: [
          { line: 10, content: '// TODO: fix this' },
          { line: 25, content: '// TODO: implement' }
        ],
        count: 5
      };
      const result = compressEvent('Grep', toolData);
      expect(result).toBe('Searched \'TODO\' in /src → 5 matches');
    });

    test('handles Grep with count field', () => {
      const toolData = {
        pattern: 'FIXME',
        path: '/src',
        count: 3
      };
      const result = compressEvent('Grep', toolData);
      expect(result).toBe('Searched \'FIXME\' in /src → 3 matches');
    });

    test('handles Grep with matches array but no count', () => {
      const toolData = {
        pattern: 'BUG',
        path: '/src',
        matches: [{ line: 1 }, { line: 2 }, { line: 3 }]
      };
      const result = compressEvent('Grep', toolData);
      expect(result).toBe('Searched \'BUG\' in /src → 3 matches');
    });

    test('handles Grep with no matches', () => {
      const toolData = {
        pattern: 'NOMATCH',
        path: '/src',
        matches: [],
        count: 0
      };
      const result = compressEvent('Grep', toolData);
      expect(result).toBe('Searched \'NOMATCH\' in /src → 0 matches');
    });

    test('handles Grep with missing path', () => {
      const toolData = {
        pattern: 'TODO',
        count: 5
      };
      const result = compressEvent('Grep', toolData);
      expect(result).toBe('Searched \'TODO\' → 5 matches');
    });

    test('handles Grep with null data', () => {
      const result = compressEvent('Grep', null);
      expect(result).toBe('Searched');
    });
  });

  describe('WebSearch tool compression', () => {
    test('compresses WebSearch result', () => {
      const toolData = {
        query: 'latest React documentation',
        results: [
          { title: 'React Docs', url: 'https://react.dev' }
        ]
      };
      const result = compressEvent('WebSearch', toolData);
      expect(result).toBe('Searched: latest React documentation');
    });

    test('handles WebSearch with missing query', () => {
      const toolData = {
        results: []
      };
      const result = compressEvent('WebSearch', toolData);
      expect(result).toBe('Searched: ');
    });

    test('handles WebSearch with null data', () => {
      const result = compressEvent('WebSearch', null);
      expect(result).toBe('Searched:');
    });
  });

  describe('WebFetch tool compression', () => {
    test('compresses WebFetch result with URL', () => {
      const toolData = {
        url: 'https://example.com',
        content: 'page content'
      };
      const result = compressEvent('WebFetch', toolData);
      expect(result).toBe('Fetched https://example.com');
    });

    test('handles WebFetch with missing URL', () => {
      const toolData = {
        content: 'some content'
      };
      const result = compressEvent('WebFetch', toolData);
      expect(result).toBe('Fetched');
    });

    test('handles WebFetch with null data', () => {
      const result = compressEvent('WebFetch', null);
      expect(result).toBe('Fetched');
    });
  });

  describe('Skipped tools (return null)', () => {
    test('returns null for Glob tool', () => {
      const result = compressEvent('Glob', { pattern: '*.ts' });
      expect(result).toBeNull();
    });

    test('returns null for LSP tool', () => {
      const result = compressEvent('LSP', { operation: 'goToDefinition' });
      expect(result).toBeNull();
    });

    test('returns null for TodoWrite tool', () => {
      const result = compressEvent('TodoWrite', { content: 'todo' });
      expect(result).toBeNull();
    });

    test('returns null for TaskCreate tool', () => {
      const result = compressEvent('TaskCreate', { subject: 'task' });
      expect(result).toBeNull();
    });

    test('returns null for TaskUpdate tool', () => {
      const result = compressEvent('TaskUpdate', { taskId: '1' });
      expect(result).toBeNull();
    });

    test('returns null for TaskList tool', () => {
      const result = compressEvent('TaskList', {});
      expect(result).toBeNull();
    });

    test('returns null for TaskGet tool', () => {
      const result = compressEvent('TaskGet', { taskId: '1' });
      expect(result).toBeNull();
    });

    test('returns null for AskUserQuestion tool', () => {
      const result = compressEvent('AskUserQuestion', { question: '?' });
      expect(result).toBeNull();
    });

    test('returns null for EnterPlanMode tool', () => {
      const result = compressEvent('EnterPlanMode', {});
      expect(result).toBeNull();
    });

    test('returns null for ExitPlanMode tool', () => {
      const result = compressEvent('ExitPlanMode', {});
      expect(result).toBeNull();
    });

    test('returns null for NotebookEdit tool', () => {
      const result = compressEvent('NotebookEdit', { notebook_path: 'test.ipynb' });
      expect(result).toBeNull();
    });

    test('returns null for Skill tool', () => {
      const result = compressEvent('Skill', { skill: 'test' });
      expect(result).toBeNull();
    });
  });

  describe('Unknown tools', () => {
    test('handles unknown tool with basic format', () => {
      const toolData = { param: 'value' };
      const result = compressEvent('UnknownTool', toolData);
      expect(result).toBe('UnknownTool');
    });

    test('handles unknown tool with null data', () => {
      const result = compressEvent('UnknownTool', null);
      expect(result).toBe('UnknownTool');
    });
  });

  describe('Edge cases', () => {
    test('handles empty object data', () => {
      const result = compressEvent('Read', {});
      expect(result).toBe('Read');
    });

    test('handles primitive string data', () => {
      const result = compressEvent('Read', 'just a string');
      expect(result).toBe('Read');
    });

    test('handles array data', () => {
      const result = compressEvent('Read', ['item1', 'item2']);
      expect(result).toBe('Read');
    });

    test('handles number data', () => {
      const result = compressEvent('Read', 42);
      expect(result).toBe('Read');
    });

    test('handles boolean data', () => {
      const result = compressEvent('Read', true);
      expect(result).toBe('Read');
    });
  });
});
