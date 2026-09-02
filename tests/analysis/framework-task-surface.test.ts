import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../src/storage/db.js';
import { frameworkTaskSurface, isFrameworkTaskFile } from '../../src/analysis/framework-task-surface.js';
import { isEntrySurface } from '../../src/analysis/file-classifier.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('framework task surface', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): ScipDatabase {
    const root = mkdtempSync(join(tmpdir(), 'scip-task-surface-'));
    tempDirs.push(root);
    writeFixtureFiles(root, files);
    const dbPath = join(root, 'index.db');
    const builder = evidenceFixtureDb(dbPath);
    let id = 1;
    for (const file of Object.keys(files).sort()) {
      if (!file.endsWith('.ts')) continue;
      builder.document(id, 'typescript', file);
      id += 1;
    }
    builder.write();
    return new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
  }

  it('reads Trigger.dev task directories from trigger.config.ts and treats them as entry surfaces', () => {
    const db = fixture({
      'trigger.config.ts': `import { defineConfig } from '@trigger.dev/sdk/v3';
export default defineConfig({ project: 'proj_x', dirs: ['./src/jobs', './src/schedules'], retries: {} });
`,
      'src/jobs/sync.ts': "export const syncTask = task({ id: 'sync', run: async () => {} });\n",
      'src/schedules/nightly.ts': "export const nightly = schedules.task({ id: 'nightly', run: async () => {} });\n",
      'src/lib/util.ts': 'export const util = 1;\n',
    });
    try {
      expect(frameworkTaskSurface(db).directories).toEqual([
        { directory: 'src/jobs', framework: 'trigger.dev', config: 'trigger.config.ts' },
        { directory: 'src/schedules', framework: 'trigger.dev', config: 'trigger.config.ts' },
      ]);
      expect(isFrameworkTaskFile(db, 'src/jobs/sync.ts')).toBe(true);
      expect(isEntrySurface(db, 'src/schedules/nightly.ts')).toBe(true);
      expect(isEntrySurface(db, 'src/lib/util.ts')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('falls back to the default src/trigger directory when the config declares no dirs', () => {
    const db = fixture({
      'trigger.config.ts': "export default defineConfig({ project: 'proj_x' });\n",
      'src/trigger/job.ts': "export const job = task({ id: 'job', run: async () => {} });\n",
    });
    try {
      expect(isFrameworkTaskFile(db, 'src/trigger/job.ts')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('declares no task surface without a framework config', () => {
    const db = fixture({ 'src/trigger/job.ts': 'export const job = 1;\n' });
    try {
      expect(frameworkTaskSurface(db).directories).toEqual([]);
      expect(isFrameworkTaskFile(db, 'src/trigger/job.ts')).toBe(false);
    } finally {
      db.close();
    }
  });
});
