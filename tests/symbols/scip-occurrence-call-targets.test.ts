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
import {
  scipOccurrenceCallableReferencesForRange,
  scipOccurrenceCallTargetsForRange,
} from '../../src/symbols/graph/scip-occurrence-call-targets.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

const TARGET_SYMBOL = 'scip-typescript npm fixture 1.0.0 src/`service.ts`/Service#execute().';
const CALLBACK_SYMBOL = 'scip-typescript npm fixture 1.0.0 src/`registry.ts`/mergeResults().';

describe('SCIP occurrence call targets for source ranges', () => {
  it('admits exact compiler targets while keeping unmatched source calls unresolved', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-source-range-callees-'));
    const dbPath = join(projectRoot, 'index.db');
    const indexPath = join(projectRoot, 'index.scip');
    writeFixtureFiles(projectRoot, {
      'src/registry.ts': [
        'function mergeResults(left: number, right: number) { return left + right; }',
        'export const registry = {',
        '  run() {',
        '    helper();',
        '    return service.execute();',
        '  },',
        '  combine(values: number[]) {',
        '    return values.reduce(mergeResults, 0);',
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
      .symbol(2, CALLBACK_SYMBOL, 'mergeResults')
      .definition(2, 1, 2, 0, 0, 0, 76)
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
                  range: [4, 19, 4, 26],
                }),
                create(OccurrenceSchema, {
                  symbol: CALLBACK_SYMBOL,
                  symbolRoles: SymbolRole.Definition,
                  range: [0, 9, 0, 21],
                }),
                create(OccurrenceSchema, {
                  symbol: CALLBACK_SYMBOL,
                  symbolRoles: 0,
                  range: [7, 25, 7, 37],
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
      const result = scipOccurrenceCallTargetsForRange(db, 'src/registry.ts', 1, 5);
      expect(result.available).toBe(true);
      expect(result.resolvedCallsites).toBe(1);
      expect(result.unresolvedCallsites).toBe(1);
      expect(result.targets).toEqual([
        expect.objectContaining({
          sourceLine: 4,
          calleeLeaf: 'execute',
          definition: expect.objectContaining({ symbol: TARGET_SYMBOL, relativePath: 'src/service.ts' }),
        }),
      ]);

      const references = scipOccurrenceCallableReferencesForRange(db, 'src/registry.ts', 6, 8);
      expect(references).toEqual({
        available: true,
        targets: [
          expect.objectContaining({
            sourceLine: 7,
            calleeLeaf: 'mergeResults',
            definition: expect.objectContaining({ symbol: CALLBACK_SYMBOL, relativePath: 'src/registry.ts' }),
          }),
        ],
      });
    } finally {
      db.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
