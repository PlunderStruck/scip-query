/** Executable audit witnesses. Run with vite-node; findings are saved, not silently blessed by tests. */
import { SymbolInformation_Kind } from '@c4312/scip';
import assert from 'node:assert/strict';
import { ts } from '@ts-morph/common';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../../tests/fixtures/evidence-fixture.js';
import { dependenceSlice } from '../../../src/queries/graph/dependence-slice.js';
import { analyzeSourceFunctions, sourceHash } from '../../../src/source/ast/function-metrics.js';
import { functionCoverage } from '../../../src/source/maintenance-coverage.js';
import { files } from '../../../src/queries/navigation/files.js';
import { codeBatch } from '../../../src/queries/navigation/code.js';
import { complexity } from '../../../src/queries/quality/complexity.js';
import { buildAutomatedSuppressionDecision, writeSuppressionFile } from '../../../src/runtime/suppression-writer.js';
import { readSuppressionDir } from '../../../src/storage/suppression-store.js';

const results: Record<string, unknown> = {};
const checks: Array<{ name: string; passed: boolean; error?: string }> = [];
function check(name: string, assertion: () => void) {
  try {
    assertion();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, error: String(error) });
  }
}
function fixture(
  source: string,
  run: (db: ScipDatabase, root: string) => void,
  options: { file?: string; symbolName?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'scip-audit-library-'));
  const dbPath = join(root, 'index.db');
  const file = options.file ?? 'src/calculate.ts';
  const name = options.symbolName ?? 'calculate';
  writeFixtureFiles(root, { [file]: source });
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', file)
    .symbol(1, `scip-typescript npm fixture 1.0.0 ${file}/${name}().`, name, SymbolInformation_Kind.Function)
    .definition(1, 1, 1, 0, 0, source.split('\n').length - 1, 1)
    .chunk(1, 1, 0, source.split('\n').length)
    .mention(1, 1, 1)
    .write();
  const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
  try {
    run(db, root);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const slices = {
  straight: [
    'export function calculate(input: number, fallback: number) {',
    '  let value = fallback;',
    '  value = input + 1;',
    '  return value;',
    '}',
  ],
  shortCircuit: [
    'export function calculate(input: number, fallback: number) {',
    '  let value = fallback;',
    '  input && (value = input);',
    '  return value;',
    '}',
  ],
  ternaryWrite: [
    'export function calculate(input: number, fallback: number) {',
    '  let value = fallback;',
    '  input ? (value = input) : 0;',
    '  return value;',
    '}',
  ],
  alias: [
    'export function calculate(input: number, state: {value: number}) {',
    '  const alias = state;',
    '  alias.value = input;',
    '  return state.value;',
    '}',
  ],
  nestedIncrement: [
    'export function calculate(input: number) {',
    '  let value = input;',
    '  const previous = value++;',
    '  return value;',
    '}',
  ],
};
for (const [name, lines] of Object.entries(slices)) {
  fixture(lines.join('\n'), (db) => {
    const slice = dependenceSlice(db, 'src/calculate.ts:4', { variable: name === 'alias' ? 'state.value' : 'value' });
    results['slice-' + name] = {
      source: lines,
      coverage: slice.coverage,
      resolution: slice.resolution,
      points: slice.points.map(({ name, line, kind }) => ({ name, line, kind })),
      edges: slice.edges,
    };
    if (name === 'shortCircuit' || name === 'ternaryWrite')
      check(name + ': complete slice retains conditional fallback', () =>
        assert(slice.coverage.status !== 'complete' || slice.points.some((point) => point.name === 'fallback')),
      );
    if (name === 'alias')
      check('alias: complete slice retains input written through alias', () =>
        assert(slice.coverage.status !== 'complete' || slice.points.some((point) => point.name === 'input')),
      );
    if (name === 'nestedIncrement')
      check('nested increment: complete slice retains mutation', () =>
        assert(
          slice.coverage.status !== 'complete' ||
            slice.points.some((point) => point.line === 2 && point.kind === 'definition'),
        ),
      );
    if (name === 'straight') {
      const bounded = dependenceSlice(db, 'src/calculate.ts:4', { variable: 'value', maxEdges: 0 });
      results['slice-bounded'] = bounded.coverage;
      check('bounded slice discloses omissions', () =>
        assert(bounded.coverage.status === 'bounded' && bounded.coverage.omittedEdges > 0),
      );
      try {
        dependenceSlice(db, 'src/calculate.ts:4', { column: -1 });
        results['slice-invalid-column'] = 'accepted';
      } catch (error) {
        results['slice-invalid-column'] = String(error);
      }
    }
  });
  const compiled = ts.transpileModule(lines.join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  new Function('exports', compiled)(exports);
  const runtime = name === 'alias' ? exports.calculate!(7, { value: 1 }) : exports.calculate!(0, 7);
  results['runtime-' + name] = runtime;
  const expected = name === 'alias' || name === 'shortCircuit' || name === 'ternaryWrite' ? 7 : 1;
  check(name + ': executed behavior oracle', () => assert.equal(runtime, expected));
}

fixture('export function calculate(x: number) { return x; }', (db, root) => {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'src/calculate.ts'], { cwd: root });
  rmSync(join(root, 'src/calculate.ts'));
  const rows = files(db, 'src/calculate.ts');
  results['deleted-file-locator'] = rows;
  check('files excludes tracked deletion', () => assert.equal(rows.length, 0));
});
fixture(
  'export function helpAfter() { return 1; }',
  (db) => {
    const result = codeBatch(db, ['src/runtime/command-kit/help.ts']);
    results['partially-matching-missing-file-code'] = result;
    check('missing file cannot become an unrelated symbol', () => assert.equal(result.matched, 0));
  },
  { file: 'src/runtime/command-kit/command-descriptor-types.ts', symbolName: 'helpAfter' },
);
fixture('export function calculate(x: number) { return x; }', (db) => {
  results['missing-file-code'] = codeBatch(db, ['src/not-present/calculate.ts']);
});

for (const [name, source] of Object.entries({
  nested: 'export function calculate(x: number) {\n function inner() { if (x) return 1; return 0; }\n return inner;\n}',
  nullish: 'export function calculate(x?: number) { return x ?? 0; }',
  branch: 'export function calculate(x: number) {\n if (x > 0) return 1;\n else if (x < 0) return -1;\n return 0;\n}',
})) {
  fixture(source, (db) => {
    results['complexity-' + name] = {
      source,
      sourceMetrics: analyzeSourceFunctions('src/calculate.ts', source).functions.map(
        ({ name, cyclomatic, cognitive }) => ({ name, cyclomatic, cognitive }),
      ),
      indexedMetric: complexity(db, 'calculate', { semantic: false }),
    };
    check(name + ': source and indexed cyclomatic measurements agree', () =>
      assert.equal(
        complexity(db, 'calculate', { semantic: false })!.cyclomaticEstimate,
        analyzeSourceFunctions('src/calculate.ts', source).functions[0]!.cyclomatic,
      ),
    );
  });
}

const source = 'function f(x: boolean) {\n  if (x) return 1;\n  return 0;\n}';
const functions = analyzeSourceFunctions('coverage.ts', source).functions;
const span = (line: number) => ({ start: { line, column: 2 }, end: { line, column: 10 } });
for (const [name, counts] of Object.entries({
  full: { 0: 1, 1: 1 },
  half: { 0: 1, 1: 0 },
  none: { 0: 0, 1: 0 },
  malformed: { 0: -1, 1: 1 },
})) {
  results['coverage-' + name] = functionCoverage(functions[0]!, functions, source, {
    files: {
      'coverage.ts': {
        sourceHash: sourceHash(source),
        coverage: { statementMap: { 0: span(2), 1: span(3) }, s: counts },
      },
    },
  });
}
results['coverage-stale'] = functionCoverage(functions[0]!, functions, source, {
  files: {
    'coverage.ts': { sourceHash: 'stale', coverage: { statementMap: { 0: span(2) }, s: { 0: 1 } } },
  },
});

const output = process.argv[2] ?? '/tmp/scip-full-audit-library.json';
fixture('export function calculate(input: number) {\n  const value = input + ;\n  return value;\n}', (db) => {
  const result = dependenceSlice(db, 'src/calculate.ts:3', { variable: 'value' });
  results['slice-malformed-source'] = result;
  check('malformed source cannot produce complete dependence coverage', () =>
    assert.notEqual(result.coverage.status, 'complete'),
  );
});
fixture('export function calculate(x: number) { return x; }', (_db, root) => {
  const reason = 'Disposable audit fixture, deliberately checking suppression persistence.';
  const decision = buildAutomatedSuppressionDecision(root, 'test-fixture', ['source:src/calculate.ts'], reason);
  const stored = writeSuppressionFile(root, { id: 'complexity:src/calculate.ts:calculate', reason, decision });
  const loaded = readSuppressionDir(root);
  results['suppression-roundtrip'] = { stored, loaded };
  check('source finding suppression survives write/read round trip', () => assert.equal(loaded.suppressions.length, 1));
  const escaped = writeSuppressionFile(root, { id: '../../escaped-audit', reason, decision });
  const relativePath = relative(join(root, '.scipquery/suppressions'), escaped.path);
  results['suppression-path-confinement'] = { escaped, relativePath };
  check('suppression ID cannot escape its storage directory', () => assert(!relativePath.startsWith('..')));
});
results.checks = checks;
writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
console.log(
  `Saved ${Object.keys(results).length} library probes to ${output}; ${checks.filter((check) => !check.passed).length}/${checks.length} assertions fail.`,
);
if (checks.some((check) => !check.passed)) process.exitCode = 1;
