import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { drift } from '../../../src/queries/index.js';

function createDocumentsOnlyDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      language TEXT,
      relative_path TEXT NOT NULL UNIQUE,
      position_encoding TEXT,
      text TEXT
    );
    CREATE TABLE global_symbols (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      display_name TEXT,
      kind INTEGER,
      documentation TEXT,
      signature BLOB,
      enclosing_symbol TEXT,
      relationships BLOB
    );
    CREATE TABLE defn_enclosing_ranges (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      start_char INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      end_char INTEGER NOT NULL
    );
    CREATE TABLE mentions (
      chunk_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      role INTEGER NOT NULL,
      PRIMARY KEY (chunk_id, symbol_id, role)
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      occurrences BLOB NOT NULL
    );
    INSERT INTO documents (id, language, relative_path) VALUES
      (1, 'typescript', 'src/views/HorseProfileView.script.ts'),
      (2, 'typescript', 'src/views/HorseProfilePanel.vue'),
      (3, 'typescript', 'src/views/panel-model.ts'),
      (4, 'typescript', 'src/views/used-helper.ts'),
      (5, 'typescript', 'src/views/unused-helper.ts');
  `);
  db.close();
}

function withDriftFixture(run: (db: ScipDatabase) => void): void {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-drift-accuracy-'));
  const dbPath = join(projectRoot, 'index.db');

  mkdirSync(join(projectRoot, 'src/views'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'src/views/HorseProfileView.script.ts'),
    [
      "import HorseProfilePanel from './HorseProfilePanel.vue';",
      "import type { HorsePanelMode } from './panel-model';",
      "import { usedHelper } from './used-helper';",
      "import { unusedHelper } from './unused-helper';",
      '',
      'type ViewState = { mode: HorsePanelMode };',
      'const label = usedHelper();',
      'export default {',
      '  components: { HorseProfilePanel },',
      '  data: (): ViewState => ({ mode: label }),',
      '};',
      '',
    ].join('\n'),
  );
  writeFileSync(join(projectRoot, 'src/views/HorseProfilePanel.vue'), '<template><section /></template>\n');
  writeFileSync(join(projectRoot, 'src/views/panel-model.ts'), "export type HorsePanelMode = 'care' | 'records';\n");
  writeFileSync(
    join(projectRoot, 'src/views/used-helper.ts'),
    "export function usedHelper(): 'care' { return 'care'; }\n",
  );
  writeFileSync(join(projectRoot, 'src/views/unused-helper.ts'), 'export function unusedHelper(): void {}\n');
  createDocumentsOnlyDb(dbPath);

  const db = new ScipDatabase({
    dbPath,
    indexPath: join(projectRoot, 'index.scip'),
    projectRoot,
  });
  try {
    run(db);
  } finally {
    db.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

describe('drift accuracy', () => {
  it('does not report Vue component imports as unused drift', () => {
    withDriftFixture((db) => {
      const summary = drift(db);

      expect(summary.results).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'unused-import',
            dep: 'src/views/HorseProfilePanel.vue',
          }),
        ]),
      );
      expect(summary.results).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'unused-import',
            dep: 'src/views/panel-model.ts',
          }),
        ]),
      );
      expect(summary.results).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'unused-import',
            dep: 'src/views/used-helper.ts',
          }),
        ]),
      );
      expect(summary.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'unused-import',
            dep: 'src/views/unused-helper.ts',
          }),
        ]),
      );
    });
  });
});
