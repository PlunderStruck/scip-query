import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Setup from '../src/runtime/setup.js';

type SetupModule = typeof Setup;

async function loadSetup(): Promise<{
  module: SetupModule;
  symlinkSync: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();

  const symlinkSync = vi.fn();
  const mkdirSync = vi.fn();
  const unlinkSync = vi.fn();
  const readlinkSync = vi.fn(() => {
    throw new Error('not-a-link');
  });
  const existsSync = vi.fn((target: string) => {
    if (target === '/pkg/skills') {
      return true;
    }
    if (target.startsWith('/pkg/skills/')) {
      return true;
    }
    if (target === '/home/test/.claude' || target === '/home/test/.codex' || target === '/home/test/.agents') {
      return true;
    }
    if (
      target === '/home/test/.claude/skills' ||
      target === '/home/test/.codex/skills' ||
      target === '/home/test/.agents/skills'
    ) {
      return false;
    }
    if (
      target.startsWith('/home/test/.claude/skills/') ||
      target.startsWith('/home/test/.codex/skills/') ||
      target.startsWith('/home/test/.agents/skills/')
    ) {
      return false;
    }
    return false;
  });

  vi.doMock('node:fs', () => ({
    existsSync,
    mkdirSync,
    symlinkSync,
    readlinkSync,
    unlinkSync,
  }));
  vi.doMock('node:os', () => ({
    homedir: () => '/home/test',
    platform: () => 'darwin',
  }));
  vi.doMock('node:url', () => ({
    fileURLToPath: () => '/pkg/dist/setup.js',
  }));

  const module = await import('../src/runtime/setup.js');
  return { module, symlinkSync };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('skill installation', () => {
  it('keeps the builtin skill list in lockstep with the skills directory', async () => {
    const { module } = await loadSetup();

    // Bidirectional: a skill directory that isn't listed never installs, and
    // a listed skill without a directory installs a broken symlink.
    const skillDirs = readdirSync(join(process.cwd(), 'skills')).sort();
    expect([...module.BUILTIN_SKILLS].sort()).toEqual(skillDirs);
  });

  it('installs bundled skills into Claude, Codex, and shared agents roots', async () => {
    const { module, symlinkSync } = await loadSetup();

    const result = module.installSkills({ quiet: true });

    expect(result.installed).toContain('Claude/scip-language-playbook');
    expect(result.installed).toContain('Codex/scip-language-playbook');
    expect(result.installed).toContain('Claude/scip-maintainability');
    expect(result.installed).toContain('Codex/scip-maintainability');
    expect(result.installed).toContain('Agents/scip-maintainability');
    expect(symlinkSync).toHaveBeenCalledWith(
      '/pkg/skills/scip-language-playbook',
      '/home/test/.claude/skills/scip-language-playbook',
      'dir',
    );
    expect(symlinkSync).toHaveBeenCalledWith(
      '/pkg/skills/scip-language-playbook',
      '/home/test/.codex/skills/scip-language-playbook',
      'dir',
    );
    expect(symlinkSync).toHaveBeenCalledWith(
      '/pkg/skills/scip-maintainability',
      '/home/test/.claude/skills/scip-maintainability',
      'dir',
    );
    expect(symlinkSync).toHaveBeenCalledWith(
      '/pkg/skills/scip-maintainability',
      '/home/test/.codex/skills/scip-maintainability',
      'dir',
    );
    expect(symlinkSync).toHaveBeenCalledWith(
      '/pkg/skills/scip-maintainability',
      '/home/test/.agents/skills/scip-maintainability',
      'dir',
    );
  });
});
