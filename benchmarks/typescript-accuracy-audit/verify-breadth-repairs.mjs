import assert from 'node:assert/strict';
import console from 'node:console';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(process.argv[2]);
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const rows = read('isolated/results.json');
const summary = read('isolated/summary.json');
const http = read('isolated/breadth-public.json');
const slices = read('isolated/breadth-slices.json');
const calls = read('isolated/breadth-call-consumers.json');
const diagnosis = read('isolated/call-graph-diagnosis.json');
assert.equal(rows.length, 109);
assert.equal(summary.invalid, 0);
assert.deepEqual(summary.runtimeExpectationFailures, []);
const wrongValues = rows.filter(
  (row) => row.evaluated?.precision === 'literal' && row.evaluated.value !== row.actualRuntime.value,
);
assert.deepEqual(wrongValues, []);
for (const id of ['breadth-positive-literal', 'breadth-positive-helper', 'breadth-positive-property'])
  assert.deepEqual(
    [rows.find((row) => row.id === id)?.evaluated?.precision, rows.find((row) => row.id === id)?.evaluated?.value],
    ['literal', '/right'],
    id,
  );
assert.equal(http.rows.length, 51);
const wrongHttp = http.rows.flatMap((row) =>
  row.observations
    .filter((observation) => {
      const path = observation.keyParts.find((part) => part.name === 'path');
      return (
        (observation.valuePrecision === 'literal' || path?.precision === 'literal' || path?.term?.kind === 'literal') &&
        !row.executed.paths.includes(path?.value)
      );
    })
    .map((observation) => ({ id: row.id, observation })),
);
assert.deepEqual(wrongHttp, []);
assert.equal(http.projections.length, 5);
assert.equal(slices.rows.length, 34);
assert.equal(slices.projections.length, 5);
const falseComplete = slices.rows.filter(
  (row) => row.result.coverage.status === 'complete' && row.missingInfluence.length,
);
assert.deepEqual(falseComplete, []);
for (const row of slices.projections) {
  const recorded = slices.rows.find((candidate) => candidate.id === row.id);
  assert.deepEqual(row.result.coverage, recorded.result.coverage, `CLI/model slice coverage: ${row.id}`);
}
for (const id of ['straight', 'overwrite', 'conditional'])
  assert.equal(slices.rows.find((row) => row.id === id)?.result.coverage.status, 'complete', id);
assert.equal(calls.rows.length, 35);
assert(
  diagnosis.references.some((row) => !(row.symbolRoles & 1)),
  'Raw compiler constructor invocation',
);
assert(
  diagnosis.filtered.some((row) => row.symbol.endsWith('/Store#') && row.source === 'scip-declaration'),
  'Retain qualified constructor candidate',
);
const graph = read('commands/call-graph.json').result.callGraph;
assert.deepEqual(graph.calleeEvidence.map((row) => [row.shortName, row.evidenceStrength]).sort(), [
  ['src:core:math:sum()', 'exact'],
  ['src:core:store:Store', 'candidate'],
  ['src:core:store:Store:write()', 'exact'],
]);
const complexity = read('commands/complexity.json').result.complexity;
assert.deepEqual([complexity.calleeCount, complexity.candidateCalleeCount], [2, 1]);
// Preserve historical assertions and results; only their old constructor-strength expectations are superseded here.
const historical = read('commands/claims.json');
assert.equal(historical.total, 42);
assert.deepEqual(
  historical.checks.filter((row) => !row.passed && !['call-graph', 'complexity'].includes(row.command)),
  [],
);
const runs = read('commands/runs.json');
assert.equal(runs.length, 71);
assert(runs.every((row) => row.passed));
const controls = {};
for (const [name, count] of [
  ['controls', 48],
  ['transport', 58],
  ['architecture', 8],
  ['frontend', 34],
]) {
  const checks = read(`${name}/results.json`);
  assert.equal(checks.length, count, name);
  assert.deepEqual(
    checks.filter((row) => !row.passed),
    [],
    name,
  );
  controls[name] = count;
}
const integrity = readFileSync(join(root, 'frontend/integrity.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
assert(integrity.length > 0);
assert(integrity.every((row) => JSON.stringify(row.integrity) === '[["ok"]]'));
const report = {
  passed: true,
  counts: {
    programs: rows.length,
    wrongLiteralValues: wrongValues.length,
    httpExecutions: http.rows.length,
    wrongLiteralHttpPaths: wrongHttp.length,
    slicePrograms: slices.rows.length,
    sliceExecutions: slices.rows.length * 3,
    falselyCompleteSlices: falseComplete.length,
    runtimeCliProjections: http.projections.length,
    sliceCliProjections: slices.projections.length,
    callGraphConsumers: calls.rows.length,
    generalCommands: runs.length,
    commandFacts: historical.total,
    ...controls,
    integrityChecks: integrity.length,
  },
  limits: [
    'Bounded executable witnesses, not exhaustive TypeScript semantics.',
    'Unsupported effects remain explicit uncertainty; this does not implement general interprocedural slicing.',
    'Volar provider installation and agent benchmarks were not performed.',
  ],
};
writeFileSync(join(root, 'verified.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
