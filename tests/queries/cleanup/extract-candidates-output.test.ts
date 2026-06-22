import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { extractCandidates } from '../../../src/queries/cleanup/extract-candidates.js';
import { health } from '../../../src/queries/health/health.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { createEvidenceSchema } from '../../fixtures/evidence-fixture.js';

function withExtractionFixture(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-extract-candidates-'));
  const dbPath = join(tempDir, 'index.db');
  try {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    const sqliteDb = new Database(dbPath);
    createEvidenceSchema(sqliteDb);
    sqliteDb.exec(`
      INSERT INTO documents (id, language, relative_path, text) VALUES
        (1, 'typescript', 'src/orchestrator.ts', '');

      INSERT INTO global_symbols (id, symbol, display_name, kind) VALUES
        (1, 'scip-typescript npm fixture 1.0.0 src/\`orchestrator.ts\`/processOrder().', 'processOrder', 6),
        (2, 'scip-typescript npm fixture 1.0.0 src/\`orchestrator.ts\`/loadOrder().', 'loadOrder', 6),
        (3, 'scip-typescript npm fixture 1.0.0 src/\`orchestrator.ts\`/validateOrder().', 'validateOrder', 6),
        (4, 'scip-typescript npm fixture 1.0.0 src/\`orchestrator.ts\`/normalizeOrder().', 'normalizeOrder', 6),
        (5, 'scip-typescript npm fixture 1.0.0 src/\`orchestrator.ts\`/chargeCard().', 'chargeCard', 6),
        (6, 'scip-typescript npm fixture 1.0.0 src/\`orchestrator.ts\`/sendReceipt().', 'sendReceipt', 6),
        (7, 'scip-typescript npm fixture 1.0.0 src/\`orchestrator.ts\`/recordAudit().', 'recordAudit', 6);

      INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
        (1, 1, 1, 0, 0, 39, 1),
        (2, 1, 2, 42, 0, 43, 1),
        (3, 1, 3, 45, 0, 46, 1),
        (4, 1, 4, 48, 0, 49, 1),
        (5, 1, 5, 51, 0, 52, 1),
        (6, 1, 6, 54, 0, 55, 1),
        (7, 1, 7, 57, 0, 58, 1);

      INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
        (1, 1, 0, 0, 12, X'00'),
        (2, 1, 1, 13, 30, X'00'),
        (3, 1, 2, 42, 43, X'00'),
        (4, 1, 3, 45, 46, X'00'),
        (5, 1, 4, 48, 49, X'00'),
        (6, 1, 5, 51, 52, X'00'),
        (7, 1, 6, 54, 55, X'00'),
        (8, 1, 7, 57, 58, X'00');

      INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
        (1, 1, 1),
        (3, 2, 1),
        (4, 3, 1),
        (5, 4, 1),
        (6, 5, 1),
        (7, 6, 1),
        (8, 7, 1),
        (1, 2, 0),
        (1, 3, 0),
        (1, 4, 0),
        (2, 5, 0),
        (2, 6, 0),
        (2, 7, 0);
    `);
    sqliteDb.close();

    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    };
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

describe('extractCandidates output classification', () => {
  it('labels extraction candidates as contextual workflow-orchestration signals', () => {
    withExtractionFixture((db) => {
      const results = extractCandidates(db, { minLoc: 20, minCallees: 6, semantic: false });
      const candidate = results.find((result) => result.shortName === 'src:orchestrator:processOrder()');

      expect(candidate).toBeDefined();
      expect(candidate).toMatchObject({
        actionTier: 'signal',
        extractionKind: 'workflow-orchestration',
        totalCallees: 6,
      });
      expect(candidate!.recommendation).toContain('keep the orchestration sequence together');
      expect(candidate!.evidenceReasons).toEqual(
        expect.arrayContaining([
          '6 distinct callees across 2 co-occurrence cluster(s)',
          '2 extractable cluster(s) passed size and isolation thresholds',
        ]),
      );
      expect(candidate!.clusters).toHaveLength(2);
      expect(candidate!.clusters.every((cluster) => cluster.isolation === 1)).toBe(true);

      const report = health(db);
      expect(report.findings.extractionCandidates).toBeGreaterThan(0);
      expect(report.scoreBreakdown.some((deduction) => deduction.axis === 'extract')).toBe(false);
      expect(report.actions.find((action) => action.category === 'Extraction candidates')?.description).toContain(
        'review same-file or feature-local extraction seams',
      );
    });
  });
});
