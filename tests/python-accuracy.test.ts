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
import { ScipDatabase } from '../src/storage/db.js';
import { byKind, kindCounts } from '../src/queries/by-kind.js';
import { callGraph } from '../src/queries/call-graph.js';
import { complexity } from '../src/queries/complexity.js';
import { drift } from '../src/queries/drift.js';
import { fanIn } from '../src/queries/fan.js';
import { importedBy, imports, unusedImports } from '../src/queries/imports.js';
import { outline } from '../src/queries/outline.js';
import { symbols } from '../src/queries/symbols.js';
import { system } from '../src/queries/system.js';
import type { ScipQueryConfig } from '../src/domain/types.js';

function createPythonFixtureProject(projectRoot: string): void {
  mkdirSync(join(projectRoot, 'tests'), { recursive: true });

  writeFileSync(
    join(projectRoot, 'app.py'),
    [
      'import asyncio as aio',
      'import json as unused_json',
      'from simulation import GardenSimulation, helper as helper_alias',
      '',
      'def run():',
      '    aio.sleep(0)',
      '    sim = GardenSimulation()',
      '    return helper_alias()',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(projectRoot, 'analysis.py'),
    [
      'from simulation import GardenSimulation',
      '',
      'def inspect():',
      '    return GardenSimulation',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(projectRoot, 'simulation.py'),
    [
      'class GardenSimulation:',
      '    pass',
      '',
      'def helper():',
      '    return 1',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(projectRoot, 'tests', 'test_simulation.py'),
    [
      'from simulation import GardenSimulation',
      '',
      'def test_model():',
      '    assert GardenSimulation is not None',
      '',
    ].join('\n'),
  );
}

function createPythonFixtureDb(dbPath: string): void {
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
      (1, 'python', 'app.py'),
      (2, 'python', 'analysis.py'),
      (3, 'python', 'simulation.py'),
      (4, 'python', 'tests/test_simulation.py');
  `);

  const insertSymbol = sqliteDb.prepare(
    `INSERT INTO global_symbols (id, symbol, display_name, kind, documentation)
     VALUES (?, ?, ?, ?, ?)`
  );

  insertSymbol.run(1, 'scip-python python project 0.1.0 simulation/', 'simulation', null, 'module');
  insertSymbol.run(2, 'scip-python python project 0.1.0 simulation/GardenSimulation#', 'GardenSimulation', null, 'class GardenSimulation:');
  insertSymbol.run(3, 'scip-python python project 0.1.0 simulation/helper().', 'helper', null, 'def helper():');

  run(`
    INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
      (1, 3, 1, 0, 0, 5, 0),
      (2, 3, 2, 0, 0, 1, 0),
      (3, 3, 3, 3, 0, 4, 0);
  `);

  run(`
    INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
      (1, 1, 0, 0, 7, X'00'),
      (2, 2, 0, 0, 3, X'00'),
      (3, 3, 0, 0, 5, X'00'),
      (4, 4, 0, 0, 3, X'00');
  `);

  run(`
    INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
      (1, 2, 0),
      (1, 3, 0),
      (2, 2, 0),
      (3, 1, 1),
      (3, 2, 1),
      (3, 3, 1),
      (4, 2, 0);
  `);

  sqliteDb.close();
}

function createPythonCallFixtureProject(projectRoot: string): void {
  mkdirSync(join(projectRoot, 'tests'), { recursive: true });

  writeFileSync(
    join(projectRoot, 'app.py'),
    [
      'import os',
      'from simulation import GardenSimulation',
      '',
      'def run():',
      '    os.path.exists("garden.json")',
      '    sim = GardenSimulation()',
      '    sim.advance_cycle()',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(projectRoot, 'analysis.py'),
    [
      'from simulation import GardenSimulation',
      '',
      'def inspect():',
      '    sim = GardenSimulation()',
      '    return sim.advance_cycle()',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(projectRoot, 'simulation.py'),
    [
      'class GardenSimulation:',
      '    def advance_cycle(self):',
      '        self._apply_weather()',
      '        self._apply_weeds()',
      '        self.recalculate_mood()',
      '',
      '    def _apply_weather(self):',
      '        return "weather"',
      '',
      '    def _apply_weeds(self):',
      '        return "weeds"',
      '',
      '    def recalculate_mood(self):',
      '        return "mood"',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(projectRoot, 'tests', 'test_simulation.py'),
    [
      'from simulation import GardenSimulation',
      '',
      'def test_model():',
      '    sim = GardenSimulation()',
      '    sim.advance_cycle()',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(projectRoot, 'db_helpers.ts'),
    [
      'export function exists() {',
      '  return true;',
      '}',
      '',
    ].join('\n'),
  );
}

function createPythonCallFixtureDb(dbPath: string): void {
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
      (1, 'python', 'app.py'),
      (2, 'python', 'analysis.py'),
      (3, 'python', 'simulation.py'),
      (4, 'python', 'tests/test_simulation.py'),
      (5, 'typescript', 'db_helpers.ts');
  `);

  const insertSymbol = sqliteDb.prepare(
    `INSERT INTO global_symbols (id, symbol, display_name, kind, documentation)
     VALUES (?, ?, ?, ?, ?)`
  );

  insertSymbol.run(1, 'scip-python python project 0.1.0 simulation/', 'simulation', null, 'module');
  insertSymbol.run(2, 'scip-python python project 0.1.0 simulation/GardenSimulation#', 'GardenSimulation', null, 'class GardenSimulation:');
  insertSymbol.run(3, 'scip-python python project 0.1.0 simulation/GardenSimulation#advance_cycle().', 'advance_cycle', null, 'def advance_cycle(self):');
  insertSymbol.run(4, 'scip-python python project 0.1.0 simulation/GardenSimulation#_apply_weather().', '_apply_weather', null, 'def _apply_weather(self):');
  insertSymbol.run(5, 'scip-python python project 0.1.0 simulation/GardenSimulation#_apply_weeds().', '_apply_weeds', null, 'def _apply_weeds(self):');
  insertSymbol.run(6, 'scip-python python project 0.1.0 simulation/GardenSimulation#recalculate_mood().', 'recalculate_mood', null, 'def recalculate_mood(self):');
  insertSymbol.run(7, 'scip-python python project 0.1.0 app/run().', 'run', null, 'def run():');
  insertSymbol.run(8, 'scip-python python project 0.1.0 analysis/inspect().', 'inspect', null, 'def inspect():');
  insertSymbol.run(9, 'scip-python python project 0.1.0 test_simulation/test_model().', 'test_model', null, 'def test_model():');
  insertSymbol.run(10, 'scip-typescript npm project 0.1.0 `db_helpers.ts`/exists().', 'exists', 23, 'function exists(): boolean');

  run(`
    INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
      (1, 3, 1, 0, 0, 13, 0),
      (2, 3, 2, 0, 0, 13, 0),
      (3, 3, 3, 1, 0, 4, 0),
      (4, 3, 4, 6, 0, 7, 0),
      (5, 3, 5, 9, 0, 10, 0),
      (6, 3, 6, 12, 0, 13, 0),
      (7, 1, 7, 3, 0, 6, 0),
      (8, 2, 8, 2, 0, 4, 0),
      (9, 4, 9, 2, 0, 4, 0),
      (10, 5, 10, 0, 0, 2, 0);
  `);

  run(`
    INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
      (1, 1, 0, 0, 6, X'00'),
      (2, 2, 0, 0, 5, X'00'),
      (3, 3, 0, 0, 13, X'00'),
      (4, 4, 0, 0, 5, X'00'),
      (5, 5, 0, 0, 2, X'00');
  `);

  run(`
    INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
      (3, 1, 1),
      (3, 2, 1),
      (3, 3, 1),
      (3, 4, 1),
      (3, 5, 1),
      (3, 6, 1),
      (1, 7, 1),
      (2, 8, 1),
      (4, 9, 1),
      (5, 10, 1);
  `);

  sqliteDb.close();
}

describe('python repo accuracy regressions', () => {
  let db: ScipDatabase;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-python-'));
    createPythonFixtureProject(tempDir);
    const dbPath = join(tempDir, 'index.db');
    createPythonFixtureDb(dbPath);

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

  it('parses Python imports for imports/imported-by/unused-imports fallback', () => {
    expect(imports(db, 'app.py').map((result) => ({
      shortName: result.shortName,
      fromFile: result.fromFile,
    }))).toEqual([
      { shortName: 'asyncio as aio', fromFile: '(external)' },
      { shortName: 'json as unused_json', fromFile: '(external)' },
      { shortName: 'GardenSimulation', fromFile: 'simulation.py' },
      { shortName: 'helper as helper_alias', fromFile: 'simulation.py' },
    ]);

    expect(importedBy(db, 'GardenSimulation').map((result) => result.fromFile)).toEqual([
      'analysis.py',
      'app.py',
      'tests/test_simulation.py',
    ]);

    expect(unusedImports(db, 'app.py').map((result) => result.shortName)).toEqual([
      'json as unused_json',
    ]);
  });

  it('does not invent layer violations for flat root-level Python modules or tests', () => {
    const result = drift(db);

    expect(result.layerViolations).toBe(0);
    expect(result.results.some((entry) => entry.kind === 'layer-violation')).toBe(false);
  });

  it('resolves file-oriented commands to the exact Python file instead of fuzzy matches', () => {
    const symbolNames = symbols(db, 'simulation.py').map((result) => result.shortName);
    expect(symbolNames).toHaveLength(3);
    expect(symbolNames).toEqual(expect.arrayContaining([
      'simulation',
      'simulation:GardenSimulation',
      'simulation:helper()',
    ]));

    // outline returns a tree — root is the module, children are nested under it
    const roots = outline(db, 'simulation.py');
    function collectNames(nodes: typeof roots): string[] {
      return nodes.flatMap((n) => [n.shortName, ...collectNames(n.children)]);
    }
    const outlineNames = collectNames(roots);
    expect(outlineNames).toHaveLength(3);
    expect(outlineNames).toEqual(expect.arrayContaining([
      'simulation',
      'simulation:GardenSimulation',
      'simulation:helper()',
    ]));

    const result = system(db, 'simulation.py');
    expect(result.files).toEqual(['simulation.py']);
    expect(result.dependedOnBy).toEqual(['analysis.py', 'app.py', 'tests/test_simulation.py']);
  });

  it('infers useful kinds when the Python index omits kind metadata', () => {
    expect(byKind(db, 'class').map((result) => result.shortName)).toEqual([
      'simulation:GardenSimulation',
    ]);

    expect(byKind(db, 'function').map((result) => result.shortName)).toEqual([
      'simulation:helper()',
    ]);

    expect(kindCounts(db)).toEqual([
      { kind: 9, kindName: 'Class', count: 1 },
      { kind: 23, kindName: 'Function', count: 1 },
      { kind: 39, kindName: 'Module', count: 1 },
    ]);
  });

  it('resolves fan-in against the exact Python symbol', () => {
    expect(fanIn(db, 'GardenSimulation')).toEqual([
      { name: 'simulation:GardenSimulation', count: 3 },
    ]);
  });

  it('falls back to Python source calls when the index omits function-internal mentions', () => {
    const callTempDir = mkdtempSync(join(tmpdir(), 'scip-query-python-calls-'));
    try {
      createPythonCallFixtureProject(callTempDir);
      const dbPath = join(callTempDir, 'index.db');
      createPythonCallFixtureDb(dbPath);

      const callDb = new ScipDatabase({
        dbPath,
        indexPath: join(callTempDir, 'index.scip'),
        projectRoot: callTempDir,
      });

      try {
        const graph = callGraph(callDb, 'advance_cycle');
        expect(graph?.callees.map((callee) => callee.shortName)).toEqual([
          'simulation:GardenSimulation:_apply_weather()',
          'simulation:GardenSimulation:_apply_weeds()',
          'simulation:GardenSimulation:recalculate_mood()',
        ]);
        expect(graph?.callers.map((caller) => caller.shortName)).toEqual([
          'analysis:inspect()',
          'app:run()',
          'test_simulation:test_model()',
        ]);

        const runGraph = callGraph(callDb, 'run');
        expect(runGraph?.callees.map((callee) => callee.shortName)).not.toContain('db_helpers:exists()');

        const result = complexity(callDb, 'advance_cycle');
        expect(result?.calleeCount).toBe(3);
      } finally {
        callDb.close();
      }
    } finally {
      rmSync(callTempDir, { recursive: true, force: true });
    }
  });
});
