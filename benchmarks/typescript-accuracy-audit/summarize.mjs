import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ts } from '@ts-morph/common';
import process from 'node:process';
import console from 'node:console';

const input = resolve(process.argv[2] ?? '/tmp/scip-query-ts-discovery');
const destination = resolve(process.argv[3] ?? join(input, 'report.json'));
const read = (name) => JSON.parse(readFileSync(join(input, name), 'utf8'));
const rows = read('results.json');
const observations = read('summary.json');
const compact = (row) => ({
  id: row.id,
  area: row.area,
  runtimeMatches: row.runtimeMatches,
  compilerReferenceMatches: row.compilerChecks.every((check) => check.matched),
  selectedTargetDiffersFromExecution: row.contradictions.length > 0,
  unresolvedSites: row.unresolved,
});
const signature = (row) => ({
  runtime: row.actualRuntime,
  invocations: row.invocationCount,
  wholeFileInvocations: row.wholeFileInvocations,
  targets: row.targets.length,
  compilerMismatches: row.compilerChecks.filter((check) => !check.matched).length,
  unresolved: row.unresolved,
  targetDisagreements: row.contradictions.length,
});
const invariants = rows
  .filter((row) => row.area === 'invariants')
  .map((row) => {
    const base = rows.find((candidate) => row.id.startsWith(`invariant-${candidate.id}-`));
    if (!base) throw new Error(`Missing invariant baseline for ${row.id}`);
    return { id: row.id, baseline: base.id, matches: isDeepStrictEqual(signature(row), signature(base)) };
  });
const flow = rows
  .filter((row) => row.flow)
  .map((row) => {
    const expected = row.flow.expected.expected;
    const actual = row.flow.transfers.map((edge) => [edge.attributes.callerPosition, edge.attributes.calleePosition]);
    return {
      id: row.id,
      requiredByAudit: row.flow.expected.required,
      expected,
      actual,
      missing: expected.filter((pair) => !actual.some((other) => isDeepStrictEqual(pair, other))),
      extra: actual.filter((pair) => !expected.some((other) => isDeepStrictEqual(pair, other))),
    };
  });
const projections = read('public-projections.json').map((row) => ({
  id: row.id,
  symmetry: row.symmetry,
  foldAccounting: row.foldAccounting,
  boundedEdges: row.boundedEdges,
  foldedEdges: row.foldedEdges,
}));
const report = {
  date: new Date().toISOString().slice(0, 10),
  compiler: ts.version,
  node: process.version,
  interpretation:
    'Discovery observations, not an overall accuracy score. Runtime/declaration disagreements are not automatically compiler-reference bugs. A passing recorder does not mean its recorded probes passed.',
  counts: {
    cases: observations.cases,
    valid: observations.valid,
    invalid: observations.invalid,
    runtimeExpectationFailures: observations.runtimeExpectationFailures.length,
    markerInvocationCountMismatches: observations.invocationMismatches.length,
    wholeFileInvocationCountMismatches: rows.filter(
      (row) => row.wholeFileInvocations !== row.wholeFileSourceInvocations,
    ).length,
    compilerDeclarationChecks: rows.reduce((sum, row) => sum + row.compilerChecks.length, 0),
    compilerToCatalogMismatchCases: observations.declarationMismatches.length,
    runtimeDeclarationDisagreementCases: observations.contradictedTargets.length,
    staticValueDisagreementCases: observations.contradictedValues.length,
  },
  areas: Object.fromEntries(
    [...new Set(rows.map((row) => row.area))].map((area) => [area, rows.filter((row) => row.area === area).length]),
  ),
  observations,
  flow,
  invariants,
  histories: read('histories.json').map(({ name, actualIncremental, compilerParity, graphParity, error }) => ({
    name,
    actualIncremental,
    compilerParity,
    graphParity,
    error,
  })),
  dependencies: read('dependencies.json'),
  projections,
  transport: read('transport.json'),
  runtimeConsumers: read('runtime-consumers.json').map((row) => ({
    id: row.id,
    expectedPath: row.expectedPath,
    executedPath: row.executedPath,
    derivedPaths: row.observations.map(
      (observation) => observation.keyParts.find((part) => part.name === 'path')?.value,
    ),
  })),
  diagnosis: read('diagnosis.json'),
  cases: rows.map(compact),
};
writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ destination, counts: report.counts, areas: report.areas }, null, 2));
