import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const [directoryArg, destinationArg] = process.argv.slice(2);
assert(directoryArg && destinationArg, 'Usage: node verify-exact-repairs.mjs <audit-output> <report.json>');
const directory = resolve(directoryArg);
const destination = resolve(destinationArg);
execFileSync(process.execPath, [
  fileURLToPath(new URL('./summarize-exact.mjs', import.meta.url)),
  directory,
  directory,
  destination,
]);
const report = JSON.parse(readFileSync(destination, 'utf8'));
const rows = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8'));
const summary = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));

assert.equal(report.counts.totalPrograms, 686, 'Run the combined corpus before verifying repairs');
for (const key of [
  'invalidPrograms',
  'executionExpectationFailures',
  'wrongNewLiteralValues',
  'wrongEstablishedBodies',
  'establishedWithoutPreciseBodyRange',
  'falseParameterPairs',
  'compilerHistoryMismatches',
  'normalizedGraphHistoryMismatches',
]) {
  assert.equal(report.counts[key], 0, key);
}
for (const key of ['invocationMismatches', 'contradictedValues', 'requiredUnresolved'])
  assert.deepEqual(summary[key], [], key);
assert.deepEqual(report.unclassified, []);
for (const finding of report.findings) assert.deepEqual(finding.cases, [], finding.id);
for (const row of rows) {
  assert(
    !row.contradictions.some((target) => target.implementationStatus === 'established'),
    `Wrong established target: ${row.id}`,
  );
  if (row.evaluated?.precision === 'literal')
    assert.equal(row.evaluated.value, row.actualRuntime.value, `Wrong literal: ${row.id}`);
}
assert.equal(report.counts.histories, 18);
assert.equal(report.counts.actualIncrementalUpdates, 16);
assert.equal(report.publicResults.http.length, 7);
assert.equal(report.publicResults.projections.length, 8);
assert.equal(Object.keys(report.publicResults.nativeEsm).length, 15);
for (const row of report.publicResults.http) {
  assert.deepEqual(report.publicResults.nativeEsm[row.id], row.executed, `Native ESM HTTP execution: ${row.id}`);
  for (const observation of row.observations) {
    const path = observation.keyParts.find((part) => part.name === 'path');
    if (path?.term?.kind === 'literal')
      assert(row.executed.paths.includes(path.value), `Unobserved exact HTTP path: ${row.id}`);
  }
}
for (const row of report.publicResults.projections) {
  assert(
    !row.graph.edges.some((edge) => edge.subtype === 'call' && edge.evidenceStrength === 'exact'),
    `Unproved public call: ${row.id}`,
  );
  const main = rows.find((candidate) => candidate.id === row.id);
  const { paths, ...native } = report.publicResults.nativeEsm[row.id];
  assert.deepEqual(paths, [], `Call fixture emitted an unexpected HTTP request: ${row.id}`);
  assert(main && isDeepStrictEqual(main.actualRuntime, native), `Native ESM call execution: ${row.id}`);
}
const control = report.publicResults.http.find((row) => row.id === 'exact-value-control');
assert(
  control.observations.some((observation) =>
    observation.keyParts.some(
      (part) => part.name === 'path' && part.term?.kind === 'literal' && part.value === '/right',
    ),
  ),
  'Preserve exact HTTP control',
);
report.interpretation =
  'Repair verification: all six audited failure families are absent in this executed corpus. This is bounded evidence, not a proof of complete TypeScript runtime or compiler-target coverage.';
report.verification = { passed: true, combinedLiteralMismatches: 0, publicChecks: true, nativeEsmChecks: true };
writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, counts: report.counts }, null, 2));
