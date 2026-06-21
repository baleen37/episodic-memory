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
    expect(Object.keys(hooks.hooks)).toEqual(['SessionStart', 'Stop']);

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
      command: '${CLAUDE_PLUGIN_ROOT}/bin/memmem sync --background',
    });
  });

  it('runs sync on Stop for mid-session freshness', () => {
    const hooks = loadHooksJson();

    const stopHooks = hooks.hooks.Stop;
    expect(Array.isArray(stopHooks)).toBe(true);
    expect(stopHooks).toHaveLength(1);

    const [hookGroup] = stopHooks;
    expect(Array.isArray(hookGroup.hooks)).toBe(true);
    expect(hookGroup.hooks).toHaveLength(1);

    const [hook] = hookGroup.hooks;
    expect(hook).toEqual({
      type: 'command',
      command: '${CLAUDE_PLUGIN_ROOT}/bin/memmem sync --background',
    });
  });

  it('does not use unsupported async hook fields', () => {
    const hooks = loadHooksJson();
    const commandHooks = Object.values(hooks.hooks).flatMap((hookGroups: any) =>
      hookGroups.flatMap((group: any) =>
        group.hooks.filter((hook: any) => hook.type === 'command')
      )
    );

    for (const hook of commandHooks) {
      expect(hook).not.toHaveProperty('async');
    }
  });

  it('does not reference old observation hook commands', () => {
    const hooks = loadHooksJson();
    const commands = getCommandHooks(hooks);

    // Both SessionStart and Stop run the same self-backgrounding sync command.
    expect(commands).toEqual([
      '${CLAUDE_PLUGIN_ROOT}/bin/memmem sync --background',
      '${CLAUDE_PLUGIN_ROOT}/bin/memmem sync --background',
    ]);
    for (const command of commands) {
      expect(command).not.toContain('recall');
      expect(command).not.toContain('record');
      expect(command).not.toContain('extract');
      expect(command).not.toContain('observe');
    }
  });

  it('builds bin/memmem as a bun shebang executable', () => {
    const graceful = readRepoFile('src/cli-graceful.mjs');

    expect(graceful.startsWith('#!/usr/bin/env bun')).toBe(true);
    expect(graceful).toContain("error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND'");
  });

  it('routes MCP through bin/memmem mcp subcommand', () => {
    const mcpConfig = JSON.parse(readRepoFile('.mcp.json'));

    expect(mcpConfig.mcpServers.memmem.command).toBe('./bin/memmem');
    expect(mcpConfig.mcpServers.memmem.args).toEqual(['mcp']);
    expect(mcpConfig.mcpServers.memmem.cwd).toBe('.');
  });

  it('uses bun for wrapper dependency installation and builds', () => {
    const dependencyChecker = readRepoFile('scripts/lib/check-dependencies.mjs');

    expect(dependencyChecker.startsWith('#!/usr/bin/env bun')).toBe(true);
    expect(dependencyChecker).toContain("spawn(bunCommand, ['install'");
    expect(dependencyChecker).toContain("spawn(bunCommand, ['run', 'build'");
    expect(dependencyChecker).not.toContain("spawn(npmCommand");
  });
});
