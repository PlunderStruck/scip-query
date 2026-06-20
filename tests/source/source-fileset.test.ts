import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSourceFiles } from '../../src/source/source-fileset.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb } from '../fixtures/evidence-fixture.js';

describe('source fileset', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function openFixtureDb(projectRoot: string, dbPath: string): ScipDatabase {
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/index.ts')
      .write();
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
});
