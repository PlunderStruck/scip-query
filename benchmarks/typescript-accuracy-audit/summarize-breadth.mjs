import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '/tmp/scip-query-breadth-audit');
const destination = resolve(process.argv[3] ?? join(root, 'report.json'));
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const baseline = read(join(root, 'baseline.json'));
const changedSource = Object.entries(baseline.hashes)
  .filter(([path, hash]) => !existsSync(path) || createHash('sha256').update(readFileSync(path)).digest('hex') !== hash)
  .map(([path]) => path);
assert.deepEqual(changedSource, [], 'Frozen production/build changed');
const corpus = read(join(root, 'isolated/results.json'));
const summary = read(join(root, 'isolated/summary.json'));
const publicResults = read(join(root, 'isolated/breadth-public.json'));
const slices = read(join(root, 'isolated/breadth-slices.json'));
const consumers = read(join(root, 'isolated/breadth-call-consumers.json'));
const diagnosis = read(join(root, 'isolated/call-graph-diagnosis.json'));
assert.equal(corpus.length, 109);
assert.equal(summary.invalid, 0);
assert.equal(summary.runtimeExpectationFailures.length, 0);
assert.equal(publicResults.rows.length, 51);
assert.equal(slices.rows.length, 34);
assert.equal(consumers.rows.length, 35);
const wrongLiterals = corpus.filter(
  (r) =>
    r.evaluated?.precision === 'literal' && JSON.stringify(r.evaluated.value) !== JSON.stringify(r.actualRuntime.value),
);
const wrongHttp = publicResults.rows.flatMap((r) =>
  r.observations.flatMap((o) => {
    const path = o.keyParts.find((k) => k.name === 'path');
    return o.valuePrecision === 'literal' && !r.executed.paths.includes(path?.value)
      ? [
          {
            id: r.id,
            expected: r.executed.paths,
            actual: path?.value,
            precision: o.valuePrecision,
            strength: o.strength,
            term: path?.term,
          },
        ]
      : [];
  }),
);
const falseCompleteSlices = slices.rows.filter(
  (r) => r.result.coverage.status === 'complete' && r.missingInfluence.length,
);
const runs = read(join(root, 'commands/runs.json'));
const claims = read(join(root, 'commands/claims.json'));
const controls = read(join(root, 'controls/results.json'));
const transport = read(join(root, 'transport/results.json'));
const architecture = read(join(root, 'architecture/results.json'));
const frontendInitial = read(join(root, 'frontend-initial/results.json'));
const frontendRecovered = read(join(root, 'frontend/results.json'));
const historical = read('benchmarks/command-contracts/2026-09-05/ledger.json');
const names = read(join(root, 'command-names.json'));
const lifecycle = ['', 'reproduction', 'stage-diagnosis'].map((prefix) => {
  const folder = join(root, prefix);
  const frontend = read(join(folder, prefix ? 'frontend/results.json' : 'frontend-initial/results.json'));
  const path = join(folder, 'frontend/integrity.jsonl');
  return {
    prefix: prefix || 'initial',
    failed: frontend.filter((r) => !r.passed),
    integrity: existsSync(path)
      ? readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : null,
  };
});
const frameworkNames = [
  'react-component-duplicates',
  'react-hook-candidates',
  'react-large-component-pressure',
  'vue-component-duplicates',
  'vue-composable-candidates',
  'vue-large-view-pressure',
];
const ledger = names.map((command) => {
  const invocation = runs.find((r) => r.command === command);
  const controlInvocations = controls.filter((r) => r.args?.[0] === command);
  const independentClaims = claims.checks.filter((c) => c.command === command);
  const additional =
    command === 'continue'
      ? ['immutable cursor replay']
      : command === 'hook-architecture-stop'
        ? ['clean and forbidden-edge hook replay']
        : [];
  const observations = [];
  if (command === 'call-graph')
    observations.push('Constructor candidate filtered out; 35 additional consumer comparisons recorded.');
  if (command === 'evidence')
    observations.push('Five runtime projections; false shared-value runtime key is visible on a candidate edge.');
  if (command === 'dependence-slice')
    observations.push('Five additional CLI projections; getter/static-block/eval slices falsely report complete.');
  if (command === 'reindex')
    observations.push('Three fresh lifecycle reproductions published a corrupt database after successful exit.');
  if (command === 'augment-sources' || frameworkNames.includes(command))
    observations.push('Failed after corrupt rebuild; recovered frontend phase passed its checks.');
  if (command === 'augment-vue')
    observations.push('Only missing-provider rejection was replayed; no new positive Volar check.');
  return {
    command,
    invocation: invocation ?? null,
    controlInvocations,
    additional,
    exercised: !!invocation || controlInvocations.length > 0 || additional.length > 0,
    independentFactChecks: independentClaims,
    observations,
    historicalTests: historical.find((r) => r.command === command)?.tests ?? [],
    accuracyStatus: 'Bounded witnesses only; no universal command accuracy verdict.',
  };
});
assert.equal(names.length, 86);
assert.equal(ledger.filter((r) => r.exercised).length, 86);
const control = corpus.find((r) => r.id === 'breadth-positive-literal');
assert.equal(control?.evaluated?.value, '/right');
assert.equal(control?.evaluated?.precision, 'literal');
const straight = slices.rows.find((r) => r.id === 'straight');
assert.deepEqual(straight?.missingInfluence, []);
assert.equal(straight?.result.coverage.status, 'complete');
const counts = {
  commands: 86,
  publicCommands: 81,
  internalCompatibilityControls: 5,
  generalInvocations: runs.length,
  generalExpectedOutcomes: runs.filter((r) => r.passed).length,
  independentCommandFacts: claims.total,
  independentCommandFactsPassed: claims.passed,
  controls: controls.length,
  controlsFailed: controls.filter((r) => !r.passed).length,
  transport: transport.length,
  transportFailed: transport.filter((r) => !r.passed).length,
  architecture: architecture.length,
  architectureFailed: architecture.filter((r) => !r.passed).length,
  frontendRecovered: frontendRecovered.length,
  frontendRecoveredFailed: frontendRecovered.filter((r) => !r.passed).length,
  corruptLifecycleReproductions: lifecycle.filter((r) => r.failed.length).length,
  programs: corpus.length,
  invalidPrograms: summary.invalid,
  runtimeExpectationFailures: summary.runtimeExpectationFailures.length,
  wrongLiteralValues: wrongLiterals.length,
  httpConsumers: publicResults.rows.length,
  wrongLiteralHttpPaths: wrongHttp.length,
  slicePrograms: slices.rows.length,
  sliceExecutions: slices.rows.length * 3,
  falselyCompleteSlices: falseCompleteSlices.length,
  publicRuntimeProjections: publicResults.projections.length,
  publicSliceProjections: slices.projections.length,
  additionalCallGraphConsumers: consumers.rows.length,
  missingProjectedTargetPrograms: summary.declarationMismatches.length,
  impreciseProjectedRangePrograms: summary.declarationRangeMismatches.length,
};
const report = {
  status: 'Discovery complete within recorded scope; five finding groups remain open.',
  source: baseline,
  productionUnchanged: true,
  counts,
  commandLedger: ledger,
  wrongLiterals: wrongLiterals.map((r) => ({
    id: r.id,
    source: r.source,
    expected: r.actualRuntime,
    evaluated: r.evaluated,
  })),
  wrongHttp,
  falseCompleteSlices: falseCompleteSlices.map((r) => ({
    id: r.id,
    body: r.body,
    executions: r.executions,
    influenced: r.influenced,
    missing: r.missingInfluence,
    coverage: r.result.coverage,
    points: r.result.points.map((p) => ({ name: p.name, kind: p.kind })),
  })),
  constructorDiagnosis: diagnosis,
  additionalCallConsumers: consumers.rows.map((r) => ({
    id: r.id,
    sourceTargets: r.sourceTargets,
    calleeEvidence: r.graph.callGraph?.calleeEvidence ?? [],
  })),
  runtimeProjections: publicResults.projections.map((r) => ({
    id: r.id,
    edges: r.result.graph.edges,
    coverage: r.result.graph.coverage.status,
  })),
  sliceProjections: slices.projections.map((r) => ({
    id: r.id,
    coverage: r.result.coverage,
    points: r.result.points.map((p) => ({ name: p.name, kind: p.kind })),
  })),
  lifecycle,
  frontendRecovery: frontendRecovered,
  verification: {
    fixturesValid: true,
    sourceFrozen: true,
    accuracyPassed:
      wrongLiterals.length === 0 &&
      wrongHttp.length === 0 &&
      falseCompleteSlices.length === 0 &&
      claims.passed === claims.total &&
      lifecycle.every((r) => r.failed.length === 0),
  },
  limits: [
    'Not exhaustive TypeScript, per-flag, framework, configuration, or interruption coverage.',
    'Consumer comparisons expose disagreement; they do not independently establish runtime implementation identity.',
    'Positive Volar augmentation and new incremental histories were not exercised.',
    'The full ordinary suite was not rerun because production is unchanged.',
    'Raw malformed database snapshots remain local under the audit output directory.',
  ],
};
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ counts, verification: report.verification, report: destination }, null, 2));
if (process.argv.includes('--check') && !report.verification.accuracyPassed) process.exitCode = 1;
