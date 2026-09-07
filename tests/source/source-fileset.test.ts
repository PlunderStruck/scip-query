import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSourceFiles, sourceFrameworkApplicability } from '../../src/source/primitives/source-fileset.js';
import { clearRegisteredCaches } from '../../src/storage/cache-registry.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb } from '../fixtures/evidence-fixture.js';

describe('source fileset', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function openFixtureDb(projectRoot: string, dbPath: string): ScipDatabase {
    evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/index.ts').write();
    return new ScipDatabase({
      projectRoot,
      dbPath,
      indexPath: join(tempDir!, 'index.scip'),
    });
  }

  it('uses git listing to add unindexed auxiliary sources without duplicating indexed files', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-source-fileset-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    mkdirSync(join(projectRoot, 'dist'), { recursive: true });
    writeFileSync(join(projectRoot, '.gitignore'), 'dist/\n');
    writeFileSync(join(projectRoot, 'src', 'index.ts'), 'export const indexed = true;\n');
    writeFileSync(join(projectRoot, 'src', 'App.vue'), '<template><main /></template>\n');
    writeFileSync(join(projectRoot, 'dist', 'Ignored.vue'), '<template><main /></template>\n');
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });

    const db = openFixtureDb(projectRoot, join(tempDir, 'index.db'));
    try {
      expect(getSourceFiles(db)).toEqual(['src/App.vue', 'src/index.ts']);
    } finally {
      db.close();
    }
  });

  it('falls back to recursive source listing outside git repositories', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-source-fileset-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    mkdirSync(join(projectRoot, 'dist'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'index.ts'), 'export const indexed = true;\n');
    writeFileSync(join(projectRoot, 'src', 'App.vue'), '<template><main /></template>\n');
    writeFileSync(join(projectRoot, 'dist', 'Ignored.vue'), '<template><main /></template>\n');

    const db = openFixtureDb(projectRoot, join(tempDir, 'index.db'));
    try {
      expect(getSourceFiles(db)).toEqual(['src/App.vue', 'src/index.ts']);
    } finally {
      db.close();
    }
  });

  it('preserves exact Git filenames, including whitespace and quoted characters', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-source-fileset-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    const paths = ['src/line\nname.ts', 'src/café.ts', 'src/"quoted".ts', ' space.ts'];
    for (const path of paths) writeFileSync(join(projectRoot, path), 'export const value = 1;');
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    const db = openFixtureDb(projectRoot, join(tempDir, 'index.db'));
    try {
      expect(getSourceFiles(db, { includeIndexed: false })).toEqual([...paths].sort());
    } finally {
      db.close();
    }
  });

  it('refreshes auxiliary membership after a file-scoped source invalidation', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-source-fileset-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    const db = openFixtureDb(projectRoot, join(tempDir, 'index.db'));
    try {
      expect(getSourceFiles(db, { includeIndexed: false })).toEqual([]);
      writeFileSync(join(projectRoot, 'src/new.ts'), 'export const added = true;');
      clearRegisteredCaches(db, { groups: ['source-file'], file: 'src/new.ts' });
      expect(getSourceFiles(db, { includeIndexed: false })).toEqual(['src/new.ts']);
      rmSync(join(projectRoot, 'src/new.ts'));
      clearRegisteredCaches(db, { groups: ['source-file'], file: 'src/new.ts' });
      expect(getSourceFiles(db, { includeIndexed: false })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('reports an unavailable source tree instead of returning a successful partial inventory', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-source-fileset-'));
    const db = openFixtureDb(join(tempDir, 'missing'), join(tempDir, 'index.db'));
    try {
      expect(() => getSourceFiles(db)).toThrow(/ENOENT/);
    } finally {
      db.close();
    }
  });

  it('reports framework applicability within the requested scope', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-source-fileset-'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'apps', 'web'), { recursive: true });
    mkdirSync(join(projectRoot, 'apps', 'admin'), { recursive: true });
    writeFileSync(join(projectRoot, 'apps', 'web', 'App.tsx'), 'export function App() { return null; }\n');
    writeFileSync(join(projectRoot, 'apps', 'admin', 'Panel.vue'), '<template><main /></template>\n');

    const db = openFixtureDb(projectRoot, join(tempDir, 'index.db'));
    try {
      expect(sourceFrameworkApplicability(db)).toEqual({ react: true, vue: true });
      expect(sourceFrameworkApplicability(db, { scope: 'apps/web' })).toEqual({ react: true, vue: false });
      expect(sourceFrameworkApplicability(db, { scope: 'apps/admin' })).toEqual({ react: false, vue: true });
      expect(sourceFrameworkApplicability(db, { scope: 'packages/api' })).toEqual({ react: false, vue: false });
    } finally {
      db.close();
    }
  });
});
