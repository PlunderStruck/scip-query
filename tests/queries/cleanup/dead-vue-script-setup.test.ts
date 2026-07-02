/**
 * Reproduces docs/plans/2026-07-02-followups.md item 3 / the 2026-07-01
 * Stable_Management calibration false positive: `useHorseReportPrintView`
 * and `usePublicInvoicePrintView` were flagged "zero indexed consumers" by
 * `new-dead` even though both are imported and called directly from their
 * sibling `.vue` SFC's `<script setup>` block.
 *
 * Live investigation (see the accompanying commit message) found this
 * archetype already fixed on the current codebase before any 23.3-specific
 * change — `refs`/`dead` on both real symbols, re-measured live against
 * the calibration clone on the exact cited commit (`5eeacef38`), now
 * correctly resolve the `.vue` consumer through the source-fallback layer's
 * Vue SFC scanning (`scanSourceReferences({ includeVueSfc: true })`), which
 * reads `.vue` files directly from disk regardless of whether scip-typescript
 * augmentation captured a mention row for them. This is a regression
 * fixture locking that behavior in, not a new fix.
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { dead } from '../../../src/queries/cleanup/dead.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { createEvidenceSchema } from '../../fixtures/evidence-fixture.js';

function withVueScriptSetupFixture(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-dead-vue-script-setup-'));
  const projectRoot = join(tempDir, 'project');
  const dbPath = join(tempDir, 'index.db');
  try {
    const composablePath = join(projectRoot, 'src', 'composables', 'useWidget.ts');
    mkdirSync(dirname(composablePath), { recursive: true });
    writeFileSync(composablePath, ['export function useWidget() {', "  return { value: 'ok' };", '}', ''].join('\n'));

    const componentPath = join(projectRoot, 'src', 'components', 'Widget.vue');
    mkdirSync(dirname(componentPath), { recursive: true });
    writeFileSync(
      componentPath,
      [
        '<script setup lang="ts">',
        "import { useWidget } from '../composables/useWidget';",
        '',
        'const { value } = useWidget();',
        '</script>',
        '',
        '<template>',
        '  <div>{{ value }}</div>',
        '</template>',
        '',
      ].join('\n'),
    );

    const sqliteDb = new Database(dbPath);
    createEvidenceSchema(sqliteDb);
    sqliteDb.exec(`
      INSERT INTO documents (id, language, relative_path) VALUES
        (1, 'typescript', 'src/composables/useWidget.ts');

      INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
        (1, 'scip-typescript npm fixture 1.0.0 src/composables/\`useWidget.ts\`/useWidget().', 'useWidget', 3, 'function useWidget');

      INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
        (1, 1, 1, 0, 0, 2, 1);

      INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
        (1, 1, 0, 0, 2, X'00');

      -- Definition-site row only. Widget.vue is deliberately NOT registered
      -- as an indexed document and has zero mention rows anywhere for
      -- useWidget — this reproduces the "SFC augmentation captured nothing"
      -- shape the calibration report suspected, so the only remaining
      -- evidence is the source-fallback scan reading Widget.vue from disk.
      INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
        (1, 1, 1);
    `);
    sqliteDb.close();

    const config: ScipQueryConfig = { dbPath, indexPath: join(tempDir, 'index.scip'), projectRoot };
    const db = new ScipDatabase(config);
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('dead — Vue <script setup> composable consumer', () => {
  it('does not report a composable as dead when its only consumer is a sibling <script setup> SFC', () => {
    withVueScriptSetupFixture((db) => {
      const result = dead(db, { minLoc: 1, semantic: false });
      const hit = result.symbols.find((s) => s.shortName.endsWith('useWidget()'));
      expect(hit).toBeUndefined();
    });
  });
});
