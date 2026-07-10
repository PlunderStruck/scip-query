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
import type { IndexedDefinition } from '../../../src/domain/types.js';
import {
  canUseRustScipOccurrenceReferences,
  rustScipOccurrenceReferenceMap,
  rustScipOccurrenceReferencesForDefinition,
} from '../../../src/semantic/rust/scip-occurrence-references.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const FUNCTION_SYMBOL = 'rust-analyzer cargo fixture 0.1.0 lib/run().';
const VALUE_SYMBOL = 'rust-analyzer cargo fixture 0.1.0 lib/MAX_STEPS.';
const FIELD_SYMBOL = 'rust-analyzer cargo fixture 0.1.0 lib/Runner#steps.';
const TYPE_SYMBOL = 'rust-analyzer cargo fixture 0.1.0 lib/Runner#';
const MODULE_SYMBOL = 'rust-analyzer cargo fixture 0.1.0 lib/';
const DEFAULT_SYMBOL = 'rust-analyzer cargo fixture 0.1.0 lib/impl#[Runner][Default]default().';
const TRAIT_IMPL_SYMBOL = 'rust-analyzer cargo fixture 0.1.0 lib/impl#[Runner][Tick]tick().';

function rustDefinition(
  symbolId: number,
  symbol: string,
  overrides: Partial<IndexedDefinition> = {},
): IndexedDefinition {
  return {
    symbolId,
    symbol,
    documentId: 1,
    startLine: 0,
    startChar: 0,
    endLine: 0,
    endChar: 1,
    relativePath: 'src/lib.rs',
    leaf: symbol,
    parentTypeName: null,
    isFunctionLike: symbol.endsWith('().'),
    isTypeLike: symbol.endsWith('#'),
    kind: null,
    documentation: null,
    enclosingSymbol: null,
    ...overrides,
  };
}

function withOccurrenceFixture(run: (db: ScipDatabase) => void): void {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-scip-occurrences-'));
  const dbPath = join(projectRoot, 'index.db');
  const indexPath = join(projectRoot, 'index.scip');
  writeFixtureFiles(projectRoot, {
    'src/lib.rs': ['pub fn run() {}', 'const MAX_STEPS: u32 = 3;', 'fn consumer() { run(); }'],
  });
  evidenceFixtureDb(dbPath)
    .document(1, 'rust', 'src/lib.rs')
    .symbol(1, FUNCTION_SYMBOL, 'run')
    .symbol(2, VALUE_SYMBOL, 'MAX_STEPS')
    .symbol(3, FIELD_SYMBOL, 'steps')
    .write();
  writeFileSync(indexPath, serializeSCIP(fixtureIndex()));

  const db = new ScipDatabase({ dbPath, indexPath, projectRoot });
  try {
    run(db);
  } finally {
    db.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function fixtureIndex() {
  return create(IndexSchema, {
    documents: [
      create(DocumentSchema, {
        language: 'rust',
        relativePath: 'src/lib.rs',
        symbols: [FUNCTION_SYMBOL, VALUE_SYMBOL, FIELD_SYMBOL].map((symbol) =>
          create(SymbolInformationSchema, { symbol }),
        ),
        occurrences: [
          create(OccurrenceSchema, {
            symbol: FUNCTION_SYMBOL,
            symbolRoles: SymbolRole.Definition,
            range: [0, 7, 0, 10],
          }),
          create(OccurrenceSchema, {
            symbol: FUNCTION_SYMBOL,
            symbolRoles: 0,
            range: [2, 16, 2, 19],
          }),
          create(OccurrenceSchema, {
            symbol: FUNCTION_SYMBOL,
            symbolRoles: 0,
            range: [2, 16, 2, 19],
          }),
          create(OccurrenceSchema, {
            symbol: VALUE_SYMBOL,
            symbolRoles: 0,
            range: [4, 11, 4, 20],
          }),
          create(OccurrenceSchema, {
            symbol: FIELD_SYMBOL,
            symbolRoles: 0,
            range: [5, 8, 5, 13],
          }),
        ],
      }),
    ],
  });
}

describe('Rust SCIP occurrence references', () => {
  it('returns exact non-definition occurrence positions for safe Rust symbol shapes', () => {
    withOccurrenceFixture((db) => {
      const runDefinition = rustDefinition(1, FUNCTION_SYMBOL);
      const valueDefinition = rustDefinition(2, VALUE_SYMBOL, { isFunctionLike: false });

      expect(rustScipOccurrenceReferencesForDefinition(db, runDefinition)).toEqual([
        { file: 'src/lib.rs', line: 2, column: 16 },
      ]);
      expect(rustScipOccurrenceReferenceMap(db, [runDefinition, valueDefinition])).toEqual(
        new Map([
          [1, [{ file: 'src/lib.rs', line: 2, column: 16 }]],
          [2, [{ file: 'src/lib.rs', line: 4, column: 11 }]],
        ]),
      );
    });
  });

  it('falls back for Rust symbol shapes where SCIP occurrences are too broad', () => {
    withOccurrenceFixture((db) => {
      expect(rustScipOccurrenceReferencesForDefinition(db, rustDefinition(3, FIELD_SYMBOL))).toBeNull();
    });
    expect(canUseRustScipOccurrenceReferences(rustDefinition(4, TYPE_SYMBOL))).toBe(false);
    expect(canUseRustScipOccurrenceReferences(rustDefinition(5, MODULE_SYMBOL))).toBe(false);
    expect(canUseRustScipOccurrenceReferences(rustDefinition(6, DEFAULT_SYMBOL))).toBe(false);
    expect(canUseRustScipOccurrenceReferences(rustDefinition(7, TRAIT_IMPL_SYMBOL))).toBe(false);

    expect(canUseRustScipOccurrenceReferences(rustDefinition(3, FIELD_SYMBOL), 'all')).toBe(true);
    expect(canUseRustScipOccurrenceReferences(rustDefinition(4, TYPE_SYMBOL), 'all')).toBe(true);
    expect(canUseRustScipOccurrenceReferences(rustDefinition(5, MODULE_SYMBOL), 'all')).toBe(true);
    expect(canUseRustScipOccurrenceReferences(rustDefinition(6, DEFAULT_SYMBOL), 'all')).toBe(false);
    expect(canUseRustScipOccurrenceReferences(rustDefinition(7, TRAIT_IMPL_SYMBOL), 'all')).toBe(false);
  });
});
