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

  it('rewrites only documents with dangling definitions and copies the rest verbatim', () => {
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

    expect(result).toEqual({ removedDefinitionOccurrences: 1, touchedDocuments: 1 });
    const rewritten = deserializeSCIP(readFileSync(path));
    expect(rewritten).toEqual(expected.index);
    expect(rewritten.documents[1]!.occurrences.map((occurrence) => occurrence.symbol)).toEqual([defined, dangling]);
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

  it('treats malformed wire data as unreadable input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scip-query-sanitize-'));
    tempDirs.push(dir);
    const path = join(dir, 'broken.scip');
    writeFileSync(path, Buffer.from([0x12, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));

    expect(sanitizeScipFile(path)).toEqual({ removedDefinitionOccurrences: 0, touchedDocuments: 0 });
  });
});
