import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { deserializeSCIP } from '@c4312/scip';
import process from 'node:process';
import console from 'node:console';
import { createHash } from 'node:crypto';

const [mainArg, supplementalArg, destinationArg, baselineArg] = process.argv.slice(2);
if (!mainArg || !supplementalArg || !destinationArg) {
  throw new Error('Usage: node summarize-exact.mjs <main-output> <supplemental-output> <report.json>');
}
const main = resolve(mainArg);
const supplemental = resolve(supplementalArg);
const read = (directory, name) => JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
const rows = read(main, 'results');
const summary = read(main, 'summary');
const newRows = rows.filter((row) => row.id.startsWith('exact-'));
const histories = read(supplemental, 'histories');
const publicResults = read(supplemental, 'exact-public');
let productionBaseline = null;
if (baselineArg) {
  const hashes = JSON.parse(readFileSync(baselineArg, 'utf8'));
  for (const [file, hash] of Object.entries(hashes))
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== hash)
      throw new Error(`Production changed during discovery: ${file}`);
  productionBaseline = { filesVerifiedUnchanged: Object.keys(hashes).length, hashes };
}
if (summary.invalid || rows.some((row) => !row.runtimeMatches))
  throw new Error('Invalid fixtures or execution expectations');

const pointBeforeOrEqual = (aLine, aColumn, bLine, bColumn) => aLine < bLine || (aLine === bLine && aColumn <= bColumn);
const bodyChecks = [];
for (const row of newRows) {
  if (!row.tracedRuntime) continue;
  if (!isDeepStrictEqual(row.actualRuntime, row.tracedRuntime.result))
    throw new Error(`Instrumentation changed ${row.id}`);
  const observed = row.tracedRuntime.trace.at(-1);
  if (!observed) throw new Error(`No body trace for ${row.id}`);
  for (const target of row.targets) {
    const location = target.location;
    const preciseRange =
      location &&
      typeof location.startColumn === 'number' &&
      typeof location.endColumn === 'number' &&
      !(location.startLine === location.endLine && location.startColumn === location.endColumn);
    const containsObservedBody =
      preciseRange &&
      location.file === observed.file &&
      pointBeforeOrEqual(location.startLine, location.startColumn, observed.startLine, observed.startColumn) &&
      pointBeforeOrEqual(observed.endLine, observed.endColumn, location.endLine, location.endColumn);
    const exactEdges = row.graph.edges.filter(
      (edge) => edge.subtype === 'call' && edge.to.symbol === target.symbol && edge.evidenceStrength === 'exact',
    );
    bodyChecks.push({
      id: row.id,
      target,
      observed,
      preciseRange,
      containsObservedBody,
      implementationEstablished: target.implementationStatus === 'established',
      exactEdges: exactEdges.map((edge) => edge.id),
    });
  }
}
const wrongBodies = bodyChecks.filter(
  (row) => row.implementationEstablished && row.preciseRange && !row.containsObservedBody,
);
const insufficientProofs = bodyChecks.filter((row) => row.implementationEstablished && !row.preciseRange);
const wrongValues = newRows.filter(
  (row) => row.evaluated?.precision === 'literal' && !isDeepStrictEqual(row.evaluated.value, row.actualRuntime.value),
);
const finding = (id, title, selected) => ({ id, title, cases: [...new Set(selected.map((row) => row.id))] });
const findings = [
  finding(
    'TS-X01',
    'Cross-file writers leave stale literal values',
    wrongValues.filter((row) => row.area.startsWith('cross-file')),
  ),
  finding(
    'TS-X02',
    'Normal-completion checks miss binding, iteration, coercion and reference errors',
    wrongValues.filter((row) => row.actualRuntime.throws),
  ),
  finding(
    'TS-X03',
    'Reflect.set ignores a distinct receiver argument',
    wrongValues.filter((row) => row.id.includes('reflect-receiver')),
  ),
  finding(
    'TS-X04',
    'Direct eval can invalidate established values and callable targets',
    [...wrongValues, ...wrongBodies].filter((row) => row.id.includes('eval')),
  ),
  finding(
    'TS-X05',
    'Class decorators can replace an established constructor target',
    wrongBodies.filter((row) => row.id.includes('decorated-constructor')),
  ),
  finding('TS-X06', 'Same-line aliases receive implementation proof without a precise body range', insufficientProofs),
];
const classified = new Set(findings.flatMap((item) => item.cases));
const unclassified = [...wrongValues, ...wrongBodies, ...insufficientProofs]
  .filter((row) => !classified.has(row.id))
  .map((row) => row.id);

const flow = newRows
  .filter((row) => row.flow)
  .map((row) => {
    const expected = row.flow.expected.expected;
    const actual = row.flow.transfers.map((edge) => [edge.attributes.callerPosition, edge.attributes.calleePosition]);
    const contains = (pairs, pair) => pairs.some((candidate) => isDeepStrictEqual(candidate, pair));
    return {
      id: row.id,
      expected,
      actual,
      falsePairs: actual.filter((pair) => !contains(expected, pair)),
      missingPairs: expected.filter((pair) => !contains(actual, pair)),
    };
  });
const compilerChecks = newRows.flatMap((row) => row.compilerChecks.map((check) => ({ id: row.id, ...check })));
const producer = deserializeSCIP(readFileSync(join(main, 'index.scip')))
  .documents.filter((document) =>
    [
      'exact-call-alias-same-line.ts',
      'exact-call-alias-multiple-lines.ts',
      'exact-value-closure-parameter.ts',
      'exact-value-closure-mutation.ts',
    ].includes(document.relativePath),
  )
  .map((document) => ({
    file: document.relativePath,
    occurrences: document.occurrences.map(({ symbol, range, symbolRoles, enclosingRange }) => ({
      symbol,
      range,
      symbolRoles,
      enclosingRange,
    })),
  }));

const report = {
  date: '2026-09-09',
  productionBaseline,
  interpretation:
    'Discovery only. Passing recorders establish completed measurements, not tool correctness. No production fixes in this audit.',
  counts: {
    totalPrograms: rows.length,
    newPrograms: newRows.length,
    priorPrograms: rows.length - newRows.length,
    invalidPrograms: summary.invalid,
    executionExpectationFailures: summary.runtimeExpectationFailures.length,
    wrongNewLiteralValues: wrongValues.length,
    wrongEstablishedBodies: wrongBodies.length,
    establishedWithoutPreciseBodyRange: insufficientProofs.length,
    tracedPrograms: newRows.filter((row) => row.tracedRuntime).length,
    compilerChecks: compilerChecks.length,
    missingCompilerTargets: compilerChecks.filter((check) => !check.actual.length).length,
    impreciseDeclarationRanges: compilerChecks.filter((check) => check.actual.length && !check.rangeMatched).length,
    falseParameterPairs: flow.flatMap((row) => row.falsePairs).length,
    histories: histories.length,
    actualIncrementalUpdates: histories.filter((row) => row.actualIncremental).length,
    compilerHistoryMismatches: histories.filter((row) => row.compilerParity !== true).length,
    normalizedGraphHistoryMismatches: histories.filter((row) => !row.normalizedGraphParity).length,
  },
  findings,
  unclassified,
  bodyChecks,
  flow,
  compilerChecks,
  producer,
  publicResults,
  histories: histories.map(
    ({ name, actualIncremental, compilerParity, graphParity, normalizedGraphParity, incremental, full }) => ({
      name,
      actualIncremental,
      compilerParity,
      rawGraphParity: graphParity,
      normalizedGraphParity,
      incrementalValue: incremental?.value,
      fullValue: full?.value,
    }),
  ),
  normalization:
    'History comparison substitutes only the independently created checkout root in serialized output; ten raw differences are checkout paths in coverage diagnostics.',
  mainSummary: summary,
  cases: newRows.map(({ id, area, source, actualRuntime, evaluated, targets, graph }) => ({
    id,
    area,
    source,
    actualRuntime,
    evaluated,
    targets,
    coverage: graph.coverage.status,
  })),
};
writeFileSync(resolve(destinationArg), JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      counts: report.counts,
      findings: findings.map(({ id, title, cases }) => ({ id, title, cases: cases.length })),
      unclassified,
    },
    null,
    2,
  ),
);
