import { mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_SOURCE_LIMIT_BYTES } from '../../src/platform/project-files.js';
import { getSourceText } from '../../src/source/primitives/source-text.js';
import type { ScipDatabase } from '../../src/storage/db.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('indexed source boundary', () => {
  it('does not disclose a sibling file selected by an indexed traversal path', () => {
    const parent = temporaryDirectory('scip-query-source-traversal-');
    const projectRoot = join(parent, 'project');
    const siblingPath = join(parent, 'secret.txt');
    writeFileSync(siblingPath, 'SCIP_QUERY_PATH_TRAVERSAL_WITNESS');
    writeFileSync(projectRoot, '');
    rmSync(projectRoot);
    const project = temporaryDirectoryAt(projectRoot);

    expect(() => getSourceText(fakeDatabase(project), '../secret.txt')).toThrow(
      expect.objectContaining({
        name: 'UnsafeProjectPathError',
        reason: 'parent-traversal',
      }),
    );
  });

  it('does not disclose a sibling file through an in-project symlink', () => {
    const parent = temporaryDirectory('scip-query-source-symlink-');
    const projectRoot = temporaryDirectoryAt(join(parent, 'project'));
    writeFileSync(join(parent, 'secret.txt'), 'SCIP_QUERY_SYMLINK_WITNESS');
    symlinkSync('../secret.txt', join(projectRoot, 'source.ts'));

    expect(() => getSourceText(fakeDatabase(projectRoot), 'source.ts')).toThrow(
      expect.objectContaining({
        name: 'UnsafeProjectPathError',
        reason: 'outside-project',
      }),
    );
  });

  it('returns an explicit bounded failure for an oversized indexed source', () => {
    const projectRoot = temporaryDirectory('scip-query-source-oversized-');
    const sourcePath = join(projectRoot, 'oversized.ts');
    writeFileSync(sourcePath, '');
    truncateSync(sourcePath, DEFAULT_PROJECT_SOURCE_LIMIT_BYTES + 1);

    expect(() => getSourceText(fakeDatabase(projectRoot), 'oversized.ts')).toThrow(
      expect.objectContaining({
        name: 'InputTooLargeError',
        observedBytes: DEFAULT_PROJECT_SOURCE_LIMIT_BYTES + 1,
        limitBytes: DEFAULT_PROJECT_SOURCE_LIMIT_BYTES,
      }),
    );
  });

  it('preserves ordinary source reads and missing-file behavior', () => {
    const projectRoot = temporaryDirectory('scip-query-source-positive-');
    writeFileSync(join(projectRoot, 'source.ts'), 'export const safe = true;\n');
    const db = fakeDatabase(projectRoot);

    expect(getSourceText(db, 'source.ts')).toBe('export const safe = true;\n');
    expect(getSourceText(db, 'missing.ts')).toBe('');
  });
});

function fakeDatabase(projectRoot: string): ScipDatabase {
  return { config: { projectRoot } } as ScipDatabase;
}

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function temporaryDirectoryAt(path: string): string {
  const created = mkdtempSync(`${path}-`);
  tempDirs.push(created);
  return created;
}
