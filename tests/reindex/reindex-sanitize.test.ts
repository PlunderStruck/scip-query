import Database from 'better-sqlite3';
import fc from 'fast-check';
import { zstdDecompressSync } from 'node:zlib';
import { fromBinary } from '@bufbuild/protobuf';
import { convertScipBufferToSqlite } from '../../src/reindex/scip-sqlite-converter.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import {
  deserializeSCIP,
  DocumentSchema,
  IndexSchema,
  MetadataSchema,
  OccurrenceSchema,
  serializeSCIP,
  SymbolInformationSchema,
  SymbolRole,
} from '@c4312/scip';
import { sanitizeScipFile, sanitizeScipIndex } from '../../src/reindex/sanitize.js';

describe('SCIP sanitizer', () => {
  it('preserves document-local definition and reference occurrences without symbol metadata', () => {
    const index = create(IndexSchema, {
      documents: [
        create(DocumentSchema, {
          relativePath: 'local.py',
          language: 'python',
          occurrences: [
            create(OccurrenceSchema, { symbol: 'local 0', symbolRoles: SymbolRole.Definition, range: [0, 0, 1] }),
            create(OccurrenceSchema, { symbol: 'local 0', range: [1, 0, 1] }),
          ],
        }),
      ],
    });
    expect(sanitizeScipIndex(index).index.documents[0]!.occurrences).toEqual(index.documents[0]!.occurrences);
  });

  it('preserves occurrence evidence and is idempotent across repeated global and document-local identities', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(
            fc.record({
              identity: fc.integer({ min: 0, max: 8 }),
              local: fc.boolean(),
              definition: fc.boolean(),
              metadata: fc.boolean(),
            }),
            { maxLength: 30 },
          ),
          { minLength: 1, maxLength: 5 },
        ),
        (inputs) => {
          const index = create(IndexSchema, {
            documents: inputs.map((items, documentIndex) => {
              const names = items.map((item) =>
                item.local ? `local ${item.identity}` : `scip-python python project 1 module/value${item.identity}.`,
              );
              return create(DocumentSchema, {
                relativePath: `module${documentIndex}.py`,
                language: 'python',
                occurrences: items.map((item, line) =>
                  create(OccurrenceSchema, {
                    symbol: names[line],
                    symbolRoles: item.definition ? SymbolRole.Definition : 0,
                    range: [line, 0, 1],
                  }),
                ),
                symbols: items.flatMap((item, i) =>
                  item.metadata && !item.local
                    ? [create(SymbolInformationSchema, { symbol: names[i], displayName: `value${item.identity}` })]
                    : [],
                ),
              });
            }),
          });
          const repaired = sanitizeScipIndex(index);
          expect(repaired.removedDefinitionOccurrences).toBe(0);
          expect(repaired.index.documents.map((doc) => doc.occurrences)).toEqual(
            index.documents.map((doc) => doc.occurrences),
          );
          const known = new Set(repaired.index.documents.flatMap((doc) => doc.symbols.map((symbol) => symbol.symbol)));
          for (const doc of repaired.index.documents)
            for (const occurrence of doc.occurrences) {
              if (occurrence.symbolRoles & SymbolRole.Definition && !occurrence.symbol.startsWith('local '))
                expect(known.has(occurrence.symbol)).toBe(true);
            }
          expect(sanitizeScipIndex(repaired.index)).toEqual({
            index: repaired.index,
            removedDefinitionOccurrences: 0,
            touchedDocuments: 0,
          });
        },
      ),
      { seed: 20260909, numRuns: 1000 },
    );
  });

  it('recovers only missing metadata without deleting a nonempty global definition', () => {
    const symbol = 'scip-python python project 1.0.0 module/value.';
    const index = create(IndexSchema, {
      documents: [
        create(DocumentSchema, {
          relativePath: 'module.py',
          language: 'python',
          occurrences: [create(OccurrenceSchema, { symbol, symbolRoles: SymbolRole.Definition, range: [0, 0, 5] })],
        }),
      ],
    });
    const repaired = sanitizeScipIndex(index);
    expect(repaired.index.documents[0]!.occurrences).toEqual(index.documents[0]!.occurrences);
    expect(repaired.index.documents[0]!.symbols).toEqual([create(SymbolInformationSchema, { symbol })]);
  });

  it('recovers missing SymbolInformation without discarding definition or reference evidence', () => {
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

    expect(result.removedDefinitionOccurrences).toBe(0);
    expect(result.recoveredDefinitionSymbols).toBe(1);
    expect(result.touchedDocuments).toBe(1);
    expect(result.index.documents[0]!.occurrences.map((occurrence) => occurrence.symbol)).toEqual([
      valid,
      invalid,
      invalid,
    ]);
    expect(result.index.documents[0]!.occurrences[2]!.symbolRoles).toBe(0);
  });

  it.each(['../outside.ts', '/etc/passwd', 'C:\\Users\\outside.ts', '\\\\server\\share\\outside.ts'])(
    'refuses unsafe document path %s before publication',
    (relativePath) => {
      const index = create(IndexSchema, {
        documents: [
          create(DocumentSchema, {
            language: 'typescript',
            relativePath,
          }),
        ],
      });

      expect(() => sanitizeScipIndex(index)).toThrow(
        expect.objectContaining({
          name: 'UnsafeProjectPathError',
        }),
      );
    },
  );
});

describe('streaming SCIP file sanitizer', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function scipFile(index: ReturnType<typeof create<typeof IndexSchema>>): string {
    const dir = mkdtempSync(join(tmpdir(), 'scip-query-sanitize-'));
    tempDirs.push(dir);
    const path = join(dir, 'index.scip');
    writeFileSync(path, serializeSCIP(index));
    return path;
  }

  const defined = 'scip-typescript npm pkg 0.0.1 `src/a.ts`/run().';
  const dangling = 'scip-typescript npm pkg 0.0.1 `src/gen.ts`/Missing#';

  function documentWith(relativePath: string, occurrences: Parameters<typeof create<typeof OccurrenceSchema>>[1][]) {
    return create(DocumentSchema, {
      language: 'typescript',
      relativePath,
      symbols: [create(SymbolInformationSchema, { symbol: defined })],
      occurrences: occurrences.map((occurrence) => create(OccurrenceSchema, occurrence)),
    });
  }

  it('recovers missing metadata only in affected documents and preserves every occurrence', () => {
    const index = create(IndexSchema, {
      metadata: create(MetadataSchema, { projectRoot: 'file:///repo' }),
      documents: [
        documentWith('src/clean.ts', [{ symbol: defined, symbolRoles: SymbolRole.Definition, range: [0, 0, 3] }]),
        documentWith('src/dirty.ts', [
          { symbol: defined, symbolRoles: SymbolRole.Definition, range: [0, 0, 3] },
          { symbol: dangling, symbolRoles: SymbolRole.Definition, range: [1, 0, 7] },
          { symbol: dangling, symbolRoles: 0, range: [2, 0, 7] },
        ]),
        documentWith('src/also-clean.ts', [{ symbol: dangling, symbolRoles: 0, range: [0, 0, 7] }]),
      ],
      externalSymbols: [create(SymbolInformationSchema, { symbol: 'external . . . pkg/External#' })],
    });
    const path = scipFile(index);
    const expected = sanitizeScipIndex(index);

    const result = sanitizeScipFile(path);

    expect(result).toEqual({ removedDefinitionOccurrences: 0, touchedDocuments: 1, recoveredDefinitionSymbols: 1 });
    const rewritten = deserializeSCIP(readFileSync(path));
    expect(rewritten).toEqual(expected.index);
    expect(rewritten.documents[1]!.occurrences.map((occurrence) => occurrence.symbol)).toEqual([
      defined,
      dangling,
      dangling,
    ]);
    expect(rewritten.metadata?.projectRoot).toBe('file:///repo');
    expect(rewritten.externalSymbols).toHaveLength(1);
  });

  it('keeps definitions proven only by external symbols and leaves the clean file untouched', () => {
    const external = 'external . . . pkg/External#';
    const index = create(IndexSchema, {
      documents: [
        documentWith('src/a.ts', [{ symbol: external, symbolRoles: SymbolRole.Definition, range: [0, 0, 3] }]),
      ],
      externalSymbols: [create(SymbolInformationSchema, { symbol: external })],
    });
    const path = scipFile(index);
    const before = readFileSync(path);

    expect(sanitizeScipFile(path)).toEqual({ removedDefinitionOccurrences: 0, touchedDocuments: 0 });
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it.each(['../outside.ts', '/etc/passwd'])('refuses unsafe document path %s in file form', (relativePath) => {
    const path = scipFile(
      create(IndexSchema, { documents: [create(DocumentSchema, { language: 'typescript', relativePath })] }),
    );

    expect(() => sanitizeScipFile(path)).toThrow(expect.objectContaining({ name: 'UnsafeProjectPathError' }));
  });

  it('retains local and metadata-less global definitions through streaming sanitization and SQLite conversion', async () => {
    const symbol = 'scip-python python project 1.0.0 module/value.';
    const original = [
      create(OccurrenceSchema, { symbol, symbolRoles: SymbolRole.Definition, range: [0, 0, 5] }),
      create(OccurrenceSchema, { symbol, range: [1, 0, 5] }),
      create(OccurrenceSchema, { symbol: 'local 0', symbolRoles: SymbolRole.Definition, range: [2, 0, 1] }),
      create(OccurrenceSchema, { symbol: 'local 0', range: [3, 0, 1] }),
    ];
    const path = scipFile(
      create(IndexSchema, {
        documents: [
          create(DocumentSchema, {
            relativePath: 'module.py',
            language: 'python',
            occurrences: original,
          }),
        ],
      }),
    );
    expect(sanitizeScipFile(path)).toEqual({
      removedDefinitionOccurrences: 0,
      touchedDocuments: 1,
      recoveredDefinitionSymbols: 1,
    });
    const bytes = readFileSync(path);
    expect(deserializeSCIP(bytes).documents[0]!.occurrences).toEqual(original);
    await convertScipBufferToSqlite(bytes, path + '.db');
    const db = new Database(path + '.db');
    try {
      expect(db.prepare('SELECT symbol, kind, display_name FROM global_symbols').all()).toEqual([
        { symbol, kind: null, display_name: null },
      ]);
      expect(db.prepare('SELECT count(*) AS n FROM mentions WHERE role = 1').get()).toEqual({ n: 1 });
      const chunk = db.prepare('SELECT occurrences FROM chunks').get() as { occurrences: Buffer };
      expect(fromBinary(DocumentSchema, zstdDecompressSync(chunk.occurrences)).occurrences).toEqual(original);
    } finally {
      db.close();
    }
  });

  it('removes only empty definition identities while preserving highlighting-only occurrences', () => {
    const index = create(IndexSchema, {
      documents: [
        create(DocumentSchema, {
          relativePath: 'empty.py',
          occurrences: [
            create(OccurrenceSchema, { symbolRoles: SymbolRole.Definition, range: [0, 0, 1] }),
            create(OccurrenceSchema, { range: [1, 0, 1] }),
          ],
        }),
      ],
    });
    const path = scipFile(index);
    expect(sanitizeScipFile(path)).toEqual({ removedDefinitionOccurrences: 1, touchedDocuments: 1 });
    expect(deserializeSCIP(readFileSync(path))).toEqual(sanitizeScipIndex(index).index);
    expect(deserializeSCIP(readFileSync(path)).documents[0]!.occurrences).toHaveLength(1);
  });

  it('treats malformed wire data as unreadable input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scip-query-sanitize-'));
    tempDirs.push(dir);
    const path = join(dir, 'broken.scip');
    writeFileSync(path, Buffer.from([0x12, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));

    expect(sanitizeScipFile(path)).toEqual({ removedDefinitionOccurrences: 0, touchedDocuments: 0 });
  });
});
