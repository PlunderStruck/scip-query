import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverTypeScriptProjectRoots } from '../../src/reindex/typescript-projects.js';

const tempDirs: string[] = [];

function createProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scip-query-ts-projects-'));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('discoverTypeScriptProjectRoots', () => {
  it('keeps leaf project roots and includes the repository root when root tsconfig covers subdirectories', () => {
    const projectRoot = createProject();
    writeJson(join(projectRoot, 'tsconfig.json'), { include: ['src'] });
    writeJson(join(projectRoot, 'packages/a/tsconfig.json'), { include: ['src'] });
    writeJson(join(projectRoot, 'packages/a/nested/tsconfig.json'), { include: ['src'] });
    writeJson(join(projectRoot, 'packages/b/tsconfig.app.json'), { files: ['src/main.ts'] });
    writeJson(join(projectRoot, 'dist/tsconfig.json'), { include: ['src'] });

    expect(discoverTypeScriptProjectRoots(projectRoot)).toEqual(['.', 'packages/a/nested', 'packages/b']);
  });

  it('accepts configured project directories and tsconfig paths', () => {
    const projectRoot = createProject();
    writeJson(join(projectRoot, 'apps/web/tsconfig.json'), { include: ['src'] });
    writeJson(join(projectRoot, 'tools/tsconfig.node.json'), { references: [] });

    expect(discoverTypeScriptProjectRoots(projectRoot, ['apps/web', 'tools/tsconfig.node.json'])).toEqual([
      'apps/web',
      'tools',
    ]);
  });

  it('treats a non-empty configured project list as authoritative, skipping discovery and root-alongside', () => {
    const projectRoot = createProject();
    writeJson(join(projectRoot, 'tsconfig.json'), { include: ['apps/*/src'] });
    writeJson(join(projectRoot, 'apps/web/tsconfig.json'), { include: ['src'] });
    writeJson(join(projectRoot, 'apps/api/tsconfig.json'), { include: ['src'] });
    writeJson(join(projectRoot, 'packages/lib/tsconfig.json'), { include: ['src'] });

    expect(discoverTypeScriptProjectRoots(projectRoot, ['apps/web', 'apps/api'])).toEqual(['apps/api', 'apps/web']);
  });

  it('falls back to discovery when every configured entry normalizes away', () => {
    const projectRoot = createProject();
    writeJson(join(projectRoot, 'tsconfig.json'), { include: ['apps/*/src'] });
    writeJson(join(projectRoot, 'apps/web/tsconfig.json'), { include: ['src'] });

    expect(discoverTypeScriptProjectRoots(projectRoot, ['does/not/exist', '../outside'])).toEqual(['.', 'apps/web']);
  });
});
