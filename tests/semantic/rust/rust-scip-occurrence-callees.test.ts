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
  canUseRustScipOccurrenceCallees,
  rustScipOccurrenceCalleeMap,
} from '../../../src/semantic/rust/scip-occurrence-callees.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const CALLER_SYMBOL = 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/caller().';
const HELPER_SYMBOL = 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/helper().';
const MAIN_SYMBOL = 'rust-analyzer cargo fixture 0.1.0 src/main.rs/main().';
const TYPE_SYMBOL = 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/Runner#';
const DEFAULT_SYMBOL = 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/impl#[Runner][Default]default().';
const TICK_SYMBOL = 'rust-analyzer cargo fixture 0.1.0 src/lib.rs/impl#[Runner][Tick]tick().';

function rustDefinition(
  symbolId: number,
  symbol: string,
  overrides: Partial<IndexedDefinition> = {},
): IndexedDefinition {
  const leaf = symbol.endsWith('/caller().')
    ? 'caller'
    : symbol.endsWith('/helper().')
      ? 'helper'
      : symbol.endsWith('/main().')
        ? 'main'
        : symbol.endsWith('default().')
          ? 'default'
          : symbol.endsWith('tick().')
            ? 'tick'
            : symbol;
  return {
    symbolId,
    symbol,
    documentId: 1,
    startLine: 0,
    startChar: 0,
    endLine: 0,
    endChar: 1,
    relativePath: 'src/lib.rs',
    leaf,
    parentTypeName: null,
    isFunctionLike: symbol.endsWith('().'),
    isTypeLike: symbol.endsWith('#'),
    kind: null,
    documentation: null,
    enclosingSymbol: null,
    ...overrides,
  };
}

function withCalleeFixture(run: (db: ScipDatabase) => void): void {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-scip-callees-'));
  const dbPath = join(projectRoot, 'index.db');
  const indexPath = join(projectRoot, 'index.scip');
  writeFixtureFiles(projectRoot, {
    'src/lib.rs': ['pub fn helper() {}', '', 'pub fn caller() {', '    helper();', '}'],
  });
  evidenceFixtureDb(dbPath)
    .document(1, 'rust', 'src/lib.rs')
    .symbol(1, HELPER_SYMBOL, 'helper')
    .symbol(2, CALLER_SYMBOL, 'caller')
    .definition(1, 1, 1, 0, 7, 0, 13)
    .definition(2, 1, 2, 2, 7, 4, 1)
    .write();
  writeFileSync(indexPath, serializeSCIP(calleeFixtureIndex()));

  const db = new ScipDatabase({ dbPath, indexPath, projectRoot });
  try {
    run(db);
  } finally {
    db.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function withTraitImplCalleeFixture(run: (db: ScipDatabase) => void): void {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-scip-trait-callees-'));
  const dbPath = join(projectRoot, 'index.db');
  const indexPath = join(projectRoot, 'index.scip');
  writeFixtureFiles(projectRoot, {
    'src/lib.rs': ['struct Runner;', '', 'pub fn caller() {', '    Runner::default();', '}'],
  });
  evidenceFixtureDb(dbPath)
    .document(1, 'rust', 'src/lib.rs')
    .symbol(1, DEFAULT_SYMBOL, 'default')
    .symbol(2, CALLER_SYMBOL, 'caller')
    .definition(1, 1, 1, 0, 0, 0, 13)
    .definition(2, 1, 2, 2, 7, 4, 1)
    .write();
  writeFileSync(indexPath, serializeSCIP(traitImplCalleeFixtureIndex()));

  const db = new ScipDatabase({ dbPath, indexPath, projectRoot });
  try {
    run(db);
  } finally {
    db.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function calleeFixtureIndex() {
  return create(IndexSchema, {
    documents: [
      create(DocumentSchema, {
        language: 'rust',
        relativePath: 'src/lib.rs',
        symbols: [HELPER_SYMBOL, CALLER_SYMBOL].map((symbol) => create(SymbolInformationSchema, { symbol })),
        occurrences: [
          create(OccurrenceSchema, {
            symbol: HELPER_SYMBOL,
            symbolRoles: SymbolRole.Definition,
            range: [0, 7, 0, 13],
          }),
          create(OccurrenceSchema, {
            symbol: CALLER_SYMBOL,
            symbolRoles: SymbolRole.Definition,
            range: [2, 7, 2, 13],
          }),
          create(OccurrenceSchema, {
            symbol: HELPER_SYMBOL,
            symbolRoles: 0,
            range: [3, 4, 3, 10],
          }),
        ],
      }),
    ],
  });
}

function traitImplCalleeFixtureIndex() {
  return create(IndexSchema, {
    documents: [
      create(DocumentSchema, {
        language: 'rust',
        relativePath: 'src/lib.rs',
        symbols: [DEFAULT_SYMBOL, CALLER_SYMBOL].map((symbol) => create(SymbolInformationSchema, { symbol })),
        occurrences: [
          create(OccurrenceSchema, {
            symbol: CALLER_SYMBOL,
            symbolRoles: SymbolRole.Definition,
            range: [2, 7, 2, 13],
          }),
          create(OccurrenceSchema, {
            symbol: DEFAULT_SYMBOL,
            symbolRoles: 0,
            range: [3, 12, 3, 19],
          }),
        ],
      }),
    ],
  });
}

describe('Rust SCIP occurrence callees', () => {
  it('returns exact callees when source call leaves match compiler occurrences', () => {
    withCalleeFixture((db) => {
      const caller = rustDefinition(2, CALLER_SYMBOL, { startLine: 2, startChar: 7, endLine: 4, endChar: 1 });

      expect(rustScipOccurrenceCalleeMap(db, [caller])).toEqual(
        new Map([[2, [{ symbol: HELPER_SYMBOL, file: 'src/lib.rs', line: 0, callsiteLine: 3 }]]]),
      );
    });
  });

  it('falls back for Rust caller or callee shapes that are too broad', () => {
    withTraitImplCalleeFixture((db) => {
      const caller = rustDefinition(2, CALLER_SYMBOL, { startLine: 2, startChar: 7, endLine: 4, endChar: 1 });

      expect(rustScipOccurrenceCalleeMap(db, [caller])).toEqual(new Map());
    });
    expect(canUseRustScipOccurrenceCallees(rustDefinition(3, MAIN_SYMBOL, { relativePath: 'src/main.rs' }))).toBe(
      false,
    );
    expect(canUseRustScipOccurrenceCallees(rustDefinition(4, TYPE_SYMBOL))).toBe(false);
    expect(canUseRustScipOccurrenceCallees(rustDefinition(5, DEFAULT_SYMBOL))).toBe(false);
    expect(canUseRustScipOccurrenceCallees(rustDefinition(6, TICK_SYMBOL))).toBe(false);
  });
});
