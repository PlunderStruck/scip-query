import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Setup from '../../src/runtime/setup.js';

async function loadSetup() {
  vi.resetModules();
  const symlinkSync = vi.fn();
  const mkdirSync = vi.fn();
  const unlinkSync = vi.fn();
  const mockedReaddir = vi.fn(() => [] as string[]);
  const readlinkSync = vi.fn(() => {
    throw new Error('not-a-link');
  });
  const existsSync = vi.fn((target: string) => {
    if (target === '/pkg/skills' || target.startsWith('/pkg/skills/')) return true;
    return target === '/home/test/.claude' || target === '/home/test/.codex' || target === '/home/test/.agents';
  });

  vi.doMock('node:fs', () => ({
    existsSync,
    mkdirSync,
    symlinkSync,
    readdirSync: mockedReaddir,
    readlinkSync,
    unlinkSync,
  }));
  vi.doMock('node:os', () => ({ homedir: () => '/home/test', platform: () => 'darwin' }));
  vi.doMock('node:url', () => ({ fileURLToPath: () => '/pkg/dist/setup.js' }));

  const module = (await import('../../src/runtime/setup.js')) as typeof Setup;
  return { module, existsSync, readlinkSync, readdirSync: mockedReaddir, symlinkSync, unlinkSync };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('skill installation', () => {
  it('keeps the builtin skill list in lockstep with the shipped directories', async () => {
    const { module } = await loadSetup();
    expect([...module.BUILTIN_SKILLS].sort()).toEqual([
      'scip-integrity-audit',
      'scip-plan',
      'scip-query',
      'scip-setup',
    ]);
    expect([...module.INSTALLABLE_SKILLS].sort()).toEqual(
      [...module.BUILTIN_SKILLS, ...module.COMPATIBILITY_SKILLS].sort(),
    );
    expect([...module.INSTALLABLE_SKILLS].sort()).toEqual(readdirSync(join(process.cwd(), 'skills')).sort());
  });

  it('ships the primary router, workflow skills, and integrity audit', async () => {
    const { module } = await loadSetup();
    expect(module.BUILTIN_SKILLS).toEqual(['scip-query', 'scip-plan', 'scip-setup', 'scip-integrity-audit']);
  });

  it('installs every bundled skill into Claude, Codex, and shared agent roots', async () => {
    const { module, symlinkSync } = await loadSetup();
    const result = module.installSkills({ quiet: true });

    for (const skill of [
      'scip-query',
      'scip-plan',
      'scip-setup',
      'scip-integrity-audit',
      'scip-explore',
      'concrete-plan',
    ]) {
      expect(result.installed).toEqual(
        expect.arrayContaining([`Claude/${skill}`, `Codex/${skill}`, `Agents/${skill}`]),
      );
      expect(symlinkSync).toHaveBeenCalledWith(`/pkg/skills/${skill}`, `/home/test/.codex/skills/${skill}`, 'dir');
    }
  });

  it('can install into an isolated home for a clean smoke test', async () => {
    const { module, symlinkSync } = await loadSetup();

    module.installSkills({ quiet: true, homeDir: '/home/test' });

    expect(symlinkSync).toHaveBeenCalledWith('/pkg/skills/scip-query', '/home/test/.codex/skills/scip-query', 'dir');
  });

  it('uses the scoped skill-home override for packaged smoke tests', async () => {
    const prior = process.env.SCIP_QUERY_SKILLS_HOME;
    process.env.SCIP_QUERY_SKILLS_HOME = '/home/test';
    try {
      const { module, symlinkSync } = await loadSetup();

      module.installSkills({ quiet: true });

      expect(symlinkSync).toHaveBeenCalledWith('/pkg/skills/scip-query', '/home/test/.codex/skills/scip-query', 'dir');
    } finally {
      if (prior === undefined) delete process.env.SCIP_QUERY_SKILLS_HOME;
      else process.env.SCIP_QUERY_SKILLS_HOME = prior;
    }
  });

  it('prunes stale scip-query skill links without touching unrelated links', async () => {
    const { module, readlinkSync, readdirSync, unlinkSync } = await loadSetup();
    readdirSync.mockImplementation((target: string) =>
      target === '/home/test/.codex/skills' ? ['scip-legacy', 'custom'] : [],
    );
    readlinkSync.mockImplementation((target: string) => {
      if (target.endsWith('/scip-legacy')) return '/pkg/skills/scip-legacy';
      if (target.endsWith('/custom')) return '/elsewhere/custom';
      throw new Error('not-a-link');
    });

    const result = module.installSkills({ quiet: true });

    expect(result.pruned).toContain('Codex/scip-legacy');
    expect(unlinkSync).toHaveBeenCalledWith('/home/test/.codex/skills/scip-legacy');
    expect(unlinkSync).not.toHaveBeenCalledWith('/home/test/.codex/skills/custom');
  });

  it('uninstalls only symlinks owned by this package', async () => {
    const { module, existsSync, readlinkSync, readdirSync, unlinkSync } = await loadSetup();
    existsSync.mockImplementation((target: string) => target === '/home/test/.claude/skills');
    readdirSync.mockReturnValue(['scip-query', 'custom']);
    readlinkSync.mockImplementation((target: string) =>
      target.endsWith('/scip-query') ? '/pkg/skills/scip-query' : '/elsewhere/custom',
    );

    const result = module.uninstallSkills({ homeDir: '/home/test' });

    expect(result.removed).toEqual(['Claude/scip-query']);
    expect(result.left).toEqual(['Claude/custom (symlink outside scip-query package)']);
    expect(unlinkSync).toHaveBeenCalledTimes(1);
  });
});
