import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installArchitectureStopHooks,
  mergeArchitectureStopHookConfig,
  removeArchitectureStopHookConfig,
} from '../../src/runtime/agent-setup.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'scip-architecture-hook-'));
  mkdirSync(join(projectRoot, '.git', 'info'), { recursive: true });
  writeFileSync(join(projectRoot, '.git', 'info', 'exclude'), '# local ignores\n');
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('architecture hook setup', () => {
  it('adds only one owned Stop hook and preserves unrelated hooks', () => {
    const foreign = { type: 'command' as const, command: 'other-check' };
    const once = mergeArchitectureStopHookConfig({ hooks: { Stop: [{ hooks: [foreign] }] } }, '/usr/bin/scip-query');
    const twice = mergeArchitectureStopHookConfig(once, '/usr/bin/scip-query');

    expect(twice).toEqual(once);
    expect(twice.hooks?.Stop).toEqual([
      { hooks: [foreign] },
      {
        hooks: [
          expect.objectContaining({
            command: '/usr/bin/scip-query hook-architecture-stop',
            statusMessage: 'Checking architecture boundaries',
          }),
        ],
      },
    ]);
    expect(removeArchitectureStopHookConfig(twice)).toEqual({ hooks: { Stop: [{ hooks: [foreign] }] } });
  });

  it('installs local Codex and Claude hooks only after a clean readiness check', () => {
    const result = {
      written: [] as string[],
      unchanged: [] as string[],
      skipped: [] as Array<{ target: string; reason: string }>,
    };
    installArchitectureStopHooks(projectRoot, result, {
      commandPrefix: '/usr/bin/scip-query',
      inspectReadiness: () => ({ state: 'ready' }),
    });

    expect(result.written).toEqual(['.codex/hooks.json', '.claude/settings.local.json']);
    expect(readFileSync(join(projectRoot, '.codex', 'hooks.json'), 'utf8')).toContain('hook-architecture-stop');
    expect(readFileSync(join(projectRoot, '.claude', 'settings.local.json'), 'utf8')).toContain(
      'hook-architecture-stop',
    );
    const excludes = readFileSync(join(projectRoot, '.git', 'info', 'exclude'), 'utf8');
    expect(excludes).toContain('/.codex/hooks.json');
    expect(excludes).toContain('/.claude/settings.local.json');
  });

  it('does not install a grader on a dirty architecture baseline', () => {
    const result = {
      written: [] as string[],
      unchanged: [] as string[],
      skipped: [] as Array<{ target: string; reason: string }>,
    };
    installArchitectureStopHooks(projectRoot, result, {
      inspectReadiness: () => ({ state: 'blocked', reason: 'baseline has a violation' }),
    });

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([{ target: 'architecture Stop hook', reason: 'baseline has a violation' }]);
  });
});
