import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describeIndexArtifactSet,
  indexArtifactPath,
  validateIndexArtifactRelativePath,
} from '../../src/reindex/index-artifacts.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('index artifact catalog', () => {
  it('includes stable and incremental artifacts but excludes mutable runtime files', () => {
    const cacheDir = createCompleteCache();
    mkdirSync(join(cacheDir, 'language-indexes/typescript-projects'), { recursive: true });
    writeFileSync(join(cacheDir, 'language-indexes/typescript.scip'), 'typescript');
    writeFileSync(join(cacheDir, 'language-indexes/typescript-projects/app.scip'), 'project');
    mkdirSync(join(cacheDir, 'typescript-scip-fragments/generations'), { recursive: true });
    writeFileSync(join(cacheDir, 'typescript-scip-fragments/generations/current.json'), '{}');
    writeFileSync(join(cacheDir, 'evidence.db'), 'private');
    writeFileSync(join(cacheDir, 'watch.lock'), 'private');

    expect(describeIndexArtifactSet(cacheDir).files).toEqual([
      'index.db',
      'index.scip',
      'language-indexes/typescript-projects/app.scip',
      'language-indexes/typescript.scip',
      'meta.json',
      'typescript-scip-fragments/generations/current.json',
    ]);
  });

  it('rejects missing required files, traversal, unknown roots, and symlinks', () => {
    const cacheDir = temporaryDirectory('scip-query-artifacts-');
    expect(() => describeIndexArtifactSet(cacheDir)).toThrow('required index artifact is missing');
    expect(() => validateIndexArtifactRelativePath('../index.db')).toThrow('invalid index artifact path');
    expect(() => validateIndexArtifactRelativePath('evidence.db')).toThrow('not shareable');
    expect(() => indexArtifactPath(cacheDir, '/tmp/index.db')).toThrow('invalid index artifact path');

    createCompleteCache(cacheDir);
    mkdirSync(join(cacheDir, 'language-indexes'), { recursive: true });
    symlinkSync(join(cacheDir, 'index.scip'), join(cacheDir, 'language-indexes/linked.scip'));
    expect(() => describeIndexArtifactSet(cacheDir)).toThrow('cannot be a symlink');
  });
});

function createCompleteCache(existing?: string): string {
  const cacheDir = existing ?? temporaryDirectory('scip-query-artifacts-');
  writeFileSync(join(cacheDir, 'index.db'), 'db');
  writeFileSync(join(cacheDir, 'index.scip'), 'scip');
  writeFileSync(join(cacheDir, 'meta.json'), '{}');
  return cacheDir;
}

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}
