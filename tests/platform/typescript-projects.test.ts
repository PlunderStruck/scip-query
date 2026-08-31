import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  typeScriptProjectInputPaths,
  typeScriptProjectSelectionIsTreeOwned,
} from '../../src/platform/typescript-projects.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('TypeScript project selection tree ownership', () => {
  it('accepts tracked normal configs in single and workspace project modes', () => {
    const singleRoot = temporaryDirectory('scip-query-typescript-tree-owned-single-');
    writeFileSync(join(singleRoot, 'tsconfig.json'), '{"include":["src/**/*.ts"]}\n');

    expect(typeScriptProjectSelectionIsTreeOwned(singleRoot, 'single', [], ['tsconfig.json'])).toBe(true);

    const workspaceRoot = temporaryDirectory('scip-query-typescript-tree-owned-workspace-');
    mkdirSync(join(workspaceRoot, 'packages', 'a'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'packages', 'a', 'tsconfig.json'), '{"include":["src/**/*.ts"]}\n');

    expect(
      typeScriptProjectSelectionIsTreeOwned(workspaceRoot, 'workspace', ['packages/a'], ['packages/a/tsconfig.json']),
    ).toBe(true);
  });

  it('rejects an ignored or inherited config because Git cannot prove its selected inputs', () => {
    const root = temporaryDirectory('scip-query-typescript-tree-owned-unproven-');
    const tsconfigPath = join(root, 'tsconfig.json');
    writeFileSync(tsconfigPath, '{"include":["src/**/*.ts"]}\n');

    expect(typeScriptProjectSelectionIsTreeOwned(root, 'single', [], [])).toBe(false);

    writeFileSync(tsconfigPath, '{"extends":"./base.json","include":["src/**/*.ts"]}\n');
    expect(typeScriptProjectSelectionIsTreeOwned(root, 'single', [], ['tsconfig.json'])).toBe(false);
  });

  it('rejects a config symlink because its target can change outside the Git tree', () => {
    const root = temporaryDirectory('scip-query-typescript-tree-owned-symlink-');
    const tsconfigPath = join(root, 'tsconfig.json');
    writeFileSync(tsconfigPath, '{"include":["src/**/*.ts"]}\n');
    unlinkSync(tsconfigPath);
    writeFileSync(join(root, 'actual.json'), '{"include":["src/**/*.ts"]}\n');
    symlinkSync('actual.json', tsconfigPath);

    expect(typeScriptProjectSelectionIsTreeOwned(root, 'single', [], ['tsconfig.json'])).toBe(false);
  });
});

describe('TypeScript project input paths', () => {
  it('treats a valid project with no matching files as an exact empty scope', () => {
    const root = temporaryDirectory('scip-query-typescript-empty-inputs-');
    mkdirSync(join(root, 'packages', 'app'), { recursive: true });
    writeFileSync(join(root, 'packages', 'app', 'tsconfig.json'), '{"include":["src/**/*.ts"]}\n');

    expect(typeScriptProjectInputPaths(root, 'workspace', ['packages/app'])).toEqual(new Set());
  });
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}
