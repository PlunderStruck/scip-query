import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runUninstall, selectUninstallScope, uninstallProject } from '../../src/runtime/uninstall.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('uninstallProject', () => {
  it('requires an explicit scope for removal but previews both scopes safely', () => {
    expect(selectUninstallScope({})).toEqual({
      ok: false,
      message:
        'uninstall requires an explicit scope: use --global or --project. To preview both scopes without removing anything, run uninstall --dry-run.',
    });
    expect(selectUninstallScope({ global: true, project: true })).toEqual({
      ok: false,
      message: 'choose either --global or --project, not both.',
    });
    expect(selectUninstallScope({ global: true })).toEqual({ ok: true, global: true, project: false });
    expect(selectUninstallScope({ project: true })).toEqual({ ok: true, global: false, project: true });
    expect(selectUninstallScope({ dryRun: true })).toEqual({ ok: true, global: true, project: true });
  });

  it('refuses a destructive scope-free core call before inspecting targets', () => {
    expect(() =>
      runUninstall({
        projectRoot: '/path/that/does/not/need/to/exist',
        homeDir: '/another/missing/path',
      }),
    ).toThrow('uninstall requires an explicit scope');
  });

  it('reports shared suppression and outcome records that are intentionally left in place', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-uninstall-'));
    roots.push(root);
    execFileSync('git', ['-C', root, 'init'], { stdio: 'ignore' });
    mkdirSync(join(root, '.scipquery', 'suppressions'), { recursive: true });
    mkdirSync(join(root, '.scipquery', 'ledger'), { recursive: true });

    const result = uninstallProject(root, { dryRun: true });

    expect(result.left).toEqual([
      '.scipquery/suppressions/ (repository records)',
      '.scipquery/ledger/ (repository records)',
    ]);
  });
});
