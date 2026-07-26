import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Setup from '../../src/runtime/setup.js';

type SetupModule = typeof Setup;

async function loadSetup(): Promise<{
  module: SetupModule;
  existsSync: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
  readlinkSync: ReturnType<typeof vi.fn>;
  readdirSync: ReturnType<typeof vi.fn>;
  symlinkSync: ReturnType<typeof vi.fn>;
  unlinkSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();

  const symlinkSync = vi.fn();
  const mkdirSync = vi.fn();
  const unlinkSync = vi.fn();
  const readdirSync = vi.fn(() => []);
  const readFileSync = vi.fn(() => '{}');
  const writeFileSync = vi.fn();
  let stagedBytes = Buffer.alloc(0);
  const openSync = vi.fn(() => 42);
  const writeSync = vi.fn((_fd: number, bytes: Buffer, offset: number, length: number) => {
    stagedBytes = Buffer.concat([stagedBytes, bytes.subarray(offset, offset + length)]);
    return length;
  });
  const fsyncSync = vi.fn();
  const closeSync = vi.fn();
  const renameSync = vi.fn((_source: string, target: string) => {
    writeFileSync(target, stagedBytes.toString('utf8'));
    stagedBytes = Buffer.alloc(0);
  });
  const rmSync = vi.fn();
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
    readdirSync,
    readFileSync,
    writeFileSync,
    rmSync,
    readlinkSync,
    unlinkSync,
    openSync,
    writeSync,
    fsyncSync,
    closeSync,
    renameSync,
  }));
  vi.doMock('node:os', () => ({
    homedir: () => '/home/test',
    platform: () => 'darwin',
  }));
  vi.doMock('node:url', () => ({
    fileURLToPath: () => '/pkg/dist/setup.js',
  }));
  vi.doMock('../../src/runtime/revisioned-file.js', () => ({
    mutateTextFileRevisionAware: (
      path: string,
      transform: (snapshot: { path: string; text: string; revision: { exists: boolean; hash: string } }) => {
        kind: 'unchanged' | 'write' | 'delete';
        text?: string;
      },
    ) => {
      const existed = existsSync(path);
      const snapshot = {
        path,
        text: existed ? String(readFileSync(path, 'utf8')) : '',
        revision: { exists: existed, hash: existed ? 'existing' : 'absent' },
      };
      const mutation = transform(snapshot);
      if (mutation.kind === 'write') writeFileSync(path, mutation.text);
      if (mutation.kind === 'delete') rmSync(path, { force: true });
      const changed = mutation.kind !== 'unchanged';
      return {
        changed,
        attempts: 1,
        previous: snapshot,
        current: changed
          ? {
              path,
              text: mutation.kind === 'write' ? (mutation.text ?? '') : '',
              revision: { exists: mutation.kind === 'write', hash: 'updated' },
            }
          : snapshot,
      };
    },
  }));

  const module = await import('../../src/runtime/setup.js');
  return {
    module,
    existsSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    readdirSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
  };
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
    expect(result.installed).toContain('Claude/scip-hyper-optimization');
    expect(result.installed).toContain('Codex/scip-hyper-optimization');
    expect(result.installed).toContain('Agents/scip-hyper-optimization');
    expect(result.installed).toContain('Claude/scip-react-maintainability');
    expect(result.installed).toContain('Codex/scip-react-maintainability');
    expect(result.installed).toContain('Agents/scip-react-maintainability');
    expect(result.installed).toContain('Claude/scip-vue-maintainability');
    expect(result.installed).toContain('Codex/scip-vue-maintainability');
    expect(result.installed).toContain('Agents/scip-vue-maintainability');
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
    expect(symlinkSync).toHaveBeenCalledWith(
      '/pkg/skills/scip-react-maintainability',
      '/home/test/.claude/skills/scip-react-maintainability',
      'dir',
    );
    expect(symlinkSync).toHaveBeenCalledWith(
      '/pkg/skills/scip-react-maintainability',
      '/home/test/.codex/skills/scip-react-maintainability',
      'dir',
    );
    expect(symlinkSync).toHaveBeenCalledWith(
      '/pkg/skills/scip-react-maintainability',
      '/home/test/.agents/skills/scip-react-maintainability',
      'dir',
    );
    expect(symlinkSync).toHaveBeenCalledWith(
      '/pkg/skills/scip-vue-maintainability',
      '/home/test/.claude/skills/scip-vue-maintainability',
      'dir',
    );
    expect(symlinkSync).toHaveBeenCalledWith(
      '/pkg/skills/scip-vue-maintainability',
      '/home/test/.codex/skills/scip-vue-maintainability',
      'dir',
    );
    expect(symlinkSync).toHaveBeenCalledWith(
      '/pkg/skills/scip-vue-maintainability',
      '/home/test/.agents/skills/scip-vue-maintainability',
      'dir',
    );
  });

  it('prunes stale scip-query-owned skill links during installation', async () => {
    const { module, readlinkSync, readdirSync, unlinkSync } = await loadSetup();
    readdirSync.mockImplementation((target: string) => (target === '/home/test/.codex/skills' ? ['scip-debloat'] : []));
    readlinkSync.mockImplementation((target: string) => {
      if (target === '/home/test/.codex/skills/scip-debloat') return '/pkg/skills/scip-debloat';
      throw new Error('not-a-link');
    });

    const result = module.installSkills({ quiet: true });

    expect(result.pruned).toContain('Codex/scip-debloat');
    expect(unlinkSync).toHaveBeenCalledWith('/home/test/.codex/skills/scip-debloat');
  });

  it('installs reviewable project hooks into the current repository', async () => {
    const { module, writeFileSync } = await loadSetup();

    const result = module.installProjectAgentHooks('/repo', {
      homeDir: '/home/test',
      removeLegacyUserHooks: false,
    });

    expect(result.installed).toEqual(['.codex/hooks.json', '.claude/settings.local.json']);
    expect(writeFileSync).toHaveBeenCalledWith(
      '/repo/.codex/hooks.json',
      expect.stringContaining('"command": "scip-query hook-context"'),
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      '/repo/.claude/settings.local.json',
      expect.stringContaining('"command": "scip-query hook-stop"'),
    );
  });

  it('keeps the deprecated shared hook flag checkout-local', async () => {
    const { module, writeFileSync } = await loadSetup();

    const result = module.installProjectAgentHooks('/repo', {
      homeDir: '/home/test',
      removeLegacyUserHooks: false,
      shared: true,
    });

    expect(result.installed).toEqual(['.codex/hooks.json', '.claude/settings.local.json']);
    expect(result.warnings).toContain(
      '--shared is deprecated; project hooks are always checkout-local and will not be committed.',
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      '/repo/.claude/settings.local.json',
      expect.stringContaining('"command": "scip-query hook-stop"'),
    );
  });

  it('remembers project hook removal with a Claude local tombstone', async () => {
    const { module, writeFileSync } = await loadSetup();

    const result = module.installProjectAgentHooks('/repo', {
      homeDir: '/home/test',
      remove: true,
    });

    expect(result.removed).toContain('.claude/settings.local.json');
    expect(writeFileSync).toHaveBeenCalledWith(
      '/repo/.claude/settings.local.json',
      expect.stringContaining('"scipQueryHooks": "declined"'),
    );
  });

  it('keeps legacy user hook installation available for migration utilities', async () => {
    const { module, writeFileSync } = await loadSetup();

    const result = module.installUserAgentHooks({ homeDir: '/home/test' });

    expect(result.installed).toEqual(['Codex/hooks.json', 'Claude/settings.json']);
    expect(writeFileSync).toHaveBeenCalledWith(
      '/home/test/.codex/hooks.json',
      expect.stringContaining('"command": "scip-query hook-context"'),
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      '/home/test/.claude/settings.json',
      expect.stringContaining('"command": "scip-query hook-stop"'),
    );
  });

  it('respects hook installation opt-out', async () => {
    const { module, writeFileSync } = await loadSetup();

    const result = module.installUserAgentHooks({
      homeDir: '/home/test',
      env: { SCIP_QUERY_SKIP_HOOK_INSTALL: '1' },
    });

    expect(result.skipped).toEqual([{ target: 'user agent hooks', reason: 'SCIP_QUERY_SKIP_HOOK_INSTALL=1' }]);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('uninstalls only owned skill symlinks', async () => {
    const { module, existsSync, readlinkSync, readdirSync, unlinkSync } = await loadSetup();
    existsSync.mockImplementation((target: string) => {
      if (
        target === '/home/test/.claude/skills' ||
        target === '/home/test/.codex/skills' ||
        target === '/home/test/.agents/skills'
      ) {
        return true;
      }
      return false;
    });
    readdirSync.mockImplementation((target: string) => {
      if (target === '/home/test/.claude/skills') return ['scip-query', 'custom'];
      return [];
    });
    readlinkSync.mockImplementation((target: string) => {
      if (target.endsWith('/scip-query')) return '/pkg/skills/scip-query';
      if (target.endsWith('/custom')) return '/elsewhere/custom';
      throw new Error('not-a-link');
    });

    const result = module.uninstallSkills({ homeDir: '/home/test' });

    expect(result.removed).toEqual(['Claude/scip-query']);
    expect(result.left).toEqual(['Claude/custom (symlink outside scip-query package)']);
    expect(unlinkSync).toHaveBeenCalledWith('/home/test/.claude/skills/scip-query');
    expect(unlinkSync).not.toHaveBeenCalledWith('/home/test/.claude/skills/custom');
  });

  it('merges hook config without deleting user hooks', async () => {
    const { module } = await loadSetup();

    const merged = module.mergeScipHookConfig(
      {
        theme: 'dark',
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'echo keep-me' },
                { type: 'command', command: 'scip-query diff-gate --hook' },
              ],
            },
          ],
        },
      },
      'codex',
    );

    expect(merged.theme).toBe('dark');
    expect(merged.hooks?.Stop?.[0]?.hooks).toEqual([{ type: 'command', command: 'echo keep-me' }]);
    expect(merged.hooks?.Stop?.[1]?.hooks).toEqual([
      {
        type: 'command',
        command: 'scip-query hook-stop',
        timeout: 30,
        statusMessage: 'Running scip-query diff gate',
      },
    ]);
  });
});
