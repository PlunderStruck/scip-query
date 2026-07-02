import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { vueLargeViewPressure } from '../../../src/queries/frontend/vue-large-view-pressure.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

// followup #4: vue-large-view-pressure only counted template + inline/external
// <script> LOC and never followed a second hop into a composable the script
// delegates `setup:` work to. A small view whose entire behavior lives in a
// large useXViewController composable produced 0 findings despite the real
// pressure living one hop away.

function largeComposableSource(lines: number): string {
  const body = Array.from({ length: lines }, (_, index) => `  console.log('line ${index}');`).join('\n');
  return `export function useHorseReportViewController() {\n${body}\n  return { ready: true };\n}\n`;
}

const SMALL_VIEW_WITH_DELEGATION = `<template>
  <section>
    <HorseReport :ready="ready" />
  </section>
</template>
<script setup lang="ts">
import { useHorseReportViewController } from './useHorseReportViewController.js';

const { ready } = useHorseReportViewController();
</script>
`;

const SMALL_VIEW_WITHOUT_DELEGATION = `<template>
  <section>
    <HorseReport :ready="ready" />
  </section>
</template>
<script setup lang="ts">
const ready = true;
</script>
`;

describe('vue-large-view-pressure delegated-composable pressure', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  function createFixture(files: Record<string, string>): { db: ScipDatabase } {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-vue-view-pressure-'));
    const projectRoot = tempDir;
    writeFixtureFiles(projectRoot, files);
    const dbPath = join(projectRoot, 'index.db');
    const builder = evidenceFixtureDb(dbPath);
    let id = 1;
    for (const relativePath of Object.keys(files).sort()) {
      builder.document(id, relativePath.endsWith('.vue') ? 'vue' : 'typescript', relativePath);
      id += 1;
    }
    builder.write();
    const config: ScipQueryConfig = { dbPath, indexPath: join(projectRoot, 'index.scip'), projectRoot };
    return { db: new ScipDatabase(config) };
  }

  it('fires when a small view delegates to a large use* composable', () => {
    const { db } = createFixture({
      'src/views/HorseReportView.vue': SMALL_VIEW_WITH_DELEGATION,
      'src/views/useHorseReportViewController.ts': largeComposableSource(900),
    });
    try {
      const results = vueLargeViewPressure(db, {
        minTotalLines: 800,
        minTemplateLines: 100000,
        minScriptLines: 100000,
        minStyleLines: 100000,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(
        expect.objectContaining({
          file: 'src/views/HorseReportView.vue',
          delegatedComposablePaths: ['src/views/useHorseReportViewController.ts'],
        }),
      );
      expect(results[0]?.delegatedComposableLines).toBeGreaterThan(800);
      expect(results[0]?.totalLines).toBeGreaterThan(800);
      expect(results[0]?.reasons.some((reason) => reason.includes('delegated composable'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('does not fire the same view without delegation (current behavior preserved)', () => {
    const { db } = createFixture({
      'src/views/HorseReportView.vue': SMALL_VIEW_WITHOUT_DELEGATION,
    });
    try {
      const results = vueLargeViewPressure(db, {
        minTotalLines: 800,
        minTemplateLines: 100000,
        minScriptLines: 100000,
        minStyleLines: 100000,
      });

      expect(results).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('does not fire when the view imports a composable it never invokes', () => {
    const unusedImportView = `<template>
  <section>
    <HorseReport />
  </section>
</template>
<script setup lang="ts">
import { useHorseReportViewController } from './useHorseReportViewController.js';
const label = 'unused: ' + typeof useHorseReportViewController;
</script>
`;
    const { db } = createFixture({
      'src/views/HorseReportView.vue': unusedImportView,
      'src/views/useHorseReportViewController.ts': largeComposableSource(900),
    });
    try {
      const results = vueLargeViewPressure(db, {
        minTotalLines: 800,
        minTemplateLines: 100000,
        minScriptLines: 100000,
        minStyleLines: 100000,
      });

      expect(results).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
