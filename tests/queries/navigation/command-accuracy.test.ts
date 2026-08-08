import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { findFirstSymbolMatch } from '../../../src/symbols/symbol-lookup.js';
import { affected, possibleImpactClosure } from '../../../src/queries/graph/affected.js';
import { bottlenecks } from '../../../src/queries/graph/bottlenecks.js';
import { byKind } from '../../../src/queries/navigation/by-kind.js';
import { callGraph } from '../../../src/queries/navigation/call-graph.js';
import { changeSurface } from '../../../src/queries/impact/change-surface.js';
import { code } from '../../../src/queries/navigation/code.js';
import { convergence } from '../../../src/queries/cleanup/convergence.js';
import { complexity } from '../../../src/queries/quality/complexity.js';
import { dataflow } from '../../../src/queries/navigation/dataflow.js';
import { dead } from '../../../src/queries/cleanup/dead.js';
import { fanIn } from '../../../src/queries/graph/fan.js';
import { health } from '../../../src/queries/health/health.js';
import { importedBy, imports, unusedImports } from '../../../src/queries/navigation/imports.js';
import { members } from '../../../src/queries/navigation/members.js';
import { outline } from '../../../src/queries/navigation/outline.js';
import { refs } from '../../../src/queries/navigation/refs.js';
import {
  similar,
  similarAll,
  similarAllCount,
  similarConsolidationPlan,
} from '../../../src/queries/cleanup/similar.js';
import { staleAbstractions } from '../../../src/queries/cleanup/stale-abstractions.js';
import { symbols } from '../../../src/queries/navigation/symbols.js';
import { system } from '../../../src/queries/navigation/system.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import {
  createFixtureDb,
  createFixtureProject,
  createTypeScriptCallFixtureDb,
  createTypeScriptCallFixtureProject,
} from '../../fixtures/command-accuracy-fixtures.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

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
    expect(match!.startLine).toBe(0);
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

    expect(importResults).toEqual(['tryInstallScipCli', 'unusedHelper as ignored', 'settings', '* as reindexApi']);
    expect(unusedResults).toEqual(['unusedHelper as ignored']);
    expect(importers).toEqual(['src/consumer.ts', 'tests/utils.test.ts']);
  });

  it('uses local binding evidence when SCIP import roles omit the later binding reference', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-unused-import-binding-'));
    try {
      writeFixtureFiles(root, {
        'src/lib.ts': ['export function createThing() {', '  return true;', '}', ''],
        'src/consumer.ts': [
          "import { createThing } from '@/lib';",
          'const registry = { createThing };',
          'export { registry };',
          '',
        ],
      });
      const dbPath = join(root, 'index.db');
      evidenceFixtureDb(dbPath)
        .document(1, 'typescript', 'src/lib.ts')
        .document(2, 'typescript', 'src/consumer.ts')
        .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`lib.ts`/createThing().', 'createThing', 12)
        .definition(1, 1, 1, 0, 0, 2, 1)
        .chunk(1, 1, 0, 2)
        .chunk(2, 2, 0, 2)
        .mention(1, 1, 1)
        .mention(2, 1, 2)
        .write();
      const fixtureDb = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
      try {
        expect(unusedImports(fixtureDb, 'src/consumer.ts')).toEqual([]);
      } finally {
        fixtureDb.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('withholds Rust imports that may provide implicit trait methods', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-rust-unused-import-'));
    try {
      writeFixtureFiles(root, {
        'src/lib.rs': [
          'use rand::{Rng, unused_fn};',
          '',
          'fn sample(rng: &mut rand::rngs::StdRng) -> u32 {',
          '    rng.random_range(0..10)',
          '}',
          '',
        ],
      });
      const dbPath = join(root, 'index.db');
      evidenceFixtureDb(dbPath).document(1, 'rust', 'src/lib.rs').chunk(1, 1, 0, 5).write();
      const fixtureDb = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
      try {
        expect(unusedImports(fixtureDb, 'src/lib.rs', { semantic: false }).map((row) => row.shortName)).toEqual([
          'unused_fn',
        ]);
      } finally {
        fixtureDb.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('distinguishes TypeScript interfaces from classes when inferring kinds', () => {
    const classes = byKind(db, 'class').map((result) => result.shortName);
    const interfaces = byKind(db, 'interface').map((result) => result.shortName);
    const typeAliases = byKind(db, 'typealias').map((result) => result.shortName);

    expect(classes).toContain('src:watch:Watcher');
    expect(classes).not.toContain('src:contracts:PathFilter');
    expect(classes).not.toContain('src:predicates:WorkerStatus');
    expect(interfaces).toEqual(
      expect.arrayContaining(['src:contracts:PathFilter', 'src:predicates:TempOptions', 'src:types:InstallMethod']),
    );
    expect(typeAliases).toContain('src:predicates:WorkerStatus');
  });

  it('resolves fan-in against the matched symbol instead of fuzzy nested matches', () => {
    expect(fanIn(db, 'tryInstallScipCli')).toEqual([
      {
        name: 'src:utils:tryInstallScipCli()',
        count: 2,
        symbol: 'scip-typescript npm pkg 1.0.0 src/`utils.ts`/tryInstallScipCli().',
        definedIn: 'src/utils.ts',
      },
    ]);
  });

  it('keeps source-attributed cross-file callers out of dead-code results', () => {
    const results = dead(db, { minLoc: 1 });
    const names = results.symbols.map((result) => result.shortName);

    expect(names).not.toContain('src:utils:tryInstallScipCli()');
    expect(names).toContain('src:utils:unusedHelper()');
  });

  it('keeps fenced union signatures intact and infers missing document language', () => {
    const utilSymbols = symbols(db, 'utils.ts');
    const helper = utilSymbols.find((result) => result.shortName === 'src:utils:unusedHelper()');
    const snippet = code(db, 'unusedHelper');

    expect(helper?.signature).toBe('function unusedHelper(): Promise<boolean | null>');
    expect(snippet?.language).toBe('typescript');
  });

  it('keeps change-surface focused on external consumers and blast-radius risk', () => {
    const result = changeSurface(db, 'utils.ts');

    expect(result).not.toBeNull();
    expect(result!.file).toBe('src/utils.ts');
    expect(result!.totalExternalConsumers).toBe(2);
    expect(
      result!.symbols.map((entry) => ({
        shortName: entry.shortName,
        consumers: entry.externalConsumers,
        risk: entry.riskLevel,
      })),
    ).toEqual([
      { shortName: 'src:utils:tryInstallScipCli()', consumers: 2, risk: 'medium' },
      { shortName: 'src:utils:unusedHelper()', consumers: 0, risk: 'low' },
    ]);
  });

  it('keeps similar/convergence focused on functions and accepts short names from similar output', () => {
    const similarOptions = {
      minSimilarity: 0.3,
      minCallees: 2,
      limit: Number.POSITIVE_INFINITY,
    };
    const similarResults = similarAll(db, similarOptions);
    const similarCount = similarAllCount(db, similarOptions);
    const plan = similarConsolidationPlan(db, 'src:flow:alpha()', 'src:flow:beta()');
    const convergenceResult = convergence(db, 'src:flow:alpha()', 'src:flow:beta()');

    expect(similarCount).toBe(similarResults.length);
    expect(similarResults.some((result) => result.shortNameA === 'src:flow' || result.shortNameB === 'src:flow')).toBe(
      false,
    );
    expect(convergenceResult).not.toBeNull();
    expect(plan).not.toBeNull();
    expect(convergenceResult!.similarity).toBe(plan!.similarity);
    expect(convergenceResult!.sharedCallees).toEqual(plan!.sharedEvidence);
    expect(plan!.similarityBasis).toMatch(/^(callees|source-tokens)$/);
  });

  it('labels source-token similarity separately from callee similarity', () => {
    const results = similar(db, 'isWorkerEntrySurface', { minSimilarity: 0.1, limit: 5 });
    const match = results.find((result) => result.shortNameB === 'src:predicates:isBarrelFile()');

    expect(match).toBeDefined();
    expect(match!.similarityBasis).toBe('source-tokens');
    expect(match!.sharedCallees).toContain('path');
  });

  it('keeps affected propagation on executable/type consumers instead of module surfaces', () => {
    const results = affected(db, 'sharedOne', { maxDepth: 1 });
    const names = results.map((result) => result.shortName);

    expect(names).toEqual(expect.arrayContaining(['src:flow:alpha()', 'src:flow:beta()']));
    expect(names).not.toContain('src:flow');
  });

  it('reports when a possible-impact closure stops before exhausting its frontier', () => {
    const result = possibleImpactClosure(db, 'sharedOne', { maxDepth: 0 });

    expect(result.rows).toEqual([]);
    expect(result.coverage).toMatchObject({
      status: 'bounded',
      edgeBasis: 'reverse-static-call-or-reference-evidence',
      maxDepth: 0,
      reachedDepth: 0,
      remainingFrontierSymbols: 1,
    });
  });

  it('isolates callee fingerprints between adjacent functions so ranges do not cross-pollute', () => {
    // Regression guard for src/queries/cleanup/similar.ts getAllCalleeFingerprints.
    //
    // Prior to the canonical-range refactor the helper selected raw
    // defn_enclosing_ranges.start_line/end_line and fed those directly
    // into getCalleeRowsForSymbol. When an indexer emitted a range that
    // was slightly too wide, chunks belonging to the neighbouring
    // definition leaked into the callee set — so a function that only
    // calls sharedOne() would show sharedTwo() in its fingerprint (and
    // therefore the "unique" sets returned by similarAll would lie).
    //
    // We build a self-contained fixture with two multi-line functions
    // whose callees are disjoint and assert that the similarAll output
    // for the (alphaIso, betaIso) pair reflects what each function
    // actually calls.
    const isoTempDir = mkdtempSync(join(tmpdir(), 'scip-query-similar-iso-'));
    try {
      mkdirSync(join(isoTempDir, 'src'), { recursive: true });
      writeFileSync(
        join(isoTempDir, 'src', 'iso.ts'),
        [
          'export function sharedOne() { return 1; }',
          'export function sharedTwo() { return 2; }',
          'export function sharedThree() { return 3; }',
          'export function sharedFour() { return 4; }',
          'export function decoyOne() { return 5; }',
          'export function decoyTwo() { return 6; }',
          'export function alphaIso() {',
          '  sharedOne();',
          '  sharedThree();',
          '  sharedFour();',
          '  return 0;',
          '}',
          'export function betaIso() {',
          '  sharedTwo();',
          '  sharedThree();',
          '  sharedFour();',
          '  return 0;',
          '}',
          'export function decoyAlpha() {',
          '  decoyOne();',
          '  decoyTwo();',
          '  return 0;',
          '}',
          'export function decoyBeta() {',
          '  decoyOne();',
          '  decoyTwo();',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      );

      const isoDbPath = join(isoTempDir, 'index.db');
      const sqliteDb = new Database(isoDbPath);
      sqliteDb.exec(`
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

      sqliteDb.exec("INSERT INTO documents (id, language, relative_path) VALUES (1, 'typescript', 'src/iso.ts');");

      const insertSymbol = sqliteDb.prepare(
        `INSERT INTO global_symbols (id, symbol, display_name, kind, documentation)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insertSymbol.run(1, 'scip-typescript npm pkg 1.0.0 src/`iso.ts`/sharedOne().', 'sharedOne', 3, 'function');
      insertSymbol.run(2, 'scip-typescript npm pkg 1.0.0 src/`iso.ts`/sharedTwo().', 'sharedTwo', 3, 'function');
      insertSymbol.run(3, 'scip-typescript npm pkg 1.0.0 src/`iso.ts`/sharedThree().', 'sharedThree', 3, 'function');
      insertSymbol.run(4, 'scip-typescript npm pkg 1.0.0 src/`iso.ts`/sharedFour().', 'sharedFour', 3, 'function');
      insertSymbol.run(5, 'scip-typescript npm pkg 1.0.0 src/`iso.ts`/decoyOne().', 'decoyOne', 3, 'function');
      insertSymbol.run(6, 'scip-typescript npm pkg 1.0.0 src/`iso.ts`/decoyTwo().', 'decoyTwo', 3, 'function');
      insertSymbol.run(7, 'scip-typescript npm pkg 1.0.0 src/`iso.ts`/alphaIso().', 'alphaIso', 3, 'function');
      insertSymbol.run(8, 'scip-typescript npm pkg 1.0.0 src/`iso.ts`/betaIso().', 'betaIso', 3, 'function');
      insertSymbol.run(9, 'scip-typescript npm pkg 1.0.0 src/`iso.ts`/decoyAlpha().', 'decoyAlpha', 3, 'function');
      insertSymbol.run(10, 'scip-typescript npm pkg 1.0.0 src/`iso.ts`/decoyBeta().', 'decoyBeta', 3, 'function');

      sqliteDb.exec(`
        INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
          (1, 1, 1, 0, 0, 0, 0),
          (2, 1, 2, 1, 0, 1, 0),
          (3, 1, 3, 2, 0, 2, 0),
          (4, 1, 4, 3, 0, 3, 0),
          (5, 1, 5, 4, 0, 4, 0),
          (6, 1, 6, 5, 0, 5, 0),
          (7, 1, 7, 6, 0, 11, 0),
          (8, 1, 8, 12, 0, 17, 0),
          (9, 1, 9, 18, 0, 22, 0),
          (10, 1, 10, 23, 0, 27, 0);
      `);

      // One chunk per callsite so bounds vs chunk attribution is clean.
      sqliteDb.exec(`
        INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
          (1, 1, 0, 7, 7, X'00'),
          (2, 1, 1, 8, 8, X'00'),
          (3, 1, 2, 9, 9, X'00'),
          (4, 1, 3, 13, 13, X'00'),
          (5, 1, 4, 14, 14, X'00'),
          (6, 1, 5, 15, 15, X'00'),
          (7, 1, 6, 19, 19, X'00'),
          (8, 1, 7, 20, 20, X'00'),
          (9, 1, 8, 24, 24, X'00'),
          (10, 1, 9, 25, 25, X'00');
      `);

      sqliteDb.exec(`
        INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
          (1, 1, 0),
          (2, 3, 0),
          (3, 4, 0),
          (4, 2, 0),
          (5, 3, 0),
          (6, 4, 0),
          (7, 5, 0),
          (8, 6, 0),
          (9, 5, 0),
          (10, 6, 0);
      `);

      sqliteDb.close();

      const isoDb = new ScipDatabase({
        dbPath: isoDbPath,
        indexPath: join(isoTempDir, 'index.scip'),
        projectRoot: isoTempDir,
      });
      try {
        const results = similarAll(isoDb, {
          minSimilarity: 0.3,
          minCallees: 2,
          limit: 10,
        });

        const pair = results.find((result) => {
          const names = new Set([result.shortNameA, result.shortNameB]);
          return names.has('src:iso:alphaIso()') && names.has('src:iso:betaIso()');
        });

        expect(pair).toBeDefined();

        // Normalise so "A" is always alphaIso.
        const alphaIsA = pair!.shortNameA === 'src:iso:alphaIso()';
        const alphaUnique = alphaIsA ? pair!.uniqueToA : pair!.uniqueToB;
        const betaUnique = alphaIsA ? pair!.uniqueToB : pair!.uniqueToA;
        const shared = pair!.sharedCallees;

        // Invariant: every callee listed for alphaIso reflects what the
        // source actually calls. sharedTwo MUST NOT appear in alphaIso's
        // fingerprint (that would be cross-pollution from betaIso's
        // range); sharedOne MUST NOT appear in betaIso's.
        expect(alphaUnique).toContain('src:iso:sharedOne()');
        expect(alphaUnique).not.toContain('src:iso:sharedTwo()');
        expect(betaUnique).toContain('src:iso:sharedTwo()');
        expect(betaUnique).not.toContain('src:iso:sharedOne()');

        // Shared callees must be exactly sharedThree + sharedFour — the
        // two helpers both functions actually call.
        expect(new Set(shared)).toEqual(new Set(['src:iso:sharedThree()', 'src:iso:sharedFour()']));
      } finally {
        isoDb.close();
      }
    } finally {
      rmSync(isoTempDir, { recursive: true, force: true });
    }
  });

  it('does not manufacture a consolidation score when similar has no pair evidence', () => {
    const plan = similarConsolidationPlan(db, 'reindex', 'getIndexerConfig');

    expect(plan).toBeNull();
  });

  it('keeps the similar plan conservative when identical evidence does not prove equivalence', () => {
    const convergenceResult = convergence(db, 'isWorkerEntrySurface', 'isBarrelFile');
    const plan = similarConsolidationPlan(db, 'isWorkerEntrySurface', 'isBarrelFile');

    expect(convergenceResult).not.toBeNull();
    expect(plan).not.toBeNull();
    expect(convergenceResult!.similarity).toBe(plan!.similarity);
    expect(convergenceResult!.sharedCallees).toEqual(plan!.sharedEvidence);
    expect(convergenceResult!.consolidationStrategy).toContain('verify signatures');
    expect(convergenceResult!.consolidationStrategy).not.toContain('replace the other directly');
  });

  it('keeps stale-abstractions aligned with health filtering', () => {
    const stale = staleAbstractions(db, { minLoc: 1, limit: 20 });
    const report = health(db);
    const staleAction = report.actions.find((action) => action.category === 'Stale abstractions');

    // PathFilter lives in a contracts file: contract modules define types for
    // other modules by design, so single-consumer is their normal state — only
    // UNUSED contract types are stale. InstallMethod (0 consumers) stays.
    expect(stale.map((result) => result.shortName)).toEqual(['src:types:InstallMethod']);
    expect(stale.map((result) => result.shortName)).not.toContain('src:contracts:PathFilter');
    expect(report.findings.staleTypes).toBe(stale.length);
    expect(staleAction?.count).toBe(stale.length);
    expect(staleAction?.description).toContain('1 unused');
    expect(staleAction?.description).toContain('review public, runtime-registration, and ownership evidence');
    expect(report.scoreBreakdown.find((deduction) => deduction.axis === 'stale-abstractions')).toMatchObject({
      points: 1,
      detail: expect.stringContaining('1 unused stale abstraction(s); 0 single-consumer signal(s)'),
    });
  });

  it('does not call data members dead code unless member analysis is explicitly requested', () => {
    const defaultResults = dead(db, { minLoc: 1 });
    const memberResults = dead(db, { minLoc: 1, includeMembers: true });

    expect(defaultResults.symbols.map((result) => result.shortName)).not.toContain('src:config:Settings:unusedField');
    expect(memberResults.symbols.map((result) => result.shortName)).toContain('src:config:Settings:unusedField');
  });

  it('keeps role-one fallback definitions visible when a file also has enclosing ranges', () => {
    const configSymbols = symbols(db, 'config.ts');
    const match = findFirstSymbolMatch(db, 'settings');

    expect(configSymbols.map((result) => result.shortName)).toContain('src:config:settings');
    expect(configSymbols.find((result) => result.shortName === 'src:config:settings')).toMatchObject({
      startLine: 3,
      endLine: 3,
    });
    expect(match?.symbol).toBe('scip-typescript npm pkg 1.0.0 src/`config.ts`/settings.');
  });

  it('reports consistent symbol ranges and signatures across outline/members/change-surface/system/symbols', () => {
    // The invariant: a given symbol's (startLine, endLine) and signature must not depend
    // on which query you asked. Prior to the line-accuracy pass, outline
    // and members read raw der.* while symbols ran through the source-
    // correcting path, so they could disagree by a few lines.
    const utilSymbols = symbols(db, 'utils.ts');
    const outlineNodes = outline(db, 'utils.ts');
    const systemResult = system(db, 'utils.ts');
    const changeSurfaceResult = changeSurface(db, 'utils.ts');

    const rangeBySymbol = new Map<string, { startLine: number; endLine: number; signature: string | null }>();
    for (const s of utilSymbols) {
      rangeBySymbol.set(s.symbol, { startLine: s.startLine, endLine: s.endLine, signature: s.signature });
    }
    expect(rangeBySymbol.size).toBeGreaterThan(0);

    for (const node of outlineNodes) {
      const expected = rangeBySymbol.get(node.symbol);
      if (!expected) continue;
      expect({ startLine: node.startLine, endLine: node.endLine }).toEqual({
        startLine: expected.startLine,
        endLine: expected.endLine,
      });
      expect(node.signature).toBe(expected.signature);
    }
    for (const sym of systemResult.symbols) {
      const expected = rangeBySymbol.get(sym.symbol);
      if (!expected) continue;
      expect({ startLine: sym.startLine, endLine: sym.endLine }).toEqual({
        startLine: expected.startLine,
        endLine: expected.endLine,
      });
    }
    for (const entry of changeSurfaceResult!.symbols) {
      const expected = rangeBySymbol.get(entry.symbol);
      if (!expected) continue;
      expect({ startLine: entry.startLine, endLine: entry.endLine }).toEqual({
        startLine: expected.startLine,
        endLine: expected.endLine,
      });
    }

    const watcherMembers = members(db, 'Watcher');
    const watcherSymbols = symbols(db, 'watch.ts');
    const watcherRanges = new Map(
      watcherSymbols.map((s) => [s.symbol, { startLine: s.startLine, endLine: s.endLine }]),
    );
    for (const m of watcherMembers) {
      const expected = watcherRanges.get(m.symbol);
      if (!expected) continue;
      expect({ startLine: m.startLine, endLine: m.endLine }).toEqual(expected);
    }
  });

  it('accepts 1-indexed editor line numbers in file:line-line symbol lookup', () => {
    // src/predicates.ts has three non-overlapping single-line function
    // definitions at editor lines 1, 2, 3 (DB lines 0, 1, 2). Users type
    // editor-1-indexed lines; the helper must subtract 1 before comparing
    // against the 0-indexed DB columns.
    const firstMatch = findFirstSymbolMatch(db, 'src/predicates.ts:1-1');
    expect(firstMatch).not.toBeNull();
    expect(firstMatch!.symbol).toContain('normalizePath');

    const secondMatch = findFirstSymbolMatch(db, 'src/predicates.ts:2-2');
    expect(secondMatch).not.toBeNull();
    expect(secondMatch!.symbol).toContain('isWorkerEntrySurface');

    const thirdMatch = findFirstSymbolMatch(db, 'src/predicates.ts:3-3');
    expect(thirdMatch).not.toBeNull();
    expect(thirdMatch!.symbol).toContain('isBarrelFile');

    expect(findFirstSymbolMatch(db, './src/predicates.ts:2-2')?.symbol).toContain('isWorkerEntrySurface');
    expect(findFirstSymbolMatch(db, 'src\\predicates.ts:2-2')?.symbol).toContain('isWorkerEntrySurface');
    expect(findFirstSymbolMatch(db, 'predicates.ts:2-2')?.symbol).toContain('isWorkerEntrySurface');

    const plan = db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT gs.id
       FROM global_symbols gs
       JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
       JOIN documents d ON der.document_id = d.id
       WHERE d.relative_path = ?
         AND der.start_line <= ?
         AND der.end_line >= ?`,
      'src/predicates.ts',
      1,
      1,
    );
    expect(plan.some((row) => row.detail.includes('sqlite_autoindex_documents_1'))).toBe(true);
    expect(plan.some((row) => row.detail.includes('idx_defn_enclosing_ranges_document'))).toBe(true);
    expect(plan.some((row) => /SCAN der/u.test(row.detail))).toBe(false);
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
        expect(graph?.callees.map((callee) => callee.shortName)).toEqual(['src:db:Store:all()']);
        // The only call is at module top level. The module definition is an
        // owner/reference context, not a callable symbol, so call-graph must
        // not relabel it as a caller. refs/dataflow still retain both sites.
        expect(graph?.callers).toEqual([]);

        const result = complexity(callDb, 'collect');
        expect(result?.calleeCount).toBe(1);

        const bottleneckResults = bottlenecks(callDb, { minFanIn: 0, minFanOut: 1, limit: 20 });
        expect(bottleneckResults.map((row) => row.shortName)).toContain('src:query:collect()');
        expect(bottleneckResults.every((row) => row.symbol.endsWith('().'))).toBe(true);
        expect(bottleneckResults.map((row) => row.shortName)).not.toContain('src:db:Store');

        expect(refs(callDb, 'collect')).toEqual([
          { relativePath: 'src/consumer.ts', line: 0 },
          { relativePath: 'src/consumer.ts', line: 4 },
        ]);

        const flow = dataflow(callDb, 'collect');
        expect(flow?.definitionSites).toEqual([{ file: 'src/query.ts', line: 2 }]);
      } finally {
        callDb.close();
      }
    } finally {
      rmSync(callTempDir, { recursive: true, force: true });
    }
  });

  it('recovers Rust qualified path calls from SCIP mentions when AST attribution misses them', () => {
    const rustTempDir = mkdtempSync(join(tmpdir(), 'scip-query-rust-calls-'));
    try {
      mkdirSync(join(rustTempDir, 'src'), { recursive: true });
      writeFileSync(
        join(rustTempDir, 'src', 'main.rs'),
        ['//! Native entry point.', '', 'fn main() {', '    synth_runner_rust::run();', '}', ''].join('\n'),
      );
      writeFileSync(
        join(rustTempDir, 'src', 'app.rs'),
        ['pub fn run() {', '    build_app().run();', '}', ''].join('\n'),
      );

      const dbPath = join(rustTempDir, 'index.db');
      const sqliteDb = new Database(dbPath);
      sqliteDb.exec(`
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
        INSERT INTO documents (id, language, relative_path) VALUES
          (1, 'rust', 'src/main.rs'),
          (2, 'rust', 'src/app.rs');
        INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
          (1, 'rust-analyzer cargo fixture 0.1.0 main().', 'main', 12, 'fn main()'),
          (2, 'rust-analyzer cargo fixture 0.1.0 app/run().', 'run', 12, 'pub fn run()'),
          (3, 'rust-analyzer cargo fixture 0.1.0 app/RunResetResources#run.', 'run', 8, 'field run');
        INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
          (1, 1, 1, 2, 0, 4, 1),
          (2, 2, 2, 0, 0, 2, 1),
          (3, 2, 3, 20, 2, 20, 10);
        INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
          (1, 1, 0, 0, 4, X'00'),
          (2, 2, 0, 0, 2, X'00'),
          (3, 2, 1, 20, 20, X'00');
        INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
          (1, 1, 1),
          (1, 2, 0),
          (2, 2, 1),
          (3, 3, 1);
      `);
      sqliteDb.close();

      const rustDb = new ScipDatabase({
        dbPath,
        indexPath: join(rustTempDir, 'index.scip'),
        projectRoot: rustTempDir,
      });

      try {
        expect(findFirstSymbolMatch(rustDb, 'src/app.rs/run')?.symbol).toBe(
          'rust-analyzer cargo fixture 0.1.0 app/run().',
        );
        expect(callGraph(rustDb, 'main')?.callees.map((callee) => callee.shortName)).toEqual(['app:run()']);
      } finally {
        rustDb.close();
      }
    } finally {
      rmSync(rustTempDir, { recursive: true, force: true });
    }
  });
});
