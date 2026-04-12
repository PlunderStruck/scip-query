import { afterEach, describe, expect, it, vi } from 'vitest';

type SetupModule = typeof import('../src/setup.js');

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
    if (target === '/home/test/.claude' || target === '/home/test/.codex') {
      return true;
    }
    if (target === '/home/test/.claude/skills' || target === '/home/test/.codex/skills') {
      return false;
    }
    if (target.startsWith('/home/test/.claude/skills/') || target.startsWith('/home/test/.codex/skills/')) {
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

  const module = await import('../src/setup.js');
  return { module, symlinkSync };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('skill installation', () => {
  it('includes the language playbook in the builtin skill list', async () => {
    const { module } = await loadSetup();

    expect(module.BUILTIN_SKILLS).toContain('scip-language-playbook');
  });

  it('installs the language playbook into Claude and Codex along with the other bundled skills', async () => {
    const { module, symlinkSync } = await loadSetup();

    const result = module.installSkills({ quiet: true });

    expect(result.installed).toContain('Claude/scip-language-playbook');
    expect(result.installed).toContain('Codex/scip-language-playbook');
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
  });
});
