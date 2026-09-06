import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SymbolInformation_Kind } from '@c4312/scip';
import { ScipDatabase } from '../../src/storage/db.js';
import { buildCalleeMap } from '../../src/symbols/graph/call-graph-evidence.js';
import { findFirstSymbolMatch } from '../../src/symbols/symbol-lookup.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

const sym = (file: string, descriptor: string) => `scip-typescript npm test 1.0.0 src/\`${file}\`/${descriptor}`;
const EXECUTE = sym('service.ts', 'Service#execute().');
const RUN = sym('controller.ts', 'Controller#run().');
const DECOY_EXECUTE = sym('other.ts', 'execute().');
const STAMP = sym('tools.ts', 'stamp().');
const REPO_STRINGIFY = sym('json.ts', 'stringify().');
const LIBRARY_STRINGIFY = 'scip-typescript npm typescript 5.4.5 lib/`lib.es5.d.ts`/JSON#stringify().';

/**
 * Two files the leaf-name fallback cannot resolve correctly on its own: a
 * member call through an injected receiver (`this.service.execute()`, which
 * has a same-named decoy elsewhere) and a bare call the compiler bound to a
 * library symbol that shares its name with a repository function.
 */
function buildFixture(withOccurrences: boolean): { root: string; db: ScipDatabase } {
  const root = mkdtempSync(join(tmpdir(), 'scip-occurrence-callees-'));
  writeFixtureFiles(root, {
    'src/service.ts': ['export class Service {', '  execute() {', '    return 1;', '  }', '}'],
    'src/controller.ts': [
      "import { Service } from './service';",
      'export class Controller {',
      '  constructor(private readonly service: Service) {}',
      '  run() {',
      '    return this.service.execute();',
      '  }',
      '}',
    ],
    'src/other.ts': ['export function execute() {', '  return 2;', '}'],
    'src/tools.ts': ['export function stamp(input: unknown) {', '  return stringify(input);', '}'],
    'src/json.ts': ['export function stringify(value: unknown) {', '  return String(value);', '}'],
  });
  const dbPath = join(root, 'index.db');
  const fixture = evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/service.ts')
    .document(2, 'typescript', 'src/controller.ts')
    .document(3, 'typescript', 'src/other.ts')
    .document(4, 'typescript', 'src/tools.ts')
    .document(5, 'typescript', 'src/json.ts')
    .symbol(1, EXECUTE, 'execute', SymbolInformation_Kind.Method)
    .symbol(2, RUN, 'run', SymbolInformation_Kind.Method)
    .symbol(3, DECOY_EXECUTE, 'execute', SymbolInformation_Kind.Function)
    .symbol(4, STAMP, 'stamp', SymbolInformation_Kind.Function)
    .symbol(5, REPO_STRINGIFY, 'stringify', SymbolInformation_Kind.Function)
    .definition(1, 1, 1, 1, 2, 3, 3)
    .definition(2, 2, 2, 3, 2, 5, 3)
    .definition(3, 3, 3, 0, 0, 2, 1)
    .definition(4, 4, 4, 0, 0, 2, 1)
    .definition(5, 5, 5, 0, 0, 2, 1)
    .chunk(1, 1, 0, 5)
    .chunk(2, 2, 0, 7)
    .chunk(3, 3, 0, 3)
    .chunk(4, 4, 0, 3)
    .chunk(5, 5, 0, 3);
  if (withOccurrences) fixture.occurrence(2, EXECUTE, 4, 0, 24, 31).occurrence(4, LIBRARY_STRINGIFY, 1, 0, 9, 18);
  fixture.write();
  return { root, db: new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') }) };
}

describe('occurrence-resolved callee tier', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('uses the indexer binding at the call line and refuses guesses the compiler bound externally', () => {
    const { root, db } = buildFixture(true);
    tempDirs.push(root);
    try {
      const run = findFirstSymbolMatch(db, RUN)!;
      const stamp = findFirstSymbolMatch(db, STAMP)!;
      const callees = buildCalleeMap(db, [run, stamp], { semantic: false });
      expect(callees.get(run.symbolId)).toEqual([
        { symbol: EXECUTE, file: 'src/service.ts', chunkId: 4, source: 'scip-occurrence', callsiteLine: 4 },
      ]);
      expect(callees.get(stamp.symbolId)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('falls back to leaf-name resolution when the index carries no occurrence data', () => {
    const { root, db } = buildFixture(false);
    tempDirs.push(root);
    try {
      const run = findFirstSymbolMatch(db, RUN)!;
      const stamp = findFirstSymbolMatch(db, STAMP)!;
      const callees = buildCalleeMap(db, [run, stamp], { semantic: false });
      expect(callees.get(run.symbolId)).toEqual([]);
      expect(callees.get(stamp.symbolId)).toEqual([
        { symbol: REPO_STRINGIFY, file: 'src/json.ts', chunkId: 1, source: 'ast-callsite', callsiteLine: 1 },
      ]);
    } finally {
      db.close();
    }
  });
});
