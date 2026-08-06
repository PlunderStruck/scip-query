import { create } from '@bufbuild/protobuf';
import {
  DocumentSchema,
  IndexSchema,
  OccurrenceSchema,
  serializeSCIP,
  SymbolInformationSchema,
  SymbolRole,
} from '@c4312/scip';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scipOccurrenceCallTargetsForRange } from '../../src/symbols/graph/scip-occurrence-call-targets.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

const TARGET_SYMBOL = 'scip-typescript npm fixture 1.0.0 src/`service.ts`/Service#execute().';

describe('SCIP occurrence call targets for source ranges', () => {
  it('admits exact compiler targets while keeping unmatched source calls unresolved', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-source-range-callees-'));
    const dbPath = join(projectRoot, 'index.db');
    const indexPath = join(projectRoot, 'index.scip');
    writeFixtureFiles(projectRoot, {
      'src/registry.ts': [
        'export const registry = {',
        '  run() {',
        '    helper();',
        '    return service.execute();',
        '  },',
        '};',
      ],
      'src/service.ts': ['export class Service {', '  execute() { return 1; }', '}'],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/registry.ts')
      .document(2, 'typescript', 'src/service.ts')
      .symbol(1, TARGET_SYMBOL, 'execute')
      .definition(1, 2, 1, 1, 2, 1, 25)
      .write();
    writeFileSync(
      indexPath,
      serializeSCIP(
        create(IndexSchema, {
          documents: [
            create(DocumentSchema, {
              language: 'typescript',
              relativePath: 'src/registry.ts',
              occurrences: [
                create(OccurrenceSchema, {
                  symbol: TARGET_SYMBOL,
                  symbolRoles: 0,
                  range: [3, 19, 3, 26],
                }),
              ],
            }),
            create(DocumentSchema, {
              language: 'typescript',
              relativePath: 'src/service.ts',
              symbols: [create(SymbolInformationSchema, { symbol: TARGET_SYMBOL })],
              occurrences: [
                create(OccurrenceSchema, {
                  symbol: TARGET_SYMBOL,
                  symbolRoles: SymbolRole.Definition,
                  range: [1, 2, 1, 9],
                }),
              ],
            }),
          ],
        }),
      ),
    );

    const db = new ScipDatabase({ dbPath, indexPath, projectRoot });
    try {
      const result = scipOccurrenceCallTargetsForRange(db, 'src/registry.ts', 1, 4);
      expect(result.available).toBe(true);
      expect(result.resolvedCallsites).toBe(1);
      expect(result.unresolvedCallsites).toBe(1);
      expect(result.targets).toEqual([
        expect.objectContaining({
          sourceLine: 3,
          calleeLeaf: 'execute',
          definition: expect.objectContaining({ symbol: TARGET_SYMBOL, relativePath: 'src/service.ts' }),
        }),
      ]);
    } finally {
      db.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
