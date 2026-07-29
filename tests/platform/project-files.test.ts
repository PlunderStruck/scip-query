import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildProjectInputFingerprint,
  fingerprintProjectFiles,
  InputTooLargeError,
  readProjectFileText,
  resolveProjectFile,
  UnsafeProjectPathError,
} from '../../src/platform/project-files.js';

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

  it('fingerprints repository inputs without letting scip-query record writes invalidate the index', () => {
    const projectRoot = temporaryDirectory('scip-query-project-input-boundary-');
    mkdirSync(join(projectRoot, 'docs'), { recursive: true });
    mkdirSync(join(projectRoot, '.scipquery', 'events'), { recursive: true });
    writeFileSync(join(projectRoot, 'src.ts'), 'export const value = 1;\n');
    writeFileSync(join(projectRoot, 'tsconfig.scip.json'), '{}\n');
    writeFileSync(join(projectRoot, '.scipquery.json'), '{}\n');
    writeFileSync(join(projectRoot, 'docs', 'guide.md'), '# Guide\n');
    writeFileSync(join(projectRoot, '.scipquery', 'events', 'event.json'), '{}\n');

    const first = buildProjectInputFingerprint(projectRoot, ['typescript'], {});
    expect(first.files.map((file) => file.path)).toEqual([
      '.scipquery.json',
      'docs/guide.md',
      'src.ts',
      'tsconfig.scip.json',
    ]);

    writeFileSync(join(projectRoot, '.scipquery', 'events', 'event.json'), '{"changed":true}\n');
    expect(buildProjectInputFingerprint(projectRoot, ['typescript'], {})).toEqual(first);

    writeFileSync(join(projectRoot, 'docs', 'guide.md'), '# Changed guide\n');
    expect(buildProjectInputFingerprint(projectRoot, ['typescript'], {})).not.toEqual(first);

    writeFileSync(join(projectRoot, 'docs', 'guide.md'), '# Guide\n');
    writeFileSync(join(projectRoot, 'src.ts'), 'export const value = 2;\n');
    expect(buildProjectInputFingerprint(projectRoot, ['typescript'], {})).not.toEqual(first);
  });
});

describe('project file authority boundary', () => {
  it.each([
    ['empty', ''],
    ['dot', '.'],
    ['parent', '../secret.txt'],
    ['nested parent', 'src/../../secret.txt'],
    ['POSIX absolute', '/etc/passwd'],
    ['Windows drive', 'C:\\Users\\secret.txt'],
    ['Windows drive-relative', 'C:secret.txt'],
    ['Windows UNC', '\\\\server\\share\\secret.txt'],
    ['NUL', 'src/value.ts\0secret'],
  ])('rejects %s path text before reading', (_label, candidatePath) => {
    const projectRoot = temporaryDirectory('scip-query-project-path-');

    expect(() => resolveProjectFile(projectRoot, candidatePath)).toThrow(UnsafeProjectPathError);
  });

  it('reads a regular file and an in-root symlink through one canonical proof', () => {
    const projectRoot = temporaryDirectory('scip-query-project-read-');
    mkdirSync(join(projectRoot, 'src'));
    writeFileSync(join(projectRoot, 'src/value.ts'), 'export const value = 1;\n');
    symlinkSync('value.ts', join(projectRoot, 'src/alias.ts'));

    expect(readProjectFileText(projectRoot, './src/value.ts')).toBe('export const value = 1;\n');
    expect(readProjectFileText(projectRoot, 'src/alias.ts')).toBe('export const value = 1;\n');
  });

  it('rejects a safe-looking symlink whose canonical target is outside the project', () => {
    const projectRoot = temporaryDirectory('scip-query-project-root-');
    const externalRoot = temporaryDirectory('scip-query-project-sibling-');
    writeFileSync(join(externalRoot, 'secret.txt'), 'not project data');
    symlinkSync(join(externalRoot, 'secret.txt'), join(projectRoot, 'source.ts'));

    expect(() => readProjectFileText(projectRoot, 'source.ts')).toThrow(
      expect.objectContaining({
        name: 'UnsafeProjectPathError',
        reason: 'outside-project',
      }),
    );
  });

  it('checks the byte budget before allocating the file contents', () => {
    const projectRoot = temporaryDirectory('scip-query-project-budget-');
    writeFileSync(join(projectRoot, 'source.ts'), '12345');

    expect(() => readProjectFileText(projectRoot, 'source.ts', { maxBytes: 4 })).toThrow(
      expect.objectContaining({
        name: InputTooLargeError.name,
        observedBytes: 5,
        limitBytes: 4,
      }),
    );
    expect(readProjectFileText(projectRoot, 'source.ts', { maxBytes: 5 })).toBe('12345');
  });
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}
