import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';
import { collectBaselineFindings } from '../../../src/queries/health/health-baseline.js';

describe('health baseline completeness', () => {
  it('records duplicate groups beyond the report display limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-baseline-completeness-'));
    try {
      const builder = evidenceFixtureDb(join(root, 'index.db'));
      const files: Record<string, string> = {};
      let id = 0;
      for (let group = 0; group < 52; group += 1) {
        for (const side of ['a', 'b']) {
          const file = `src/${side}/group${group}.ts`;
          files[file] =
            `export function sample() {\n  const first = ${group};\n  const second = first + 1;\n  return second;\n}\n`;
          id += 1;
          builder
            .document(id, 'typescript', file)
            .symbol(id, `scip-typescript npm fixture 1.0.0 \`${file}\`/sample().`, 'sample', 17)
            .definition(id, id, id, 0, 0, 4, 1);
        }
      }
      writeFixtureFiles(root, files);
      builder.write();
      const db = new ScipDatabase({ projectRoot: root, dbPath: join(root, 'index.db') });
      try {
        expect(collectBaselineFindings(db).filter((finding) => finding.startsWith('duplicate-bodies:'))).toHaveLength(
          52,
        );
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
