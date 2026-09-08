import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { it, vi } from 'vitest';
import * as affectedSet from '../../src/reindex/affected-set.js';
import * as publication from '../../src/reindex/incremental-sqlite-publication.js';
import { IndexerHistoryFixture } from './indexer-history-fixture.js';
import { PROPERTY_TIMEOUT } from './support.js';

it(
  'indexing: the clean-rebuild assertion catches a planner that omits dependent files',
  async () => {
    const fixture = new IndexerHistoryFixture();
    try {
      await fixture.index();
      fixture.startService();
      const original = affectedSet.planAffectedFiles;
      let injected = 0;
      const mutation = vi.spyOn(affectedSet, 'planAffectedFiles').mockImplementation((...args) => {
        const result = original(...args);
        if (result.mode === 'closure' && result.affectedFiles.length > result.changedFiles.length) {
          injected++;
          return { ...result, affectedFiles: result.changedFiles };
        }
        return result;
      });
      try {
        fixture.write('owner.ts', 'export const value = (input: number) => input + 91;\n');
        await fixture.index({ allowExpensiveRebuild: false });
        assert.ok(injected > 0, 'The intentional planner defect must have executed');
        assert.equal(fixture.publication()?.publication?.mode, 'incremental');
        assert.throws(() => fixture.assertCurrent(), /Published compiler facts must match/);
      } finally {
        mutation.mockRestore();
      }
      // Discarding the index is allowed only in this negative-control fixture:
      // the test intentionally published a falsely accepted corrupt result.
    } finally {
      await fixture.dispose();
    }
  },
  PROPERTY_TIMEOUT,
);

it(
  'indexing: the clean-rebuild assertion catches publication that keeps the old database rows',
  async () => {
    const fixture = new IndexerHistoryFixture();
    try {
      await fixture.index();
      fixture.startService();
      const original = publication.patchIncrementalSqliteGeneration;
      let injected = 0;
      const mutation = vi.spyOn(publication, 'patchIncrementalSqliteGeneration').mockImplementation((input) => {
        const result = original(input);
        copyFileSync(input.previousDbPath, input.candidateDbPath);
        injected++;
        return result;
      });
      try {
        fixture.write('owner.ts', 'export const value = (input: number) => input + 92;\n');
        await fixture.index({ allowExpensiveRebuild: false });
        assert.ok(injected > 0, 'The intentional publication defect must have executed');
        assert.equal(fixture.publication()?.publication?.mode, 'incremental');
        assert.throws(() => fixture.assertCurrent(), /Published compiler facts must match/);
      } finally {
        mutation.mockRestore();
      }
    } finally {
      await fixture.dispose();
    }
  },
  PROPERTY_TIMEOUT,
);
