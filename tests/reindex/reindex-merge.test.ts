import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { create } from '@bufbuild/protobuf';
import {
  deserializeSCIP,
  DocumentSchema,
  IndexSchema,
  MetadataSchema,
  OccurrenceSchema,
  serializeSCIP,
  SymbolInformationSchema,
} from '@c4312/scip';
import { mergeScipFiles, mergeScipIndexes } from '../../src/reindex/merge.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SCIP merge support', () => {
  it('merges overlapping documents and deduplicates external symbols', () => {
    const merged = mergeScipIndexes([
      createFixtureIndex({
        documents: [
          createDocument({
            language: 'typescript',
            relativePath: 'shared/file.ts',
            symbol: 'scip-typescript npm fixture 1.0.0 shared/`file.ts`/first().',
            text: 'export const first = 1;\n',
          }),
        ],
        externalSymbols: [
          createSymbolInformation({
            symbol: 'scip-typescript npm fixture 1.0.0 external/`dep.ts`/dep().',
            documentation: ['first docs'],
          }),
        ],
      }),
      createFixtureIndex({
        documents: [
          createDocument({
            language: 'python',
            relativePath: 'shared/file.ts',
            symbol: 'scip-python python fixture 1.0.0 shared/file.py/process().',
            text: 'def process():\n    return 1\n',
          }),
          createDocument({
            language: 'python',
            relativePath: 'scripts/task.py',
            symbol: 'scip-python python fixture 1.0.0 scripts/task.py/run().',
            text: 'def run():\n    return 2\n',
          }),
        ],
        externalSymbols: [
          createSymbolInformation({
            symbol: 'scip-typescript npm fixture 1.0.0 external/`dep.ts`/dep().',
            documentation: ['second docs'],
            displayName: 'dep',
          }),
        ],
      }),
    ]);

    expect(merged.metadata?.projectRoot).toBe('file:///tmp/scip-query-fixture');
    expect(merged.documents).toHaveLength(2);

    const sharedFile = merged.documents.find((document) => document.relativePath === 'shared/file.ts');
    expect(sharedFile).toBeDefined();
    expect(sharedFile?.occurrences).toHaveLength(2);
    expect(sharedFile?.symbols).toHaveLength(2);
    expect(sharedFile?.text).toContain('def process');

    expect(merged.externalSymbols).toHaveLength(1);
    expect(merged.externalSymbols[0]?.documentation).toEqual(['first docs', 'second docs']);
    expect(merged.externalSymbols[0]?.displayName).toBe('dep');
  });

  it('writes a merged SCIP file that round-trips cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scip-query-merge-'));
    tempDirs.push(dir);

    const firstPath = join(dir, 'first.scip');
    const secondPath = join(dir, 'second.scip');
    const mergedPath = join(dir, 'merged.scip');

    writeFileSync(
      firstPath,
      Buffer.from(
        serializeSCIP(
          createFixtureIndex({
            documents: [
              createDocument({
                language: 'typescript',
                relativePath: 'src/a.ts',
                symbol: 'scip-typescript npm fixture 1.0.0 src/`a.ts`/a().',
                text: 'export const a = 1;\n',
              }),
            ],
          }),
        ),
      ),
    );

    writeFileSync(
      secondPath,
      Buffer.from(
        serializeSCIP(
          createFixtureIndex({
            documents: [
              createDocument({
                language: 'python',
                relativePath: 'src/b.py',
                symbol: 'scip-python python fixture 1.0.0 src/b.py/b().',
                text: 'def b():\n    return 1\n',
              }),
            ],
          }),
        ),
      ),
    );

    const result = mergeScipFiles([firstPath, secondPath], mergedPath);
    const merged = deserializeSCIP(readFileSync(mergedPath));

    expect(result).toMatchObject({
      inputCount: 2,
      documentCount: 2,
    });
    expect(merged.documents.map((document) => document.relativePath)).toEqual(['src/a.ts', 'src/b.py']);
  });

  it('deduplicates exact duplicate occurrences in overlapping documents', () => {
    const duplicate = createDocument({
      language: 'typescript',
      relativePath: 'src/shared.ts',
      symbol: 'scip-typescript npm fixture 1.0.0 src/`shared.ts`/shared().',
      text: 'export const shared = 1;\n',
    });

    const merged = mergeScipIndexes([
      createFixtureIndex({ documents: [duplicate] }),
      createFixtureIndex({ documents: [duplicate] }),
    ]);

    const shared = merged.documents.find((document) => document.relativePath === 'src/shared.ts');
    expect(shared?.occurrences).toHaveLength(1);
    expect(shared?.symbols).toHaveLength(1);
  });
});

function createFixtureIndex(opts: {
  documents: ReturnType<typeof createDocument>[];
  externalSymbols?: ReturnType<typeof createSymbolInformation>[];
}) {
  return create(IndexSchema, {
    metadata: create(MetadataSchema, {
      projectRoot: 'file:///tmp/scip-query-fixture',
    }),
    documents: opts.documents,
    externalSymbols: opts.externalSymbols ?? [],
  });
}

function createDocument(opts: { language: string; relativePath: string; symbol: string; text: string }) {
  return create(DocumentSchema, {
    language: opts.language,
    relativePath: opts.relativePath,
    occurrences: [
      create(OccurrenceSchema, {
        range: [0, 0, 0],
        symbol: opts.symbol,
      }),
    ],
    symbols: [
      createSymbolInformation({
        symbol: opts.symbol,
        displayName: opts.symbol.split('/').pop() ?? opts.symbol,
      }),
    ],
    text: opts.text,
  });
}

function createSymbolInformation(opts: { symbol: string; documentation?: string[]; displayName?: string }) {
  return create(SymbolInformationSchema, {
    symbol: opts.symbol,
    documentation: opts.documentation ?? [],
    displayName: opts.displayName ?? '',
  });
}
