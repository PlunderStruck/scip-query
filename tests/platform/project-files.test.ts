import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildProjectInputFingerprint,
  buildProjectInputFingerprintFromJournal,
  fingerprintProjectFiles,
  InputTooLargeError,
  probeProjectFileBytes,
  readProjectFileText,
  resolveProjectFile,
  UnsafeProjectPathError,
} from '../../src/platform/project-files.js';
import {
  projectFileFingerprintCacheStats,
  resetProjectFileFingerprintCacheForTest,
} from '../../src/platform/fingerprint-stat-cache.js';
import { LANGUAGE_INDEX_MARKERS } from '../../src/domain/project-input.js';

const tempDirs: string[] = [];

afterEach(() => {
  resetProjectFileFingerprintCacheForTest();
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

  it('fingerprints configured TypeScript project directories through files rather than unreadable directory entries', () => {
    const projectRoot = temporaryDirectory('scip-query-typescript-project-fingerprint-');
    mkdirSync(join(projectRoot, 'apps/web/src'), { recursive: true });
    writeFileSync(join(projectRoot, 'apps/web/tsconfig.json'), '{"include":["src/**/*.ts"]}\n');
    writeFileSync(join(projectRoot, 'apps/web/src/main.ts'), 'export const value = 1;\n');

    const fingerprint = buildProjectInputFingerprint(projectRoot, ['typescript'], {
      typescriptProjectMode: 'workspace',
      typescriptProjects: ['apps/web'],
    });

    expect(fingerprint.typescriptProjects).toEqual(['apps/web']);
    expect(fingerprint.files.map((file) => file.path)).toEqual(['apps/web/src/main.ts', 'apps/web/tsconfig.json']);
    expect(fingerprint.files.every((file) => file.hash !== 'unreadable' && file.size >= 0)).toBe(true);
  });

  it('omits a tracked file deleted from the worktree instead of marking it unreadable', () => {
    const projectRoot = temporaryDirectory('scip-query-deleted-project-file-');
    writeFileSync(join(projectRoot, 'value.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init', '--quiet'], { cwd: projectRoot });
    execFileSync('git', ['add', 'value.ts'], { cwd: projectRoot });
    rmSync(join(projectRoot, 'value.ts'));

    expect(fingerprintProjectFiles(projectRoot)).toEqual([]);
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
    expect(first.files.map((file) => file.path)).toEqual(['.scipquery.json', 'src.ts', 'tsconfig.scip.json']);

    writeFileSync(join(projectRoot, '.scipquery', 'events', 'event.json'), '{"changed":true}\n');
    expect(buildProjectInputFingerprint(projectRoot, ['typescript'], {})).toEqual(first);

    writeFileSync(join(projectRoot, 'docs', 'guide.md'), '# Changed guide\n');
    expect(buildProjectInputFingerprint(projectRoot, ['typescript'], {})).toEqual(first);

    writeFileSync(join(projectRoot, 'docs', 'guide.md'), '# Guide\n');
    writeFileSync(join(projectRoot, 'src.ts'), 'export const value = 2;\n');
    expect(buildProjectInputFingerprint(projectRoot, ['typescript'], {})).not.toEqual(first);
  });

  it('fingerprints only source files selected by the TypeScript project', () => {
    const projectRoot = temporaryDirectory('scip-query-typescript-input-boundary-');
    mkdirSync(join(projectRoot, 'src'));
    mkdirSync(join(projectRoot, 'tests'));
    writeFileSync(join(projectRoot, 'tsconfig.json'), '{"include":["src/**/*.ts"],"exclude":["tests"]}\n');
    writeFileSync(join(projectRoot, 'src/main.ts'), 'export const value = 1;\n');
    writeFileSync(join(projectRoot, 'tests/main.test.ts'), 'export const testValue = 1;\n');

    const before = buildProjectInputFingerprint(projectRoot, ['typescript'], {});
    expect(before.files.map((file) => file.path)).toEqual(['src/main.ts', 'tsconfig.json']);

    writeFileSync(join(projectRoot, 'tests/main.test.ts'), 'export const testValue = 2;\n');
    expect(buildProjectInputFingerprint(projectRoot, ['typescript'], {})).toEqual(before);
  });

  it('isolates language fingerprints from unrelated dependency manifests', () => {
    const projectRoot = temporaryDirectory('scip-query-language-fingerprint-');
    mkdirSync(join(projectRoot, 'src'));
    writeFileSync(join(projectRoot, '.scipquery.json'), '{}\n');
    writeFileSync(join(projectRoot, 'src/main.ts'), 'export const value = 1;\n');
    writeFileSync(join(projectRoot, 'src/lib.rs'), 'pub const VALUE: i32 = 1;\n');
    writeFileSync(join(projectRoot, 'package.json'), '{}\n');
    writeFileSync(join(projectRoot, 'package-lock.json'), '{"lockfileVersion":3}\n');
    writeFileSync(join(projectRoot, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\n');
    writeFileSync(join(projectRoot, 'Cargo.lock'), 'version = 3\n');
    writeFileSync(join(projectRoot, 'README.md'), '# ignored\n');

    const typescript = fingerprintProjectFiles(projectRoot, {
      language: 'typescript',
      markerFiles: LANGUAGE_INDEX_MARKERS.typescript,
    });
    const rust = fingerprintProjectFiles(projectRoot, {
      language: 'rust',
      markerFiles: LANGUAGE_INDEX_MARKERS.rust,
    });

    expect(typescript.map((file) => file.path)).toEqual([
      '.scipquery.json',
      'package-lock.json',
      'package.json',
      'src/main.ts',
    ]);
    expect(rust.map((file) => file.path)).toEqual(['.scipquery.json', 'Cargo.lock', 'Cargo.toml', 'src/lib.rs']);

    writeFileSync(join(projectRoot, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
    expect(
      fingerprintProjectFiles(projectRoot, { language: 'rust', markerFiles: LANGUAGE_INDEX_MARKERS.rust }),
    ).toEqual(rust);
    expect(
      fingerprintProjectFiles(projectRoot, {
        language: 'typescript',
        markerFiles: LANGUAGE_INDEX_MARKERS.typescript,
      }),
    ).not.toEqual(typescript);
  });

  it('reuses content hashes when inode, size, mtime, and ctime are unchanged', () => {
    const projectRoot = temporaryDirectory('scip-query-fingerprint-stat-cache-');
    writeFileSync(join(projectRoot, 'value.ts'), 'export const value = 1;\n');

    const first = fingerprintProjectFiles(projectRoot);
    const afterFirst = projectFileFingerprintCacheStats(projectRoot);
    expect(afterFirst.stores).toBeGreaterThan(0);
    expect(first.find((file) => file.path === 'value.ts')?.hash).toMatch(/^[a-f0-9]{64}$/);

    const second = fingerprintProjectFiles(projectRoot);
    const afterSecond = projectFileFingerprintCacheStats(projectRoot);
    expect(second).toEqual(first);
    expect(afterSecond.hits).toBeGreaterThan(0);

    writeFileSync(join(projectRoot, 'value.ts'), 'export const value = 2;\n');
    const third = fingerprintProjectFiles(projectRoot);
    expect(third.find((file) => file.path === 'value.ts')?.hash).not.toBe(
      first.find((file) => file.path === 'value.ts')?.hash,
    );
  });

  it('derives the exact full fingerprint by replacing only a changed existing source', () => {
    const projectRoot = temporaryDirectory('scip-query-delta-project-fingerprint-');
    mkdirSync(join(projectRoot, 'src'));
    writeFileSync(join(projectRoot, 'tsconfig.json'), '{"include":["src/**/*.ts"]}\n');
    writeFileSync(join(projectRoot, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(projectRoot, 'src/b.ts'), 'export const b = 1;\n');
    const previous = buildProjectInputFingerprint(projectRoot, ['typescript'], {});

    writeFileSync(join(projectRoot, 'src/a.ts'), 'export const a = 2;\n');
    const result = buildProjectInputFingerprintFromJournal(
      projectRoot,
      ['typescript'],
      {},
      previous,
      {
        version: 1,
        baseGeneration: 'generation-a',
        complete: true,
        entries: [{ path: 'src/a.ts', kind: 'change' }],
      },
      'generation-a',
    );

    expect(result).toEqual({
      mode: 'delta',
      fingerprint: buildProjectInputFingerprint(projectRoot, ['typescript'], {}),
      changedPaths: ['src/a.ts'],
    });
  });

  it.each(['add', 'delete'] as const)('derives the exact full fingerprint for a source %s', (kind) => {
    const projectRoot = temporaryDirectory('scip-query-delta-add-delete-fingerprint-');
    mkdirSync(join(projectRoot, 'src'));
    writeFileSync(join(projectRoot, 'tsconfig.json'), '{"include":["src/**/*.ts"]}\n');
    writeFileSync(join(projectRoot, 'src/a.ts'), 'export const a = 1;\n');
    const previous = buildProjectInputFingerprint(projectRoot, ['typescript'], {});
    const changedPath = kind === 'add' ? 'src/b.ts' : 'src/a.ts';
    if (kind === 'add') writeFileSync(join(projectRoot, changedPath), 'export const b = 1;\n');
    else rmSync(join(projectRoot, changedPath));

    const result = buildProjectInputFingerprintFromJournal(
      projectRoot,
      ['typescript'],
      {},
      previous,
      {
        version: 1,
        baseGeneration: 'generation-a',
        complete: true,
        entries: [{ path: changedPath, kind }],
      },
      'generation-a',
    );

    expect(result).toEqual({
      mode: 'delta',
      fingerprint: buildProjectInputFingerprint(projectRoot, ['typescript'], {}),
      changedPaths: [changedPath],
    });
  });

  it('reuses the accepted snapshot when watcher coalescing proves a net-empty change set', () => {
    const projectRoot = temporaryDirectory('scip-query-delta-empty-fingerprint-');
    mkdirSync(join(projectRoot, 'src'));
    writeFileSync(join(projectRoot, 'src/a.ts'), 'export const a = 1;\n');
    const previous = buildProjectInputFingerprint(projectRoot, ['typescript'], {});

    expect(
      buildProjectInputFingerprintFromJournal(
        projectRoot,
        ['typescript'],
        {},
        previous,
        { version: 1, baseGeneration: 'generation-a', complete: true, entries: [] },
        'generation-a',
      ),
    ).toEqual({ mode: 'delta', fingerprint: previous, changedPaths: [] });
  });

  it.each([
    ['incomplete journal', false, 'generation-a', 'src/a.ts', 'change', 'change-journal-incomplete:test-gap'],
    ['wrong base', true, 'generation-b', 'src/a.ts', 'change', 'change-journal-base-mismatch'],
    ['configuration input', true, 'generation-a', 'tsconfig.json', 'change', 'non-source-project-input-changed'],
    [
      'existing source reported as added',
      true,
      'generation-a',
      'src/a.ts',
      'add',
      'added-path-already-in-prior-project-input-snapshot',
    ],
    [
      'unknown source reported as deleted',
      true,
      'generation-a',
      'src/missing.ts',
      'delete',
      'deleted-path-not-in-prior-project-input-snapshot',
    ],
  ] as const)(
    'uses a named full-scan fallback for %s',
    (_label, complete, baseGeneration, path, kind, expectedReason) => {
      const projectRoot = temporaryDirectory('scip-query-delta-fallback-');
      mkdirSync(join(projectRoot, 'src'));
      writeFileSync(join(projectRoot, 'tsconfig.json'), '{"include":["src/**/*.ts"]}\n');
      writeFileSync(join(projectRoot, 'src/a.ts'), 'export const a = 1;\n');
      const previous = buildProjectInputFingerprint(projectRoot, ['typescript'], {});
      if (kind === 'add' && path !== 'src/a.ts') writeFileSync(join(projectRoot, path), 'export const added = 1;\n');
      if (kind === 'delete' && path === 'src/a.ts') rmSync(join(projectRoot, path));

      const result = buildProjectInputFingerprintFromJournal(
        projectRoot,
        ['typescript'],
        {},
        previous,
        {
          version: 1,
          baseGeneration,
          complete,
          ...(complete ? {} : { incompleteReason: 'test-gap' }),
          entries: [{ path, kind }],
        },
        'generation-a',
      );

      expect(result.mode).toBe('full');
      expect(result).toEqual(expect.objectContaining({ reason: expectedReason }));
      expect(result.fingerprint).toEqual(buildProjectInputFingerprint(projectRoot, ['typescript'], {}));
    },
  );
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

  it('probes UTF-8 literals across read-buffer boundaries without materializing misses', () => {
    const projectRoot = temporaryDirectory('scip-query-project-probe-');
    const bufferBytes = 1024 * 1024;
    const source = `${'a'.repeat(bufferBytes - 1)}🙂${'b'.repeat(bufferBytes - 6)}needle-tail`;
    writeFileSync(join(projectRoot, 'source.ts'), source);
    writeFileSync(join(projectRoot, 'binary.bin'), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
    writeFileSync(join(projectRoot, 'invalid-utf8.bin'), Buffer.from([0xc3]));

    const match = probeProjectFileBytes(projectRoot, 'source.ts', Buffer.from('needle'), { computeSha256: true });
    expect(match).toMatchObject({
      byteLength: Buffer.byteLength(source),
      isUtf8Text: true,
      includesLiteral: true,
      sha256: createHash('sha256').update(source).digest('hex'),
    });
    expect(match.bytes?.toString('utf8')).toBe(source);
    expect(probeProjectFileBytes(projectRoot, 'source.ts', Buffer.from('absent')).bytes).toBeNull();
    expect(() =>
      probeProjectFileBytes(projectRoot, 'source.ts', Buffer.from('needle'), {
        maxBytes: Buffer.byteLength(source) - 1,
      }),
    ).toThrow(InputTooLargeError);
    expect(probeProjectFileBytes(projectRoot, 'binary.bin', Buffer.from('needle'))).toMatchObject({
      isUtf8Text: false,
      includesLiteral: false,
      bytes: null,
    });
    expect(probeProjectFileBytes(projectRoot, 'invalid-utf8.bin', Buffer.from('needle'))).toMatchObject({
      isUtf8Text: false,
      includesLiteral: false,
      bytes: null,
    });
  });
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}
