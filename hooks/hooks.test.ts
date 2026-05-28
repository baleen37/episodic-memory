/**
 * Test for hooks.json sync-only hook configuration.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

function loadHooksJson(): any {
  const hooksPath = path.join(__dirname, 'hooks.json');
  const hooksContent = fs.readFileSync(hooksPath, 'utf-8');
  return JSON.parse(hooksContent);
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf-8');
}

function getCommandHooks(hooks: any): string[] {
  return Object.values(hooks.hooks).flatMap((hookGroups: any) =>
    hookGroups.flatMap((group: any) =>
      group.hooks
        .filter((hook: any) => hook.type === 'command')
        .map((hook: any) => hook.command)
    )
  );
}

describe('hooks.json sync-only hook configuration', () => {
  it('has a valid sync-only SessionStart hook structure', () => {
    const hooks = loadHooksJson();

    expect(hooks).toHaveProperty('hooks');
    expect(Object.keys(hooks.hooks)).toEqual(['SessionStart']);

    const sessionStartHooks = hooks.hooks.SessionStart;
    expect(Array.isArray(sessionStartHooks)).toBe(true);
    expect(sessionStartHooks).toHaveLength(1);

    const [hookGroup] = sessionStartHooks;
    expect(hookGroup.matcher).toBe('startup|resume|clear|compact');
    expect(Array.isArray(hookGroup.hooks)).toBe(true);
    expect(hookGroup.hooks).toHaveLength(1);

    const [hook] = hookGroup.hooks;
    expect(hook).toEqual({
      type: 'command',
      command: 'sh ${CLAUDE_PLUGIN_ROOT}/hooks/run.sh sync',
      async: true,
    });
  });

  it('does not reference old observation hook commands', () => {
    const hooks = loadHooksJson();
    const commands = getCommandHooks(hooks);

    expect(commands).toEqual(['sh ${CLAUDE_PLUGIN_ROOT}/hooks/run.sh sync']);
    for (const command of commands) {
      expect(command).not.toContain('recall');
      expect(command).not.toContain('record');
      expect(command).not.toContain('extract');
      expect(command).not.toContain('observe');
    }
  });

  it('runs Bun-only CLI entrypoints with bun', () => {
    const runner = readRepoFile('hooks/run.sh');
    const cliWrapper = readRepoFile('src/cli-graceful.mjs');

    expect(runner).toContain('bun "$PLUGIN_ROOT/dist/cli.mjs" "$@"');
    expect(runner).not.toContain('node "$PLUGIN_ROOT/dist/cli.mjs"');
    expect(cliWrapper.startsWith('#!/usr/bin/env bun')).toBe(true);
    expect(cliWrapper).toContain("error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND'");
  });

  it('runs the MCP server bundle with bun', () => {
    const mcpConfig = JSON.parse(readRepoFile('.mcp.json'));
    const wrapper = readRepoFile('scripts/mcp-server-wrapper.mjs');

    expect(mcpConfig.mcpServers.memmem.command).toBe('bun');
    expect(mcpConfig.mcpServers.memmem.args).toEqual([
      '${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server-wrapper.mjs',
    ]);
    // cwd must not be set — Claude Code does not substitute ${CLAUDE_PLUGIN_ROOT} there
    expect(mcpConfig.mcpServers.memmem.cwd).toBeUndefined();
    expect(wrapper).toContain("spawn('bun', [mcpServerPath]");
    expect(wrapper).not.toContain('spawn(process.execPath, [mcpServerPath]');
  });

  it('uses bun for wrapper dependency installation and builds', () => {
    const dependencyChecker = readRepoFile('scripts/lib/check-dependencies.mjs');

    expect(dependencyChecker.startsWith('#!/usr/bin/env bun')).toBe(true);
    expect(dependencyChecker).toContain("spawn(bunCommand, ['install'");
    expect(dependencyChecker).toContain("spawn(bunCommand, ['run', 'build'");
    expect(dependencyChecker).not.toContain("spawn(npmCommand");
  });
});
