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
});
