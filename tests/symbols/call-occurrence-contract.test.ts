import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';
import { scipOccurrenceCallTargetsForRange } from '../../src/symbols/graph/scip-occurrence-call-targets.js';
import { buildAstCalleeMap } from '../../src/symbols/graph/call-graph-evidence.js';
import { getDefinitionsForFile } from '../../src/symbols/definition-catalog.js';
import { callGraph } from '../../src/queries/navigation/call-graph.js';

const prefix = 'scip-typescript npm fixture 1.0.0 ';
const rootSymbol = prefix + 'src/`main.ts`/start().';
const runA = prefix + 'src/`a.ts`/A#run().';
const runB = prefix + 'src/`b.ts`/B#run().';
function fixture(
  source: string,
  occurrences: Array<[string, number, number]>,
  run: (db: ScipDatabase) => void,
  encoding = 'UTF-16',
) {
  const root = mkdtempSync(join(tmpdir(), 'scip-call-occurrence-'));
  const path = join(root, 'index.db');
  try {
    writeFixtureFiles(root, {
      'src/main.ts': source,
      'src/a.ts': 'export class A { run() { return 1; } }',
      'src/b.ts': 'export class B { run() { return 2; } }',
    });
    const builder = evidenceFixtureDb(path)
      .document(1, 'typescript', 'src/main.ts')
      .document(2, 'typescript', 'src/a.ts')
      .document(3, 'typescript', 'src/b.ts')
      .symbol(1, rootSymbol, 'start', 17)
      .definition(1, 1, 1, 0, 0, 0, source.length)
      .symbol(2, runA, 'run', 26)
      .definition(2, 2, 2, 0, 17, 0, 34)
      .symbol(3, runB, 'run', 26)
      .definition(3, 3, 3, 0, 17, 0, 34)
      .chunk(1, 1, 0, 0)
      .mention(1, 1, 1)
      .chunk(2, 2, 0, 0)
      .mention(2, 2, 1)
      .chunk(3, 3, 0, 0)
      .mention(3, 3, 1);
    const column = (offset: number) =>
      encoding === 'UTF-8'
        ? Buffer.byteLength(source.slice(0, offset), 'utf8')
        : encoding === 'UTF-32'
          ? [...source.slice(0, offset)].length
          : offset;
    for (const [symbol, start, end] of occurrences) builder.occurrence(1, symbol, 0, 0, column(start), column(end));
    builder.write();
    const sql = new Database(path);
    sql.prepare('UPDATE documents SET position_encoding=?').run(encoding);
    sql.close();
    const db = new ScipDatabase({ projectRoot: root, dbPath: path, indexPath: join(root, 'index.scip') });
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('call occurrence identity', () => {
  it('does not mistake a same-line argument reference for the invoked parameter', () => {
    const source = 'export function start(run: (x: unknown) => void, a: A) { run(a.run); }';
    const local = source.indexOf('run(a');
    const argument = source.indexOf('a.run') + 2;
    fixture(
      source,
      [
        ['local 0', local, local + 3],
        [runA, argument, argument + 3],
      ],
      (db) => {
        const defs = getDefinitionsForFile(db, 'src/main.ts');
        expect(buildAstCalleeMap(db, defs).get(defs[0]!.symbolId)).toEqual([]);
        expect(scipOccurrenceCallTargetsForRange(db, 'src/main.ts', 0, 0)).toMatchObject({
          targets: [],
          resolvedCallsites: 0,
          unresolvedCallsites: 1,
        });
      },
    );
  });

  it.each(['UTF-8', 'UTF-16', 'UTF-32'])(
    'uses exact target columns for two same-name calls with unicode in %s',
    (encoding) => {
      const prefixText = 'const marker = "😀"; ';
      const source = `export function start(a: A, b: B) { ${prefixText}a.run(); b.run(); }`;
      const a = source.indexOf('a.run') + 2;
      const b = source.indexOf('b.run') + 2;
      fixture(
        source,
        [
          [runA, a, a + 3],
          [runB, b, b + 3],
        ],
        (db) => {
          const defs = getDefinitionsForFile(db, 'src/main.ts');
          expect(
            buildAstCalleeMap(db, defs)
              .get(defs[0]!.symbolId)
              ?.map((row) => [row.symbol, row.source]),
          ).toEqual([
            [runA, 'scip-occurrence'],
            [runB, 'scip-occurrence'],
          ]);
          expect(
            scipOccurrenceCallTargetsForRange(db, 'src/main.ts', 0, 0).targets.map(
              (target) => target.definition.symbol,
            ),
          ).toEqual([runA, runB]);
        },
        encoding,
      );
    },
  );

  it('retains a direct recursive call as an exact self edge', () => {
    const source = 'export function start() { start(); }';
    const column = source.lastIndexOf('start');
    fixture(source, [[rootSymbol, column, column + 5]], (db) => {
      expect(callGraph(db, rootSymbol, { semantic: false })?.calleeEvidence).toEqual(
        expect.arrayContaining([expect.objectContaining({ symbol: rootSymbol, evidenceStrength: 'exact' })]),
      );
    });
  });

  it('does not label a name-inferred target as an exact compiler binding', () => {
    const source = "import { run } from './a'; export function start() { run(); }";
    fixture(source, [], (db) => {
      const graph = callGraph(db, rootSymbol, { semantic: false });
      expect(graph?.calleeEvidence?.some((row) => row.evidenceSource === 'ast-callsite')).toBe(true);
      expect(
        graph?.calleeEvidence?.every(
          (row) => row.evidenceSource !== 'ast-callsite' || row.evidenceStrength === 'candidate',
        ),
      ).toBe(true);
    });
  });
});
