import Database from 'better-sqlite3';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../src/db.js';
import { findFirstSymbolMatch } from '../src/query-support.js';
import { byKind } from '../src/queries/by-kind.js';
import { callGraph } from '../src/queries/call-graph.js';
import { changeSurface } from '../src/queries/change-surface.js';
import { convergence } from '../src/queries/convergence.js';
import { complexity } from '../src/queries/complexity.js';
import { dataflow } from '../src/queries/dataflow.js';
import { fanIn } from '../src/queries/fan.js';
import { health } from '../src/queries/health.js';
import { importedBy, imports, unusedImports } from '../src/queries/imports.js';
import { members } from '../src/queries/members.js';
import { refs } from '../src/queries/refs.js';
import { similarAll } from '../src/queries/similar.js';
import { staleAbstractions } from '../src/queries/stale-abstractions.js';
import type { ScipQueryConfig } from '../src/types.js';

function createFixtureProject(projectRoot: string): void {
  mkdirSync(join(projectRoot, 'src', 'reindex'), { recursive: true });
  mkdirSync(join(projectRoot, 'tests'), { recursive: true });

  writeFileSync(
    join(projectRoot, 'src', 'reindex', 'index.ts'),
    "export function reindex() { return 'ok'; }\n",
  );
  writeFileSync(
    join(projectRoot, 'src', 'reindex', 'indexers.ts'),
    'export function getIndexerConfig() { return {}; }\n',
  );
  writeFileSync(
    join(projectRoot, 'src', 'watch.ts'),
    [
      'export class Watcher {',
      '  start() { return true; }',
      '  stop() { return false; }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(projectRoot, 'src', 'utils.ts'),
    [
      'export function tryInstallScipCli() { return true; }',
      'export function unusedHelper() { return false; }',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(projectRoot, 'src', 'consumer.ts'),
    [
      "import { tryInstallScipCli, unusedHelper as ignored } from './utils.js';",
      "import * as reindexApi from './reindex/index.js';",
      '',
      'tryInstallScipCli();',
      'reindexApi.reindex();',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(projectRoot, 'src', 'flow.ts'),
    [
      'export function sharedOne() { return 1; }',
      'export function sharedTwo() { return 2; }',
      'export function uniqueAlpha() { return 3; }',
      'export function uniqueBeta() { return 4; }',
      'export function alpha() { sharedOne(); sharedTwo(); uniqueAlpha(); }',
      'export function beta() { sharedOne(); sharedTwo(); uniqueBeta(); }',
      'export function gamma() { uniqueAlpha(); uniqueBeta(); }',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(projectRoot, 'src', 'contracts.ts'),
    [
      'export interface PathFilter {',
      '  isIgnored(path: string): boolean;',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(projectRoot, 'src', 'predicates.ts'),
    [
      'export function normalizePath(path: string) { return path.toLowerCase(); }',
      "export function isWorkerEntrySurface(path: string) { return normalizePath(path).endsWith('worker.ts'); }",
      "export function isBarrelFile(path: string) { return normalizePath(path).endsWith('index.ts'); }",
      'export interface TempOptions {',
      '  enabled: boolean;',
      '}',
      '',
      "export type WorkerStatus = 'idle' | 'running';",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(projectRoot, 'src', 'types.ts'),
    [
      'export interface InstallMethod {',
      '  label: string;',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(projectRoot, 'tests', 'utils.test.ts'),
    [
      "import { tryInstallScipCli } from '../src/utils.js';",
      "import { reindex } from '../src/reindex/index.js';",
      '',
      'tryInstallScipCli();',
      'reindex();',
      '',
    ].join('\n'),
  );
}

function createFixtureDb(dbPath: string): void {
  const sqliteDb = new Database(dbPath);
  const run = (sql: string) => sqliteDb.exec(sql);

  run(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      language TEXT,
      relative_path TEXT NOT NULL UNIQUE,
      position_encoding TEXT,
      text TEXT
    );
    CREATE TABLE global_symbols (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      display_name TEXT,
      kind INTEGER,
      documentation TEXT,
      signature BLOB,
      enclosing_symbol TEXT,
      relationships BLOB
    );
    CREATE TABLE defn_enclosing_ranges (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      start_char INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      end_char INTEGER NOT NULL
    );
    CREATE TABLE mentions (
      chunk_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      role INTEGER NOT NULL,
      PRIMARY KEY (chunk_id, symbol_id, role)
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      occurrences BLOB NOT NULL
    );
    CREATE INDEX idx_mentions_symbol_id_role ON mentions(symbol_id, role);
    CREATE INDEX idx_defn_enclosing_ranges_symbol_id ON defn_enclosing_ranges(symbol_id);
    CREATE INDEX idx_defn_enclosing_ranges_document ON defn_enclosing_ranges(document_id, start_line, end_line);
    CREATE INDEX idx_chunks_doc_id ON chunks(document_id);
    CREATE INDEX idx_global_symbols_symbol ON global_symbols(symbol);
  `);

  run(`
    INSERT INTO documents (id, language, relative_path) VALUES
      (1, 'typescript', 'src/reindex/index.ts'),
      (2, 'typescript', 'src/reindex/indexers.ts'),
      (3, 'typescript', 'src/watch.ts'),
      (4, 'typescript', 'src/utils.ts'),
      (5, 'typescript', 'src/consumer.ts'),
      (6, 'typescript', 'src/flow.ts'),
      (7, 'typescript', 'src/contracts.ts'),
      (8, 'typescript', 'src/predicates.ts'),
      (9, 'typescript', 'src/types.ts'),
      (10, 'typescript', 'tests/utils.test.ts');
  `);

  const insertSymbol = sqliteDb.prepare(
    `INSERT INTO global_symbols (id, symbol, display_name, kind, documentation)
     VALUES (?, ?, ?, ?, ?)`
  );

  insertSymbol.run(1, 'scip-typescript npm pkg 1.0.0 src/reindex/`index.ts`/', '', 1, 'module');
  insertSymbol.run(2, 'scip-typescript npm pkg 1.0.0 src/reindex/`index.ts`/reindex().', 'reindex', 3, 'function');
  insertSymbol.run(3, 'scip-typescript npm pkg 1.0.0 src/reindex/`indexers.ts`/', '', 1, 'module');
  insertSymbol.run(4, 'scip-typescript npm pkg 1.0.0 src/reindex/`indexers.ts`/getIndexerConfig().', 'getIndexerConfig', 3, 'function');
  insertSymbol.run(5, 'scip-typescript npm pkg 1.0.0 src/`watch.ts`/Watcher#', 'Watcher', null, 'class Watcher');
  insertSymbol.run(6, 'scip-typescript npm pkg 1.0.0 src/`watch.ts`/Watcher#start().', 'start', 3, 'method');
  insertSymbol.run(7, 'scip-typescript npm pkg 1.0.0 src/`watch.ts`/Watcher#stop().', 'stop', 3, 'method');
  insertSymbol.run(8, 'scip-typescript npm pkg 1.0.0 src/`utils.ts`/tryInstallScipCli().', 'tryInstallScipCli', 3, 'function');
  insertSymbol.run(9, 'scip-typescript npm pkg 1.0.0 src/`utils.ts`/unusedHelper().', 'unusedHelper', 3, 'function');
  insertSymbol.run(10, 'scip-typescript npm pkg 1.0.0 src/`flow.ts`/', '', 1, 'module');
  insertSymbol.run(11, 'scip-typescript npm pkg 1.0.0 src/`flow.ts`/alpha().', 'alpha', 3, 'function');
  insertSymbol.run(12, 'scip-typescript npm pkg 1.0.0 src/`flow.ts`/beta().', 'beta', 3, 'function');
  insertSymbol.run(13, 'scip-typescript npm pkg 1.0.0 src/`flow.ts`/sharedOne().', 'sharedOne', 3, 'function');
  insertSymbol.run(14, 'scip-typescript npm pkg 1.0.0 src/`flow.ts`/sharedTwo().', 'sharedTwo', 3, 'function');
  insertSymbol.run(15, 'scip-typescript npm pkg 1.0.0 src/`flow.ts`/uniqueAlpha().', 'uniqueAlpha', 3, 'function');
  insertSymbol.run(16, 'scip-typescript npm pkg 1.0.0 src/`flow.ts`/uniqueBeta().', 'uniqueBeta', 3, 'function');
  insertSymbol.run(17, 'scip-typescript npm pkg 1.0.0 src/`flow.ts`/gamma().', 'gamma', 3, 'function');
  insertSymbol.run(18, 'scip-typescript npm pkg 1.0.0 src/`contracts.ts`/PathFilter#', 'PathFilter', null, 'interface PathFilter');
  insertSymbol.run(19, 'scip-typescript npm pkg 1.0.0 src/`predicates.ts`/normalizePath().', 'normalizePath', 3, 'function');
  insertSymbol.run(20, 'scip-typescript npm pkg 1.0.0 src/`predicates.ts`/isWorkerEntrySurface().', 'isWorkerEntrySurface', 3, 'function');
  insertSymbol.run(21, 'scip-typescript npm pkg 1.0.0 src/`predicates.ts`/isBarrelFile().', 'isBarrelFile', 3, 'function');
  insertSymbol.run(22, 'scip-typescript npm pkg 1.0.0 src/`types.ts`/InstallMethod#', 'InstallMethod', null, 'interface InstallMethod');
  insertSymbol.run(23, 'scip-typescript npm pkg 1.0.0 src/`predicates.ts`/TempOptions#', 'TempOptions', null, 'interface TempOptions');
  insertSymbol.run(24, 'scip-typescript npm pkg 1.0.0 src/`predicates.ts`/WorkerStatus#', 'WorkerStatus', null, 'type WorkerStatus');

  run(`
    INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
      (1, 1, 1, 0, 0, 4, 0),
      (2, 1, 2, 1, 0, 2, 0),
      (3, 2, 3, 0, 0, 4, 0),
      (4, 2, 4, 1, 0, 2, 0),
      (5, 3, 5, 0, 0, 4, 0),
      (6, 3, 6, 1, 0, 1, 0),
      (7, 3, 7, 2, 0, 2, 0),
      (8, 4, 8, 0, 0, 1, 0),
      (9, 4, 9, 1, 0, 2, 0),
      (10, 6, 10, 0, 0, 7, 0),
      (11, 6, 11, 4, 0, 4, 0),
      (12, 6, 12, 5, 0, 5, 0),
      (13, 6, 13, 0, 0, 0, 0),
      (14, 6, 14, 1, 0, 1, 0),
      (15, 6, 15, 2, 0, 2, 0),
      (16, 6, 16, 3, 0, 3, 0),
      (17, 6, 17, 6, 0, 6, 0),
      (18, 7, 18, 0, 0, 2, 0),
      (19, 8, 19, 0, 0, 0, 0),
      (20, 8, 20, 1, 0, 1, 0),
      (21, 8, 21, 2, 0, 2, 0),
      (22, 9, 22, 0, 0, 2, 0),
      (23, 8, 23, 3, 0, 4, 0),
      (24, 8, 24, 6, 0, 6, 0);
  `);

  run(`
    INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
      (1, 1, 0, 0, 4, X'00'),
      (2, 1, 1, 1, 2, X'00'),
      (3, 2, 0, 0, 4, X'00'),
      (4, 2, 1, 1, 2, X'00'),
      (5, 3, 0, 0, 4, X'00'),
      (6, 3, 1, 1, 1, X'00'),
      (7, 3, 2, 2, 2, X'00'),
      (8, 4, 0, 0, 2, X'00'),
      (9, 4, 1, 1, 2, X'00'),
      (10, 6, 0, 0, 7, X'00'),
      (11, 6, 1, 4, 4, X'00'),
      (12, 6, 2, 5, 5, X'00'),
      (13, 6, 3, 6, 6, X'00'),
      (14, 5, 0, 0, 4, X'00'),
      (15, 7, 0, 0, 2, X'00'),
      (16, 8, 0, 0, 0, X'00'),
      (17, 8, 1, 1, 1, X'00'),
      (18, 8, 2, 2, 2, X'00'),
      (19, 9, 0, 0, 2, X'00'),
      (20, 8, 3, 3, 4, X'00'),
      (21, 10, 0, 0, 4, X'00'),
      (22, 8, 4, 6, 6, X'00');
  `);

  run(`
    INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
      (1, 1, 1),
      (2, 2, 1),
      (3, 3, 1),
      (4, 4, 1),
      (5, 5, 1),
      (6, 6, 1),
      (7, 7, 1),
      (8, 8, 1),
      (9, 9, 1),
      (10, 10, 1),
      (11, 11, 1),
      (12, 12, 1),
      (14, 8, 0),
      (10, 13, 0),
      (10, 14, 0),
      (10, 15, 0),
      (10, 16, 0),
      (11, 13, 0),
      (11, 14, 0),
      (11, 15, 0),
      (12, 13, 0),
      (12, 14, 0),
      (12, 16, 0),
      (13, 15, 0),
      (13, 16, 0),
      (5, 18, 0),
      (15, 18, 1),
      (16, 19, 1),
      (17, 20, 1),
      (17, 19, 0),
      (18, 21, 1),
      (18, 19, 0),
      (19, 22, 1),
      (20, 23, 1),
      (22, 24, 1),
      (21, 8, 0),
      (21, 2, 0);
  `);

  sqliteDb.close();
}

function createTypeScriptCallFixtureProject(projectRoot: string): void {
  mkdirSync(join(projectRoot, 'src'), { recursive: true });

  writeFileSync(
    join(projectRoot, 'src', 'db.ts'),
    [
      'export class Store {',
      '  all() { return []; }',
      '}',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(projectRoot, 'src', 'query.ts'),
    [
      "import { Store } from './db.js';",
      '',
      'export function collect(store: Store) {',
      '  return store.all();',
      '}',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(projectRoot, 'src', 'consumer.ts'),
    [
      "import { collect } from './query.js';",
      "import { Store } from './db.js';",
      '',
      'const store = new Store();',
      'collect(store);',
      '',
    ].join('\n'),
  );
}

function createTypeScriptCallFixtureDb(dbPath: string): void {
  const sqliteDb = new Database(dbPath);
  const run = (sql: string) => sqliteDb.exec(sql);

  run(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      language TEXT,
      relative_path TEXT NOT NULL UNIQUE,
      position_encoding TEXT,
      text TEXT
    );
    CREATE TABLE global_symbols (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      display_name TEXT,
      kind INTEGER,
      documentation TEXT,
      signature BLOB,
      enclosing_symbol TEXT,
      relationships BLOB
    );
    CREATE TABLE defn_enclosing_ranges (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      start_char INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      end_char INTEGER NOT NULL
    );
    CREATE TABLE mentions (
      chunk_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      role INTEGER NOT NULL,
      PRIMARY KEY (chunk_id, symbol_id, role)
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      occurrences BLOB NOT NULL
    );
    CREATE INDEX idx_mentions_symbol_id_role ON mentions(symbol_id, role);
    CREATE INDEX idx_defn_enclosing_ranges_symbol_id ON defn_enclosing_ranges(symbol_id);
    CREATE INDEX idx_defn_enclosing_ranges_document ON defn_enclosing_ranges(document_id, start_line, end_line);
    CREATE INDEX idx_chunks_doc_id ON chunks(document_id);
    CREATE INDEX idx_global_symbols_symbol ON global_symbols(symbol);
  `);

  run(`
    INSERT INTO documents (id, language, relative_path) VALUES
      (1, 'typescript', 'src/db.ts'),
      (2, 'typescript', 'src/query.ts'),
      (3, 'typescript', 'src/consumer.ts');
  `);

  const insertSymbol = sqliteDb.prepare(
    `INSERT INTO global_symbols (id, symbol, display_name, kind, documentation)
     VALUES (?, ?, ?, ?, ?)`
  );

  insertSymbol.run(1, 'scip-typescript npm pkg 1.0.0 src/`db.ts`/Store#', 'Store', 9, 'class Store');
  insertSymbol.run(2, 'scip-typescript npm pkg 1.0.0 src/`db.ts`/Store#all().', 'all', 23, 'all(): unknown[]');
  insertSymbol.run(3, 'scip-typescript npm pkg 1.0.0 src/`query.ts`/collect().', 'collect', 23, 'collect(store: Store)');

  run(`
    INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
      (1, 1, 1, 0, 0, 2, 0),
      (2, 1, 2, 1, 0, 1, 0),
      (3, 2, 3, 2, 0, 4, 0);
  `);

  run(`
    INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
      (1, 1, 0, 0, 2, X'00'),
      (2, 2, 0, 0, 4, X'00'),
      (3, 3, 0, 0, 4, X'00');
  `);

  run(`
    INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
      (1, 1, 1),
      (1, 2, 1),
      (2, 3, 1),
      (3, 3, 0);
  `);

  sqliteDb.close();
}

describe('command accuracy fixes', () => {
  let db: ScipDatabase;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-command-'));
    createFixtureProject(tempDir);
    const dbPath = join(tempDir, 'index.db');
    createFixtureDb(dbPath);

    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    };
    db = new ScipDatabase(config);
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('prefers the callable symbol over module matches for ambiguous names', () => {
    const match = findFirstSymbolMatch(db, 'reindex');

    expect(match).not.toBeNull();
    expect(match!.relativePath).toBe('src/reindex/index.ts');
    expect(match!.startLine).toBe(1);
  });

  it('accepts short-name lookups and returns direct members without enclosing_symbol metadata', () => {
    const match = findFirstSymbolMatch(db, 'src:flow:alpha()');
    const results = members(db, 'Watcher');

    expect(match).not.toBeNull();
    expect(match!.relativePath).toBe('src/flow.ts');
    expect(results.map((result) => result.shortName)).toEqual([
      'src:watch:Watcher:start()',
      'src:watch:Watcher:stop()',
    ]);
  });

  it('falls back to source imports for TypeScript files when role=2 data is absent', () => {
    const importResults = imports(db, 'consumer.ts').map((result) => result.shortName);
    const unusedResults = unusedImports(db, 'consumer.ts').map((result) => result.shortName);
    const importers = importedBy(db, 'tryInstallScipCli').map((result) => result.fromFile);

    expect(importResults).toEqual([
      'tryInstallScipCli',
      'unusedHelper as ignored',
      '* as reindexApi',
    ]);
    expect(unusedResults).toEqual(['unusedHelper as ignored']);
    expect(importers).toEqual(['src/consumer.ts', 'tests/utils.test.ts']);
  });

  it('distinguishes TypeScript interfaces from classes when inferring kinds', () => {
    const classes = byKind(db, 'class').map((result) => result.shortName);
    const interfaces = byKind(db, 'interface').map((result) => result.shortName);
    const typeAliases = byKind(db, 'typealias').map((result) => result.shortName);

    expect(classes).toContain('src:watch:Watcher');
    expect(classes).not.toContain('src:contracts:PathFilter');
    expect(classes).not.toContain('src:predicates:WorkerStatus');
    expect(interfaces).toEqual(expect.arrayContaining([
      'src:contracts:PathFilter',
      'src:predicates:TempOptions',
      'src:types:InstallMethod',
    ]));
    expect(typeAliases).toContain('src:predicates:WorkerStatus');
  });

  it('resolves fan-in against the matched symbol instead of fuzzy nested matches', () => {
    expect(fanIn(db, 'tryInstallScipCli')).toEqual([
      { name: 'src:utils:tryInstallScipCli()', count: 2 },
    ]);
  });

  it('keeps change-surface focused on external consumers and blast-radius risk', () => {
    const result = changeSurface(db, 'utils.ts');

    expect(result).not.toBeNull();
    expect(result!.file).toBe('src/utils.ts');
    expect(result!.totalExternalConsumers).toBe(2);
    expect(result!.symbols.map((entry) => ({
      shortName: entry.shortName,
      consumers: entry.externalConsumers,
      risk: entry.riskLevel,
    }))).toEqual([
      { shortName: 'src:utils:tryInstallScipCli()', consumers: 2, risk: 'medium' },
      { shortName: 'src:utils:unusedHelper()', consumers: 0, risk: 'low' },
    ]);
  });

  it('keeps similar/convergence focused on functions and accepts short names from similar output', () => {
    const similarResults = similarAll(db, {
      minSimilarity: 0.3,
      minCallees: 2,
      limit: 10,
    });
    const convergenceResult = convergence(db, 'src:flow:alpha()', 'src:flow:beta()');

    expect(similarResults.some((result) => result.shortNameA === 'src:flow' || result.shortNameB === 'src:flow')).toBe(false);
    expect(convergenceResult).not.toBeNull();
    expect(convergenceResult!.sharedCallees).toEqual(
      expect.arrayContaining(['src:flow:sharedOne()', 'src:flow:sharedTwo()']),
    );
  });

  it('does not overstate consolidation when both symbols have no tracked callees', () => {
    const convergenceResult = convergence(db, 'reindex', 'getIndexerConfig');

    expect(convergenceResult).not.toBeNull();
    expect(convergenceResult!.similarity).toBe(0);
    expect(convergenceResult!.consolidationStrategy).toContain('no callee-pattern evidence');
    expect(convergenceResult!.consolidationStrategy).not.toContain('replace the other directly');
  });

  it('keeps convergence conservative when identical callees do not prove equivalence', () => {
    const convergenceResult = convergence(db, 'isWorkerEntrySurface', 'isBarrelFile');

    expect(convergenceResult).not.toBeNull();
    expect(convergenceResult!.similarity).toBe(1);
    expect(convergenceResult!.sharedCallees).toEqual(['src:predicates:normalizePath()']);
    expect(convergenceResult!.consolidationStrategy).toContain('do not prove interchangeable semantics');
    expect(convergenceResult!.consolidationStrategy).not.toContain('replace the other directly');
  });

  it('keeps stale-abstractions aligned with health filtering', () => {
    const stale = staleAbstractions(db, { minLoc: 1, limit: 20 });
    const report = health(db);
    const staleAction = report.actions.find((action) => action.category === 'Stale abstractions');

    expect(stale.map((result) => result.shortName)).toEqual(expect.arrayContaining([
      'src:contracts:PathFilter',
      'src:types:InstallMethod',
    ]));
    expect(stale).toHaveLength(2);
    expect(report.findings.staleTypes).toBe(stale.length);
    expect(staleAction?.count).toBe(stale.length);
    expect(staleAction?.description).toContain('1 unused, 1 single-consumer');
  });

  it('recovers TypeScript method calls and exact reference lines from source fallbacks', () => {
    const callTempDir = mkdtempSync(join(tmpdir(), 'scip-query-ts-calls-'));
    try {
      createTypeScriptCallFixtureProject(callTempDir);
      const dbPath = join(callTempDir, 'index.db');
      createTypeScriptCallFixtureDb(dbPath);

      const callDb = new ScipDatabase({
        dbPath,
        indexPath: join(callTempDir, 'index.scip'),
        projectRoot: callTempDir,
      });

      try {
        const graph = callGraph(callDb, 'collect');
        expect(graph?.callees.map((callee) => callee.shortName)).toEqual([
          'src:db:Store:all()',
        ]);

        const result = complexity(callDb, 'collect');
        expect(result?.calleeCount).toBe(1);

        expect(refs(callDb, 'collect')).toEqual([
          { relativePath: 'src/consumer.ts', line: 0 },
          { relativePath: 'src/consumer.ts', line: 4 },
        ]);

        const flow = dataflow(callDb, 'collect');
        expect(flow?.definitionSites).toEqual([
          { file: 'src/query.ts', line: 2 },
        ]);
      } finally {
        callDb.close();
      }
    } finally {
      rmSync(callTempDir, { recursive: true, force: true });
    }
  });
});
