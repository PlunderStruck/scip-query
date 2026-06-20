import { describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { DocumentSchema, IndexSchema, OccurrenceSchema, SymbolInformationSchema, SymbolRole } from '@c4312/scip';
import { sanitizeScipIndex } from '../../src/reindex/sanitize.js';

describe('SCIP sanitizer', () => {
  it('drops definition occurrences missing SymbolInformation before conversion', () => {
    const valid = 'scip-python python project 0.0.1 `pkg.module`/run().';
    const invalid = 'scip-python python project 0.0.1 `pkg.generated`/Missing#';
    const index = create(IndexSchema, {
      documents: [
        create(DocumentSchema, {
          language: 'python',
          relativePath: 'pkg/module.py',
          symbols: [
            create(SymbolInformationSchema, {
              symbol: valid,
              displayName: 'run',
            }),
          ],
          occurrences: [
            create(OccurrenceSchema, {
              symbol: valid,
              symbolRoles: SymbolRole.Definition,
              range: [0, 0, 0, 3],
            }),
            create(OccurrenceSchema, {
              symbol: invalid,
              symbolRoles: SymbolRole.Definition,
              range: [1, 0, 1, 7],
            }),
            create(OccurrenceSchema, {
              symbol: invalid,
              symbolRoles: 0,
              range: [2, 0, 2, 7],
            }),
          ],
        }),
      ],
    });

    const result = sanitizeScipIndex(index);

    expect(result.removedDefinitionOccurrences).toBe(1);
    expect(result.touchedDocuments).toBe(1);
    expect(result.index.documents[0]!.occurrences.map((occurrence) => occurrence.symbol)).toEqual([valid, invalid]);
    expect(result.index.documents[0]!.occurrences[1]!.symbolRoles).toBe(0);
  });
});
