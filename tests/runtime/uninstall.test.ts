import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { uninstallProject } from '../../src/runtime/uninstall.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('uninstallProject', () => {
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
