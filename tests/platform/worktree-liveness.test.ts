import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureWorktreeLivenessIdentity,
  worktreeLivenessIdentityIsCurrent,
} from '../../src/platform/worktree-liveness.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('worktree liveness identity', () => {
  it('remains current across ordinary edits', () => {
    const root = temporaryDirectory();
    const gitDir = join(root, '.git');
    mkdirSync(gitDir);
    const identity = captureWorktreeLivenessIdentity(root, gitDir);

    writeFileSync(join(root, 'changed.ts'), 'export const changed = true;\n');

    expect(worktreeLivenessIdentityIsCurrent(identity)).toBe(true);
  });

  it('detects a removed project root', () => {
    const root = temporaryDirectory();
    const identity = captureWorktreeLivenessIdentity(root);

    rmSync(root, { recursive: true, force: true });

    expect(worktreeLivenessIdentityIsCurrent(identity)).toBe(false);
  });

  it('detects a replacement created at the same pathname', () => {
    const root = temporaryDirectory();
    const identity = captureWorktreeLivenessIdentity(root);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);

    expect(worktreeLivenessIdentityIsCurrent(identity)).toBe(false);
  });

  it('detects removal or replacement of the Git control directory', () => {
    const root = temporaryDirectory();
    const gitDir = join(root, '.git');
    mkdirSync(gitDir);
    const identity = captureWorktreeLivenessIdentity(root, gitDir);
    rmSync(gitDir, { recursive: true, force: true });
    mkdirSync(gitDir);

    expect(worktreeLivenessIdentityIsCurrent(identity)).toBe(false);
  });
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-worktree-liveness-'));
  roots.push(root);
  return root;
}
