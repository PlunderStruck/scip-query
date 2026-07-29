import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installProjectAgentHooks, selectSetupHooksMode } from '../../src/runtime/agent-hooks.js';

const roots: string[] = [];

function createGitRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-local-hooks-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('checkout-local project hooks', () => {
  it('keeps setup-hooks modes explicit and rejects contradictory flags', () => {
    expect(selectSetupHooksMode({})).toEqual({ ok: true, mode: 'install' });
    expect(selectSetupHooksMode({ force: true })).toEqual({ ok: true, mode: 'install' });
    expect(selectSetupHooksMode({ remove: true })).toEqual({ ok: true, mode: 'remove' });
    expect(selectSetupHooksMode({ remove: true, dryRun: true })).toEqual({ ok: true, mode: 'preview-remove' });
    expect(selectSetupHooksMode({ remove: true, force: true })).toEqual({
      ok: false,
      message: '--remove cannot be combined with --force; force only reinstalls hooks.',
    });
    expect(selectSetupHooksMode({ dryRun: true })).toEqual({
      ok: false,
      message: '--dry-run requires --remove; installation is already non-destructive to user-owned hooks.',
    });
  });

  it('installs provider configs without creating a Git worktree diff', () => {
    const root = createGitRoot();

    const first = installProjectAgentHooks(root, { removeLegacyUserHooks: false });
    const second = installProjectAgentHooks(root, { removeLegacyUserHooks: false });

    expect(first.installed).toEqual(['.codex/hooks.json', '.claude/settings.local.json']);
    expect(first.gitExcluded).toEqual(['.codex/hooks.json', '.claude/settings.local.json']);
    expect(second.unchanged).toEqual(['.codex/hooks.json', '.claude/settings.local.json']);
    const claude = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf-8')) as {
      hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
    };
    expect(claude.hooks?.['PreToolUse']?.[0]).toMatchObject({
      matcher: 'Bash|Grep|Glob',
      hooks: [{ command: expect.stringContaining('hook-pretool') }],
    });
    expect(claude.hooks?.['PostCompact']?.[0]?.hooks?.[0]?.command).toContain('hook-context');
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf-8')).toContain(
      '# scip-query:local-hooks:begin\n/.codex/hooks.json\n/.claude/settings.local.json\n# scip-query:local-hooks:end',
    );
    expect(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf-8' }),
    ).toBe('');
  });

  it('does not persist a repository-local scip-query executable identity', () => {
    const root = createGitRoot();
    const localBin = join(root, 'node_modules', '.bin', 'scip-query');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(localBin, '#!/bin/sh\nexit 99\n');

    installProjectAgentHooks(root, { removeLegacyUserHooks: false });

    const claude = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    const commands = Object.values(claude.hooks ?? {})
      .flatMap((groups) => groups)
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command ?? '');
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => !command.includes(localBin) && !command.includes(root))).toBe(true);
  });

  it('keeps the deprecated shared flag local', () => {
    const root = createGitRoot();

    const result = installProjectAgentHooks(root, { shared: true, removeLegacyUserHooks: false });

    expect(result.warnings).toContain(
      '--shared is deprecated; project hooks are always checkout-local and will not be committed.',
    );
    expect(existsSync(join(root, '.claude', 'settings.local.json'))).toBe(true);
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false);
  });

  it('does not mutate a provider config already tracked by the repository', () => {
    const root = createGitRoot();
    const path = join(root, '.codex', 'hooks.json');
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(path, '{"team":"owned"}\n');
    execFileSync('git', ['add', '.codex/hooks.json'], { cwd: root });

    const result = installProjectAgentHooks(root, { removeLegacyUserHooks: false });

    expect(result.skipped).toContainEqual({
      target: '.codex/hooks.json',
      reason: 'tracked repository config; checkout-local hook setup will not modify it',
    });
    expect(readFileSync(path, 'utf-8')).toBe('{"team":"owned"}\n');
    expect(result.installed).toContain('.claude/settings.local.json');
  });

  it('preserves unknown provider fields while installing and removing owned hooks', () => {
    const root = createGitRoot();
    const path = join(root, '.claude', 'settings.local.json');
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ theme: 'dark', futureProviderField: { retained: true } }, null, 2)}\n`);

    installProjectAgentHooks(root, { removeLegacyUserHooks: false });
    const installed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(installed).toMatchObject({
      theme: 'dark',
      futureProviderField: { retained: true },
    });

    installProjectAgentHooks(root, { remove: true, removeLegacyUserHooks: false });
    const removed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(removed).toMatchObject({
      theme: 'dark',
      futureProviderField: { retained: true },
      scipQueryHooks: 'declined',
    });
  });

  it('reports malformed latest provider JSON and leaves it byte-for-byte unchanged', () => {
    const root = createGitRoot();
    const path = join(root, '.codex', 'hooks.json');
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(path, '{broken\n');

    const result = installProjectAgentHooks(root, { removeLegacyUserHooks: false });

    expect(result.skipped).toContainEqual({
      target: '.codex/hooks.json',
      reason: expect.stringContaining('latest hook config is invalid JSON'),
    });
    expect(readFileSync(path, 'utf8')).toBe('{broken\n');
  });

  it('removes owned Codex hooks and keeps the ignored Claude opt-out', () => {
    const root = createGitRoot();
    installProjectAgentHooks(root, { removeLegacyUserHooks: false });

    const result = installProjectAgentHooks(root, { remove: true, removeLegacyUserHooks: false });

    expect(result.removed).toContain('.codex/hooks.json');
    expect(result.removed).toContain('.claude/settings.local.json');
    expect(existsSync(join(root, '.codex', 'hooks.json'))).toBe(false);
    expect(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf-8')).toContain(
      '"scipQueryHooks": "declined"',
    );
    expect(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf-8' }),
    ).toBe('');
  });

  it('removes hooks without resolving an install-only command identity', () => {
    const root = createGitRoot();
    installProjectAgentHooks(root, { removeLegacyUserHooks: false });

    const result = installProjectAgentHooks(root, {
      remove: true,
      removeLegacyUserHooks: false,
      get commandPrefix(): never {
        throw new Error('removal must not resolve an installation command');
      },
    });

    expect(result.removed).toEqual(['.codex/hooks.json', '.claude/settings.local.json']);
  });

  it('previews removal without changing either project hook file', () => {
    const root = createGitRoot();
    installProjectAgentHooks(root, { removeLegacyUserHooks: false });
    const codexBefore = readFileSync(join(root, '.codex', 'hooks.json'), 'utf8');
    const claudeBefore = readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8');

    const result = installProjectAgentHooks(root, {
      remove: true,
      dryRun: true,
      removeLegacyUserHooks: false,
    });

    expect(result.removed).toEqual(['.codex/hooks.json', '.claude/settings.local.json']);
    expect(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8')).toBe(codexBefore);
    expect(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8')).toBe(claudeBefore);
  });
});
