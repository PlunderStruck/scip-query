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
import { sourceRangeNextAnchorPacket } from '../../src/queries/internal/next-anchor-candidates.js';
import { inspectSource } from '../../src/queries/navigation/source-inspection.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

const TARGET_SYMBOL = 'scip-typescript npm fixture 1.0.0 src/`service.ts`/Service#execute().';
const CALLBACK_SYMBOL = 'scip-typescript npm fixture 1.0.0 src/`registry.ts`/mergeResults().';
const FACTORY_CALLABLE_SYMBOL = 'scip-typescript npm fixture 1.0.0 src/`service.ts`/runWrapped.';

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
        'export function invokeWrapped() {',
        '  return runWrapped();',
        '}',
      ],
      'src/service.ts': [
        'export class Service {',
        '  execute() { return 1; }',
        '}',
        'export const runWrapped = Effect.fnUntraced(function* () { return 2; });',
      ],
    });
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/registry.ts')
      .document(2, 'typescript', 'src/service.ts')
      .symbol(1, TARGET_SYMBOL, 'execute')
      .definition(1, 2, 1, 1, 2, 1, 25)
      .symbol(2, CALLBACK_SYMBOL, 'mergeResults')
      .definition(2, 1, 2, 0, 0, 0, 76)
      .symbol(3, FACTORY_CALLABLE_SYMBOL, 'runWrapped', null, '```ts\nvar runWrapped: any\n```')
      .definition(3, 2, 3, 3, 0, 3, 72)
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
                create(OccurrenceSchema, {
                  symbol: FACTORY_CALLABLE_SYMBOL,
                  symbolRoles: 0,
                  range: [11, 9, 11, 19],
                }),
              ],
            }),
            create(DocumentSchema, {
              language: 'typescript',
              relativePath: 'src/service.ts',
              symbols: [
                create(SymbolInformationSchema, { symbol: TARGET_SYMBOL }),
                create(SymbolInformationSchema, { symbol: FACTORY_CALLABLE_SYMBOL }),
              ],
              occurrences: [
                create(OccurrenceSchema, {
                  symbol: TARGET_SYMBOL,
                  symbolRoles: SymbolRole.Definition,
                  range: [1, 2, 1, 9],
                }),
                create(OccurrenceSchema, {
                  symbol: FACTORY_CALLABLE_SYMBOL,
                  symbolRoles: SymbolRole.Definition,
                  range: [3, 13, 3, 23],
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

      const wrappedFactory = scipOccurrenceCallTargetsForRange(db, 'src/registry.ts', 10, 12);
      expect(wrappedFactory).toMatchObject({
        available: true,
        resolvedCallsites: 1,
        unresolvedCallsites: 0,
        targets: [
          expect.objectContaining({
            sourceLine: 11,
            calleeLeaf: 'runWrapped',
            definition: expect.objectContaining({ symbol: FACTORY_CALLABLE_SYMBOL, relativePath: 'src/service.ts' }),
          }),
        ],
      });

      const frontier = sourceRangeNextAnchorPacket(db, [
        {
          id: 'registry',
          label: 'registry',
          file: 'src/registry.ts',
          startLine: 1,
          endLine: 8,
        },
      ]);
      expect(frontier).toMatchObject({
        candidateAnchors: 1,
        graphEvidencedCallsites: 1,
        anchors: [
          expect.objectContaining({
            status: 'exact',
            direction: 'downstream',
            causalRole: 'callee',
            callsite: expect.objectContaining({ signals: expect.arrayContaining(['call', 'return']) }),
            alternatives: [expect.objectContaining({ symbol: TARGET_SYMBOL, file: 'src/service.ts', line: 1 })],
          }),
        ],
      });

      const inspection = inspectSource(db, { locations: ['src/registry.ts:2'], view: 'behavior' });
      expect(inspection.causalFrontier?.anchors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            alternatives: [expect.objectContaining({ symbol: TARGET_SYMBOL })],
          }),
        ]),
      );

      const boundedInspection = inspectSource(db, {
        locations: ['src/registry.ts:2'],
        view: 'behavior',
        maxCharacters: 1,
      });
      expect(boundedInspection.units).toHaveLength(0);
      expect(boundedInspection.omittedUnits).toBeGreaterThan(0);
      expect(boundedInspection.causalFrontier?.anchors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            alternatives: [expect.objectContaining({ symbol: TARGET_SYMBOL })],
          }),
        ]),
      );
    } finally {
      db.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
