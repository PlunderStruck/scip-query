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
  const expectedSkills = [
    'scip-query',
    'scip-explore',
    'scip-plan',
    'scip-architecture-review',
    'scip-integrity-audit',
    'scip-setup',
  ];

  it('installs the six distinct workflows by default', async () => {
    const { module, symlinkSync } = await loadSetup();
    const result = module.installSkills();
    expect(result.installed).toEqual(
      ['Claude', 'Codex', 'Agents'].flatMap((tool) => expectedSkills.map((skill) => `${tool}/${skill}`)),
    );
    for (const skill of expectedSkills)
      expect(symlinkSync).toHaveBeenCalledWith(`/pkg/skills/${skill}`, `/home/test/.codex/skills/${skill}`, 'dir');
  });

  it('ships exactly the canonical workflows without retired aliases', async () => {
    const { module } = await loadSetup();
    expect([...module.BUILTIN_SKILLS]).toEqual(expectedSkills);
    expect(module.COMPATIBILITY_SKILLS).toEqual([]);
    expect([...module.INSTALLABLE_SKILLS].sort()).toEqual(readdirSync(join(process.cwd(), 'skills')).sort());
  });

  it('preserves the all option for existing installation scripts', async () => {
    const { module } = await loadSetup();
    expect(module.installSkills({ quiet: true, all: true }).installed).toEqual(
      ['Claude', 'Codex', 'Agents'].flatMap((tool) => expectedSkills.map((skill) => `${tool}/${skill}`)),
    );
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

  it('preserves a user-owned symlink with an installable skill name', async () => {
    const { module, existsSync, readlinkSync, unlinkSync } = await loadSetup();
    existsSync.mockImplementation(
      (target: string) =>
        target.startsWith('/pkg/skills') ||
        target === '/home/test/.codex' ||
        target === '/home/test/.codex/skills/scip-query',
    );
    readlinkSync.mockImplementation((target: string) => {
      if (target === '/home/test/.codex/skills/scip-query') return '/user/custom-query';
      throw new Error('not-a-link');
    });
    const result = module.installSkills({ quiet: true });
    expect(result.skipped).toContain('Codex/scip-query');
    expect(unlinkSync).not.toHaveBeenCalledWith('/home/test/.codex/skills/scip-query');
  });

  it('removes retired workflow links on upgrade and preserves user-owned replacements', async () => {
    const { module, readlinkSync, readdirSync, unlinkSync } = await loadSetup();
    const retired = [
      'principal-maintainability-review',
      'scip-system-compression',
      'scip-root-cause',
      'scip-claim-audit',
      'scip-probe-reachability',
      'scip-twin-drift',
      'scip-calibrate',
      'conductor',
      'concrete-plan',
    ];
    readdirSync.mockImplementation((target: string) =>
      target === '/home/test/.codex/skills' ? [...retired, 'custom'] : [],
    );
    readlinkSync.mockImplementation((target: string) => {
      const name = target.split('/').at(-1)!;
      if (name === 'custom') return '/user/skills/custom';
      if (retired.includes(name)) return `/pkg/skills/${name}`;
      throw new Error('not-a-link');
    });
    const result = module.installSkills({ quiet: true });
    expect(result.pruned.sort()).toEqual(retired.map((skill) => `Codex/${skill}`).sort());
    expect(unlinkSync).not.toHaveBeenCalledWith('/home/test/.codex/skills/custom');
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
