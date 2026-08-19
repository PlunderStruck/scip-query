import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../src/storage/db.js';
import { callGraph } from '../../src/queries/navigation/call-graph.js';
import { code } from '../../src/queries/navigation/code.js';
import { dataflow } from '../../src/queries/navigation/dataflow.js';
import { inspectSource } from '../../src/queries/navigation/source-inspection.js';
import { symbols } from '../../src/queries/navigation/symbols.js';
import { trace } from '../../src/queries/navigation/trace.js';
import { byKind, kindCounts } from '../../src/queries/navigation/by-kind.js';
import { complexityHotspots } from '../../src/queries/quality/complexity-hotspots.js';
import { buildAstCalleeMap, buildCalleeMap, buildChunkCalleeMap } from '../../src/symbols/graph/call-graph-evidence.js';
import { buildCrossFileCallerMap } from '../../src/symbols/references/reference-callers.js';
import { pickAstCallCandidate } from '../../src/symbols/leaf-symbol-index.js';
import type { ScipQueryConfig } from '../../src/domain/types.js';
import type { SymbolSemanticEvidencePort } from '../../src/symbols/semantic-evidence-port.js';

function createSchema(sqliteDb: Database.Database): void {
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
    CREATE INDEX idx_chunks_doc_id ON chunks(document_id);
    CREATE INDEX idx_global_symbols_symbol ON global_symbols(symbol);
  `);
}

function withFixture(
  name: string,
  files: Record<string, string>,
  populateDb: (sqliteDb: Database.Database) => void,
  run: (db: ScipDatabase) => void,
): void {
  const tempDir = mkdtempSync(join(tmpdir(), `scip-query-${name}-`));
  const projectRoot = join(tempDir, 'project');
  const dbPath = join(tempDir, 'index.db');

  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const fullPath = join(projectRoot, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, source);
    }

    const sqliteDb = new Database(dbPath);
    createSchema(sqliteDb);
    populateDb(sqliteDb);
    sqliteDb.close();

    const config: ScipQueryConfig = {
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
      projectRoot,
    };
    const db = new ScipDatabase(config);
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('source-backed accuracy regressions', () => {
  it('consumes compiler-resolved symbol facts only through the injected semantic-evidence port', () => {
    withFixture(
      'semantic-evidence-port',
      {
        'src/target.custom': 'def target\nend\n',
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'text', 'src/target.custom');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'custom src/\`target.custom\`/target().', 'target', 12, 'target');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 1, 3);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 1, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1);
        `);
      },
      (db) => {
        const definition = {
          documentId: 1,
          startLine: 0,
          endLine: 1,
          symbolId: 1,
          symbol: 'custom src/`target.custom`/target().',
          relativePath: 'src/target.custom',
        };
        const semanticEvidence: SymbolSemanticEvidencePort = {
          references: () => [],
          referenceMap: () => new Map(),
          callerMap: () => new Map([[definition.symbolId, new Set(['src/semantic-caller.ts'])]]),
          calleeMap: () =>
            new Map([
              [
                definition.symbolId,
                [
                  {
                    symbol: 'custom src/`helper.custom`/helper().',
                    file: 'src/helper.custom',
                    line: 4,
                    callsiteLine: 1,
                  },
                ],
              ],
            ]),
        };

        expect(buildCalleeMap(db, [definition], { semanticEvidence }).get(definition.symbolId)).toContainEqual({
          symbol: 'custom src/`helper.custom`/helper().',
          file: 'src/helper.custom',
          chunkId: -1,
          source: 'semantic-callee',
          callsiteLine: 1,
        });
        expect(buildCrossFileCallerMap(db, [definition], { semanticEvidence }).get(definition.symbolId)).toContain(
          'src/semantic-caller.ts',
        );
      },
    );
  });

  it('attributes AST callsites to the innermost containing definition', () => {
    withFixture(
      'ast-line-owner',
      {
        'src/nested.ts': [
          'export function outer() {',
          '  function inner() {',
          '    return helper();',
          '  }',
          '  return inner();',
          '}',
          '',
          'export function helper() {',
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/nested.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`nested.ts\`/outer().', 'outer', 12, 'function outer|function outer(): number'),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`nested.ts\`/outer().inner().', 'inner', 12, 'function inner|function inner(): number'),
            (3, 'scip-typescript npm fixture 1.0.0 src/\`nested.ts\`/helper().', 'helper', 12, 'function helper|function helper(): number');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 5, 1),
            (2, 1, 2, 1, 2, 3, 3),
            (3, 1, 3, 7, 0, 9, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 5, X'00'),
            (2, 1, 1, 1, 3, X'00'),
            (3, 1, 2, 7, 9, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 2, 1),
            (3, 3, 1);
        `);
      },
      (db) => {
        const map = buildAstCalleeMap(db, [
          {
            symbolId: 1,
            documentId: 1,
            startLine: 0,
            endLine: 5,
            symbol: 'scip-typescript npm fixture 1.0.0 src/`nested.ts`/outer().',
            relativePath: 'src/nested.ts',
          },
          {
            symbolId: 2,
            documentId: 1,
            startLine: 1,
            endLine: 3,
            symbol: 'scip-typescript npm fixture 1.0.0 src/`nested.ts`/outer().inner().',
            relativePath: 'src/nested.ts',
          },
          {
            symbolId: 3,
            documentId: 1,
            startLine: 7,
            endLine: 9,
            symbol: 'scip-typescript npm fixture 1.0.0 src/`nested.ts`/helper().',
            relativePath: 'src/nested.ts',
          },
        ]);

        expect(map.get(2)).toContainEqual({
          symbol: 'scip-typescript npm fixture 1.0.0 src/`nested.ts`/helper().',
          file: 'src/nested.ts',
          chunkId: 2,
          source: 'ast-callsite',
          callsiteLine: 2,
        });
        expect(map.get(1)).toContainEqual({
          symbol: 'scip-typescript npm fixture 1.0.0 src/`nested.ts`/outer().inner().',
          file: 'src/nested.ts',
          chunkId: 4,
          source: 'ast-callsite',
          callsiteLine: 4,
        });
      },
    );
  });

  it('uses the imported receiver identity before admitting a member-call candidate', () => {
    withFixture(
      'qualified-member-callee',
      {
        'src/caller.ts': [
          "import * as Correct from './correct.js';",
          "import * as Other from './other.js';",
          'export function correct() { return Correct.make(); }',
          'export function unrelated() { return Other.make(); }',
        ].join('\n'),
        'src/correct.ts': 'export function make() { return 1; }\n',
        'src/other.ts': 'export function make() { return 2; }\n',
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/caller.ts'),
            (2, 'typescript', 'src/correct.ts'),
            (3, 'typescript', 'src/other.ts');
        `);
      },
      (db) => {
        const candidate = {
          symbol: 'scip-typescript npm fixture 1.0.0 src/`correct.ts`/make().',
          file: 'src/correct.ts',
        };
        expect(pickAstCallCandidate(db, 'src/caller.ts', [candidate], true, 'Correct')).toEqual(candidate);
        expect(pickAstCallCandidate(db, 'src/caller.ts', [candidate], true, 'Other')).toBeNull();
        expect(pickAstCallCandidate(db, 'src/caller.ts', [candidate], true, 'localService')).toBeNull();
      },
    );
  });

  it('requires same-file call shape and receiver ownership before selecting a callee', () => {
    withFixture(
      'same-file-callee-shape',
      {
        'src/caller.ts': [
          'interface Runtime { write(value: string): void; }',
          "export function run(runtime: Runtime) { runtime.write('ok'); }",
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec("INSERT INTO documents (id, language, relative_path) VALUES (1, 'typescript', 'src/caller.ts');");
      },
      (db) => {
        const matchingMember = {
          symbol: 'scip-typescript npm fixture 1.0.0 src/`caller.ts`/Runtime#write().',
          file: 'src/caller.ts',
        };
        const wrongMember = {
          symbol: 'scip-typescript npm fixture 1.0.0 src/`caller.ts`/Snapshot#write().',
          file: 'src/caller.ts',
        };

        expect(pickAstCallCandidate(db, 'src/caller.ts', [matchingMember], true, 'runtime')).toEqual(matchingMember);
        expect(pickAstCallCandidate(db, 'src/caller.ts', [matchingMember], true, 'self')).toEqual(matchingMember);
        expect(pickAstCallCandidate(db, 'src/caller.ts', [wrongMember], true, 'runtime')).toBeNull();
        expect(pickAstCallCandidate(db, 'src/caller.ts', [wrongMember], false)).toBeNull();
      },
    );
  });

  it('does not attribute an imported external function call to an unrelated indexed symbol', () => {
    withFixture(
      'external-direct-callee',
      {
        'src/caller.ts': ["import { mkdirSync } from 'node:fs';", "export function run() { mkdirSync('tmp'); }"].join(
          '\n',
        ),
        'src/unrelated.ts': 'export function mkdirSync() { return false; }\n',
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/caller.ts'),
            (2, 'typescript', 'src/unrelated.ts');
          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`caller.ts\`/run().', 'run', 12, 'function run'),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`unrelated.ts\`/mkdirSync().', 'mkdirSync', 12, 'function mkdirSync');
          INSERT INTO defn_enclosing_ranges
            (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 1, 0, 1, 45),
            (2, 2, 2, 0, 0, 0, 47);
          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 1, 1, X'00'),
            (2, 2, 0, 0, 0, X'00');
          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 2, 1);
        `);
      },
      (db) => {
        const packet = inspectSource(db, {
          symbols: ['run'],
          evidence: { parts: ['definition', 'callees'] },
        });

        expect(packet.units?.filter((unit) => unit.kind === 'source').map((unit) => unit.relativePath)).not.toContain(
          'src/unrelated.ts',
        );
      },
    );
  });

  it('does not turn an unrelated imported receiver into a same-leaf callee edge', () => {
    withFixture(
      'qualified-member-callee-map',
      {
        'src/caller.ts': [
          "import * as Correct from './correct.js';",
          "import * as Other from './other.js';",
          'export function run() { Correct.make(); Other.make(); }',
        ].join('\n'),
        'src/correct.ts': 'export function make() { return 1; }\n',
        'src/other.ts': 'export function make() { return 2; }\n',
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/caller.ts'),
            (2, 'typescript', 'src/correct.ts'),
            (3, 'typescript', 'src/other.ts');
          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`caller.ts\`/run().', 'run', 12, 'function run'),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`correct.ts\`/make().', 'make', 12, 'function make');
          INSERT INTO defn_enclosing_ranges
            (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 2, 0, 2, 58),
            (2, 2, 2, 0, 0, 0, 36);
          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 2, 2, X'00'),
            (2, 2, 0, 0, 0, X'00');
          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 2, 1);
        `);
      },
      (db) => {
        const callees = buildAstCalleeMap(db, [
          {
            symbolId: 1,
            documentId: 1,
            startLine: 2,
            endLine: 2,
            symbol: 'scip-typescript npm fixture 1.0.0 src/`caller.ts`/run().',
            relativePath: 'src/caller.ts',
          },
        ]).get(1);

        expect(callees).toEqual([
          {
            symbol: 'scip-typescript npm fixture 1.0.0 src/`correct.ts`/make().',
            file: 'src/correct.ts',
            chunkId: 2,
            source: 'ast-callsite',
            callsiteLine: 2,
          },
        ]);
      },
    );
  });

  it('keeps chunk callee evidence scoped to requested definition documents', () => {
    withFixture(
      'chunk-callee-scope',
      {
        'src/target.custom': ['def target', '  helper()', 'end', '', 'def helper', 'end', ''].join('\n'),
        'src/unrelated.custom': ['def unrelated', '  noisy()', 'end', ''].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'text', 'src/target.custom'),
            (2, 'text', 'src/unrelated.custom');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'custom src/\`target.custom\`/target().', 'target', 12, 'target'),
            (2, 'custom src/\`target.custom\`/helper().', 'helper', 12, 'helper'),
            (3, 'custom src/\`unrelated.custom\`/noisy().', 'noisy', 12, 'noisy');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 2, 3),
            (2, 1, 2, 4, 0, 5, 3),
            (3, 2, 3, 0, 0, 2, 3);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 2, X'00'),
            (2, 1, 1, 4, 5, X'00'),
            (3, 2, 0, 0, 2, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (1, 2, 0),
            (2, 2, 1),
            (3, 3, 1),
            (3, 3, 0);
        `);
      },
      (db) => {
        const map = buildChunkCalleeMap(db, [
          {
            documentId: 1,
            startLine: 0,
            endLine: 2,
            symbolId: 1,
          },
        ]);

        expect(map.get(1)).toEqual([
          {
            symbol: 'custom src/`target.custom`/helper().',
            file: 'src/target.custom',
            chunkId: 1,
            source: 'scip-chunk',
          },
        ]);
      },
    );
  });

  it('attributes Clojure list callsites to containing definitions', () => {
    withFixture(
      'clojure-callsite-owner',
      {
        'src/demo/core.clj': [
          '(ns demo.core)',
          '',
          '(defn greet [name]',
          '  (println name)',
          '  (helper name))',
          '',
          '(def config',
          '  {:enabled true})',
          '',
          '(defn helper [x]',
          '  x)',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'Clojure', 'src/demo/core.clj');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-clojure deps.edn demo . \`demo.core\`/greet.', 'greet', 17, 'greet'),
            (2, 'scip-clojure deps.edn demo . \`demo.core\`/helper.', 'helper', 17, 'helper'),
            (3, 'scip-clojure deps.edn demo . \`demo.core\`/config.', 'config', 61, 'config');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 2, 0, 4, 16),
            (2, 1, 2, 9, 0, 10, 4),
            (3, 1, 3, 6, 0, 7, 18);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 2, 4, X'00'),
            (2, 1, 1, 9, 10, X'00'),
            (3, 1, 2, 6, 7, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 2, 1),
            (3, 3, 1);
        `);
      },
      (db) => {
        const map = buildAstCalleeMap(db, [
          {
            documentId: 1,
            startLine: 2,
            endLine: 4,
            symbolId: 1,
            symbol: 'scip-clojure deps.edn demo . `demo.core`/greet.',
            relativePath: 'src/demo/core.clj',
          },
        ]);

        expect(map.get(1)).toEqual([
          {
            symbol: 'scip-clojure deps.edn demo . `demo.core`/helper.',
            file: 'src/demo/core.clj',
            chunkId: 4,
            source: 'ast-callsite',
            callsiteLine: 4,
          },
        ]);
        expect(byKind(db, 'function').map((result) => result.shortName)).toEqual([
          'demo.core:greet',
          'demo.core:helper',
        ]);
        expect(kindCounts(db)).toEqual([
          { kind: 17, kindName: 'Function', count: 2 },
          { kind: 61, kindName: 'Variable', count: 1 },
        ]);
        expect(complexityHotspots(db, { minLoc: 1, limit: 10 }).map((result) => result.shortName)).toEqual([
          'demo.core:greet',
          'demo.core:helper',
        ]);
      },
    );
  });

  it('requires source-callable evidence for Clojure complexity hotspots', () => {
    withFixture(
      'clojure-hotspot-source-callable',
      {
        'src/demo/core.clj': [
          '(ns demo.core)',
          '',
          '(def large-value',
          '  {:a 1',
          '   :b 2',
          '   :c 3})',
          '',
          '(defn actual-callable [x]',
          '  (helper x))',
          '',
          '(defn helper [x]',
          '  x)',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'Clojure', 'src/demo/core.clj');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-clojure deps.edn demo . \`demo.core\`/large-value.', 'large-value', 17, 'large-value'),
            (2, 'scip-clojure deps.edn demo . \`demo.core\`/actual-callable.', 'actual-callable', 17, 'actual-callable'),
            (3, 'scip-clojure deps.edn demo . \`demo.core\`/helper.', 'helper', 17, 'helper');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 2, 0, 5, 10),
            (2, 1, 2, 7, 0, 8, 13),
            (3, 1, 3, 10, 0, 11, 4);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 2, 5, X'00'),
            (2, 1, 1, 7, 8, X'00'),
            (3, 1, 2, 10, 11, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 2, 1),
            (3, 3, 1);
        `);
      },
      (db) => {
        expect(complexityHotspots(db, { minLoc: 1, limit: 10 }).map((result) => result.shortName)).toEqual([
          'demo.core:actual-callable',
          'demo.core:helper',
        ]);
      },
    );
  });

  it('keeps AST caller evidence for target symbol matches without cached leaf metadata', () => {
    withFixture(
      'caller-target-leaf',
      {
        'src/caller.ts': [
          'import { target, noise } from "./target";',
          '',
          'export function run() {',
          '  target();',
          '  noise();',
          '}',
          '',
        ].join('\n'),
        'src/target.ts': [
          'export function target() {',
          '  return 1;',
          '}',
          '',
          'export function noise() {',
          '  return 2;',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/caller.ts'),
            (2, 'typescript', 'src/target.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`caller.ts\`/run().', 'run', 12, 'function run|function run(): void'),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`target.ts\`/target().', 'target', 12, 'function target|function target(): number'),
            (3, 'scip-typescript npm fixture 1.0.0 src/\`target.ts\`/noise().', 'noise', 12, 'function noise|function noise(): number');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 2, 0, 5, 1),
            (2, 2, 2, 0, 0, 2, 1),
            (3, 2, 3, 4, 0, 6, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 2, 5, X'00'),
            (2, 2, 0, 0, 2, X'00'),
            (3, 2, 1, 4, 6, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 2, 1),
            (3, 3, 1);
        `);
      },
      (db) => {
        const map = buildCrossFileCallerMap(
          db,
          [
            {
              symbolId: 2,
              documentId: 2,
              startLine: 0,
              endLine: 2,
              symbol: 'scip-typescript npm fixture 1.0.0 src/`target.ts`/target().',
              relativePath: 'src/target.ts',
            },
          ],
          { semantic: false },
        );

        expect(map.get(2)).toEqual(new Set(['src/caller.ts']));
      },
    );
  });

  it('repairs callable definition ranges before rendering code and symbols', () => {
    withFixture(
      'definition-range',
      {
        'src/helpers.ts': [
          'export function firstHelper() {',
          "  return 'first';",
          '}',
          '',
          'export function targetHelper() {',
          '  return firstHelper();',
          '}',
          '',
          'export const assignedTarget = () => {',
          '  const value = firstHelper();',
          '  return value;',
          '};',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/helpers.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`helpers.ts\`/firstHelper().', 'firstHelper', 12, 'function firstHelper|function firstHelper(): string'),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`helpers.ts\`/targetHelper().', 'targetHelper', 12, 'function targetHelper|function targetHelper(): string'),
            (3, 'scip-typescript npm fixture 1.0.0 src/\`helpers.ts\`/assignedTarget.', 'assignedTarget', 13, 'const assignedTarget|const assignedTarget: () => string');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 2, 1),
            (2, 1, 2, 0, 0, 2, 1),
            (3, 1, 3, 8, 0, 8, 37);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 2, X'00'),
            (2, 1, 1, 4, 6, X'00'),
            (3, 1, 2, 8, 8, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 2, 1),
            (2, 1, 0),
            (3, 3, 1),
            (3, 1, 0);
        `);
      },
      (db) => {
        const targetRow = symbols(db, 'helpers.ts').find((row) => row.shortName === 'src:helpers:targetHelper()');
        expect(targetRow).toBeDefined();
        expect(targetRow!.endLine).toBeGreaterThan(targetRow!.startLine);

        const snippet = code(db, 'src:helpers:targetHelper()');
        expect(snippet?.source).toContain('export function targetHelper()');
        expect(snippet?.source).toContain('return firstHelper();');
        expect(snippet?.source).not.toContain("return 'first';");

        const traced = trace(db, 'src:helpers:targetHelper()');
        expect(traced.definitions[0]?.source).toContain('targetHelper');
        expect(traced.definitions[0]?.source).toContain('firstHelper()');

        const assignedRow = symbols(db, 'helpers.ts').find((row) => row.shortName.includes('assignedTarget'));
        expect(assignedRow).toBeDefined();
        expect(assignedRow!.startLine).toBe(8);
        expect(assignedRow!.endLine).toBe(11);

        const assignedSnippet = code(db, 'assignedTarget');
        expect(assignedSnippet?.source).toContain('export const assignedTarget = () => {');
        expect(assignedSnippet?.source).toContain('const value = firstHelper();');
        expect(assignedSnippet?.source).toContain('return value;');
      },
    );
  });

  it('prefers source-backed caller recovery over stale semantic caller lines in the same file', () => {
    withFixture(
      'caller-merge',
      {
        'src/api.ts': ['export function renderReport() {', "  return 'ready';", '}', ''].join('\n'),
        'src/consumer.ts': [
          "import { renderReport } from './api.js';",
          '',
          'export function unrelatedHelper() {',
          "  return 'helper';",
          '}',
          '',
          'export function realCaller() {',
          '  return renderReport();',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/api.ts'),
            (2, 'typescript', 'src/consumer.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`api.ts\`/renderReport().', 'renderReport', 12, 'function renderReport|function renderReport(): string'),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`consumer.ts\`/unrelatedHelper().', 'unrelatedHelper', 12, 'function unrelatedHelper|function unrelatedHelper(): string'),
            (3, 'scip-typescript npm fixture 1.0.0 src/\`consumer.ts\`/realCaller().', 'realCaller', 12, 'function realCaller|function realCaller(): string');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 2, 1),
            (2, 2, 2, 2, 0, 4, 1),
            (3, 2, 3, 6, 0, 8, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 2, X'00'),
            (2, 2, 0, 2, 4, X'00'),
            (3, 2, 1, 6, 8, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 2, 1),
            (3, 3, 1),
            (2, 1, 0);
        `);
      },
      (db) => {
        const graph = callGraph(db, 'renderReport');
        expect(graph?.callers.map((row) => row.shortName)).toEqual(['src:consumer:realCaller()']);
      },
    );
  });

  it('uses parsed call sites instead of structural mentions when source call recovery is available', () => {
    withFixture(
      'callee-filter',
      {
        'src/summary.ts': [
          'export type Summary = {',
          '  label: string;',
          '};',
          '',
          'export function formatLabel() {',
          "  return 'ready';",
          '}',
          '',
          'export function buildSummary() {',
          '  const summary: Summary = { label: formatLabel() };',
          '  return summary.label;',
          '}',
          '',
        ].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'src/summary.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 src/\`summary.ts\`/Summary#', 'Summary', 11, 'type Summary|type Summary = { label: string }'),
            (2, 'scip-typescript npm fixture 1.0.0 src/\`summary.ts\`/Summary#label.', 'label', 8, 'property label|string'),
            (3, 'scip-typescript npm fixture 1.0.0 src/\`summary.ts\`/formatLabel().', 'formatLabel', 12, 'function formatLabel|function formatLabel(): string'),
            (4, 'scip-typescript npm fixture 1.0.0 src/\`summary.ts\`/buildSummary().', 'buildSummary', 12, 'function buildSummary|function buildSummary(): Summary');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 2, 1),
            (2, 1, 2, 1, 2, 1, 14),
            (3, 1, 3, 4, 0, 6, 1),
            (4, 1, 4, 8, 0, 11, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 4, 6, X'00'),
            (2, 1, 1, 8, 11, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 3, 1),
            (2, 4, 1),
            (2, 1, 0),
            (2, 2, 0),
            (2, 3, 0);
        `);
      },
      (db) => {
        const graph = callGraph(db, 'buildSummary');
        expect(graph?.callees.map((row) => row.shortName)).toEqual(['src:summary:formatLabel()']);
      },
    );
  });

  it('does not resolve member calls to unrelated unique global functions', () => {
    withFixture(
      'member-call-unique-global',
      {
        'backend/src/auth.ts': [
          'export async function createUser(client: { user: { create(input: unknown): Promise<unknown> } }) {',
          "  return client.user.create({ email: 'test@example.com' });",
          '}',
          '',
        ].join('\n'),
        'frontend/src/wizard.ts': ['export function create(path: string) {', '  return { path };', '}', ''].join('\n'),
      },
      (sqliteDb) => {
        sqliteDb.exec(`
          INSERT INTO documents (id, language, relative_path) VALUES
            (1, 'typescript', 'backend/src/auth.ts'),
            (2, 'typescript', 'frontend/src/wizard.ts');

          INSERT INTO global_symbols (id, symbol, display_name, kind, documentation) VALUES
            (1, 'scip-typescript npm fixture 1.0.0 backend/src/\`auth.ts\`/createUser().', 'createUser', 12, 'function createUser|function createUser(): Promise<unknown>'),
            (2, 'scip-typescript npm fixture 1.0.0 frontend/src/\`wizard.ts\`/create().', 'create', 12, 'function create|function create(path: string): { path: string }');

          INSERT INTO defn_enclosing_ranges (id, document_id, symbol_id, start_line, start_char, end_line, end_char) VALUES
            (1, 1, 1, 0, 0, 2, 1),
            (2, 2, 2, 0, 0, 2, 1);

          INSERT INTO chunks (id, document_id, chunk_index, start_line, end_line, occurrences) VALUES
            (1, 1, 0, 0, 2, X'00'),
            (2, 2, 0, 0, 2, X'00');

          INSERT INTO mentions (chunk_id, symbol_id, role) VALUES
            (1, 1, 1),
            (2, 2, 1);
        `);
      },
      (db) => {
        const result = dataflow(db, 'createUser');
        expect(result?.producers.map((row) => row.shortName)).not.toContain('src:wizard:create()');
      },
    );
  });
});
