import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProjectInputFingerprint, fingerprintProjectFiles } from '../../src/platform/project-files.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('platform project file fingerprints', () => {
  it('identifies an in-project directory symlink by its tracked target instead of marking it unreadable', () => {
    const projectRoot = temporaryDirectory('scip-query-project-files-');
    mkdirSync(join(projectRoot, 'source'), { recursive: true });
    writeFileSync(join(projectRoot, 'source/value.ts'), 'export const value = 1;\n');
    symlinkSync('source', join(projectRoot, 'alias'));

    const before = fingerprintProjectFiles(projectRoot);
    const aliasBefore = before.find((file) => file.path === 'alias');
    expect(aliasBefore).toEqual(expect.objectContaining({ size: 'source'.length }));
    expect(aliasBefore?.hash).not.toBe('unreadable');

    writeFileSync(join(projectRoot, 'source/value.ts'), 'export const value = 2;\n');
    const afterTargetEdit = fingerprintProjectFiles(projectRoot);
    expect(afterTargetEdit.find((file) => file.path === 'alias')).toEqual(aliasBefore);
    expect(afterTargetEdit.find((file) => file.path === 'source/value.ts')?.hash).not.toBe(
      before.find((file) => file.path === 'source/value.ts')?.hash,
    );

    rmSync(join(projectRoot, 'alias'));
    symlinkSync('source/value.ts', join(projectRoot, 'alias'));
    expect(fingerprintProjectFiles(projectRoot).find((file) => file.path === 'alias')?.hash).not.toBe(
      aliasBefore?.hash,
    );
  });

  it('keeps an out-of-project symlink conservative', () => {
    const projectRoot = temporaryDirectory('scip-query-project-files-root-');
    const externalRoot = temporaryDirectory('scip-query-project-files-external-');
    writeFileSync(join(externalRoot, 'value.ts'), 'export const value = 1;\n');
    symlinkSync(join(externalRoot, 'value.ts'), join(projectRoot, 'external.ts'));

    expect(fingerprintProjectFiles(projectRoot).find((file) => file.path === 'external.ts')).toEqual({
      path: 'external.ts',
      size: -1,
      hash: 'unreadable',
    });
  });

  it('normalizes indexing options into one stable whole-project fingerprint', () => {
    const projectRoot = temporaryDirectory('scip-query-project-fingerprint-');
    writeFileSync(join(projectRoot, 'value.ts'), 'export const value = 1;\n');

    const first = buildProjectInputFingerprint(projectRoot, ['typescript'], {
      pnpmWorkspaces: true,
      typescriptProjects: [' packages/web ', 'packages/web'],
      clojureConfigPath: ' ',
    });
    const reordered = buildProjectInputFingerprint(projectRoot, ['typescript'], {
      pnpmWorkspaces: true,
      typescriptProjects: ['packages/web'],
    });

    expect(first).toEqual(reordered);
    expect(first.typescriptProjects).toEqual(['packages/web']);

    writeFileSync(join(projectRoot, 'value.ts'), 'export const value = 2;\n');
    expect(buildProjectInputFingerprint(projectRoot, ['typescript'], { pnpmWorkspaces: true })).not.toEqual(first);
  });
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}
