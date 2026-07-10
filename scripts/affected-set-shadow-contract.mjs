#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const cliPath = resolve(args.cli ?? join(toolRoot, 'dist/cli.js'));
const runHistoryPath = resolve(args.out ?? join(toolRoot, 'docs/benchmarks/runs/2026-07-09-affected-set-shadow.jsonl'));
const runId = new Date().toISOString();
const records = [];
let activeProjectRoot;
let failure;

try {
  if (args.mode === 'fixture') await runFixtureMatrix();
  else if (args.mode === 'leaf') await runLeafCorpus();
  else if (args.mode === 'noop') runNoopCorpus();
  else if (args.mode === 'capability') runCapabilitySnapshot();
  else throw new Error(`unsupported mode: ${args.mode}`);
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  if (activeProjectRoot) runCli(activeProjectRoot, ['watch', '--stop', '--json']);
}

if (failure) {
  records.push({
    timestamp: new Date().toISOString(),
    runId,
    target: 'affected-set-shadow',
    mode: args.mode,
    corpus: args.label,
    status: 'failed',
    error: failure.message,
  });
}
mkdirSync(dirname(runHistoryPath), { recursive: true });
for (const record of records) appendFileSync(runHistoryPath, `${JSON.stringify(record)}\n`);
process.stdout.write(
  `${JSON.stringify({ runId, runHistoryPath, records, failed: failure?.message ?? null }, null, 2)}\n`,
);
if (failure) process.exitCode = 1;

async function runFixtureMatrix() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-affected-shadow-'));
  activeProjectRoot = projectRoot;
  let cacheDir;
  try {
    createFixture(projectRoot);
    assertCommand(runCli(projectRoot, ['reindex', '--json']), 'fixture baseline reindex');
    cacheDir = dirname(readStatus(projectRoot).dbPath);

    await runFixtureScenario(
      projectRoot,
      fixtureScenario('leaf-comment', {
        path: 'src/isolated.ts',
        mutate: (original) => appendText(original, `\n// shadow leaf ${runId}\n`),
        expectedMode: 'closure',
        expectedActual: ['src/isolated.ts'],
      }),
    );
    const leafStatus = records.at(-1)?.shadow;
    proveVerifierCanFail(leafStatus);

    await runFixtureScenario(
      projectRoot,
      fixtureScenario('export-signature', {
        path: 'src/leaf.ts',
        mutate: (original) =>
          replaceText(
            original,
            'export function leaf(value: number): number { return value + 1; }',
            'export function leaf(value: number, label?: string): number { return value + (label?.length ?? 1); }',
          ),
        expectedMode: 'closure',
        expectedActual: ['src/leaf.ts', 'src/consumer.ts'],
      }),
    );
    await runFixtureScenario(
      projectRoot,
      fixtureScenario('import-edge', {
        path: 'src/consumer.ts',
        mutate: (original) =>
          replaceText(
            original,
            `import { leaf } from './leaf.js';\nexport const consumer = leaf(1);`,
            `import { other } from './other.js';\nexport const consumer = other(1);`,
          ),
        expectedMode: 'closure',
        expectedActual: ['src/consumer.ts'],
      }),
    );
    await runFixtureScenario(projectRoot, {
      name: 'multi-file',
      expectedMode: 'closure',
      expectedActual: ['src/isolated.ts', 'src/other.ts'],
      apply: () => {
        writeFileSync(
          join(projectRoot, 'src/isolated.ts'),
          appendText(readFileSync(join(projectRoot, 'src/isolated.ts')), '\n// multi a\n'),
        );
        writeFileSync(
          join(projectRoot, 'src/other.ts'),
          appendText(readFileSync(join(projectRoot, 'src/other.ts')), '\n// multi b\n'),
        );
      },
      restore: exactRestorer(projectRoot, ['src/isolated.ts', 'src/other.ts']),
    });
    await runFixtureScenario(projectRoot, {
      name: 'file-added',
      expectedMode: 'full-project',
      expectedActual: ['src/added.ts'],
      apply: () => writeFileSync(join(projectRoot, 'src/added.ts'), 'export const added = 1;\n'),
      restore: () => rmSync(join(projectRoot, 'src/added.ts'), { force: true }),
    });
    await runFixtureScenario(projectRoot, {
      name: 'file-deleted',
      expectedMode: 'full-project',
      expectedActual: ['src/delete-me.ts'],
      apply: () => rmSync(join(projectRoot, 'src/delete-me.ts')),
      restore: exactRestorer(projectRoot, ['src/delete-me.ts']),
    });
    await runFixtureScenario(
      projectRoot,
      fixtureScenario('ambient-declaration', {
        path: 'src/ambient.d.ts',
        mutate: (original) => appendText(original, '\ndeclare global { interface Window { shadowAdded: string; } }\n'),
        expectedMode: 'full-project',
        expectedActual: ['src/ambient.d.ts'],
      }),
    );
    await runFixtureScenario(
      projectRoot,
      fixtureScenario('tsconfig', {
        path: 'tsconfig.json',
        mutate: (original) => appendText(original, '\n'),
        expectedMode: 'full-project',
        expectedActual: [],
      }),
    );
    await runFixtureScenario(
      projectRoot,
      fixtureScenario('package-manifest', {
        path: 'package.json',
        mutate: (original) => appendText(original, '\n'),
        expectedMode: 'full-project',
        expectedActual: [],
      }),
    );
    await runMalformedMetadataScenario(projectRoot);
    await runSleepingServiceScenario(projectRoot, cacheDir);
  } finally {
    runCli(projectRoot, ['watch', '--stop', '--json']);
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    activeProjectRoot = undefined;
  }
}

async function runFixtureScenario(projectRoot, scenario) {
  let applied = false;
  try {
    scenario.apply();
    applied = true;
    const run = reindexWithShadow(projectRoot, scenario.name);
    verifyShadow(run.shadow, {
      expectedMode: scenario.expectedMode,
      expectedActual: scenario.expectedActual,
    });
    records.push(
      baseRecord({
        mode: 'fixture',
        corpus: 'generated-typescript-fixture',
        scenario: scenario.name,
        iteration: 1,
        ...measurementFields(run),
      }),
    );
  } finally {
    if (applied) scenario.restore();
    assertCommand(runCli(projectRoot, ['reindex', '--json']), `repair ${scenario.name}`);
  }
}

async function runMalformedMetadataScenario(projectRoot) {
  const status = readStatus(projectRoot);
  const metaPath = join(dirname(status.dbPath), 'meta.json');
  const sourcePath = join(projectRoot, 'src/isolated.ts');
  const originalSource = readFileSync(sourcePath);
  try {
    writeFileSync(metaPath, '{');
    writeFileSync(sourcePath, appendText(originalSource, '\n// malformed prior state\n'));
    const run = reindexWithShadow(projectRoot, 'malformed-metadata');
    verifyShadow(run.shadow, { expectedMode: 'full-project', expectedActual: ['src/isolated.ts'] });
    records.push(
      baseRecord({
        mode: 'fixture',
        corpus: 'generated-typescript-fixture',
        scenario: 'malformed-metadata',
        iteration: 1,
        ...measurementFields(run),
      }),
    );
  } finally {
    writeFileSync(sourcePath, originalSource);
    assertCommand(runCli(projectRoot, ['reindex', '--json']), 'repair malformed metadata scenario');
  }
}

async function runSleepingServiceScenario(projectRoot, cacheDir) {
  const sourcePath = join(projectRoot, 'src/isolated.ts');
  const original = readFileSync(sourcePath);
  const statePath = join(cacheDir, 'watch-state.json');
  const baseline = readStatus(projectRoot).freshness?.lastRefresh?.completedAt;
  try {
    assertCommand(
      runCli(projectRoot, ['watch', '--daemon', '--idle-timeout', '250', '--json']),
      'start idle fixture service',
    );
    await waitFor(() => !existsSync(statePath), args.timeoutMs, 'fixture service idle exit');
    writeFileSync(sourcePath, appendText(original, '\n// sleeping service edit\n'));
    const startedAt = performance.now();
    assertCommand(
      runCli(projectRoot, ['status', '--json'], { skipWatchService: false }),
      'wake sleeping fixture service',
    );
    const refresh = await waitForRefresh(statePath, baseline);
    const status = readStatus(projectRoot);
    verifyShadow(status.affectedSetShadow, { expectedMode: 'closure', expectedActual: ['src/isolated.ts'] });
    records.push(
      baseRecord({
        mode: 'fixture',
        corpus: 'generated-typescript-fixture',
        scenario: 'sleeping-service-leaf',
        iteration: 1,
        processWallMs: Math.round(performance.now() - startedAt),
        reindexDurationMs: refresh.durationMs,
        shadowDurationMs: status.affectedSetShadow.durationMs,
        shadow: status.affectedSetShadow,
        artifacts: artifactEvidence(projectRoot, status),
      }),
    );
  } finally {
    writeFileSync(sourcePath, original);
    runCli(projectRoot, ['watch', '--stop', '--json']);
    assertCommand(runCli(projectRoot, ['reindex', '--json']), 'repair sleeping service scenario');
  }
}

async function runLeafCorpus() {
  const projectRoot = requiredProjectRoot();
  activeProjectRoot = projectRoot;
  const editPath = resolve(projectRoot, requiredArg(args.editFile, '--edit-file'));
  if (!existsSync(editPath)) throw new Error(`leaf edit file does not exist: ${editPath}`);
  const initialGitStatus = gitStatus(projectRoot);
  if (initialGitStatus !== '') throw new Error(`corpus must start clean:\n${initialGitStatus}`);
  const original = readFileSync(editPath);
  const mutated = appendText(original, `\n// affected-set shadow corpus ${runId}\n`);
  let mutatedOnDisk = false;
  let runError;
  try {
    assertCommand(runCli(projectRoot, ['watch', '--stop', '--json']), 'stop corpus service');
    assertCommand(runCli(projectRoot, ['reindex', '--json']), 'prepare leaf corpus');

    writeFileSync(editPath, mutated);
    mutatedOnDisk = true;
    const warmup = reindexWithShadow(projectRoot, 'leaf-warmup');
    verifyShadow(warmup.shadow, { expectedMode: 'closure', expectedActual: [args.editFile], maxRatio: 0.2 });

    const measurements = [];
    for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
      const direction = mutatedOnDisk ? 'restore' : 'apply';
      writeFileSync(editPath, mutatedOnDisk ? original : mutated);
      mutatedOnDisk = !mutatedOnDisk;
      const run = reindexWithShadow(projectRoot, `leaf-${direction}`);
      verifyShadow(run.shadow, { expectedMode: 'closure', expectedActual: [args.editFile], maxRatio: 0.2 });
      const record = baseRecord({
        mode: 'leaf',
        corpus: args.label,
        projectRoot,
        commit: gitCommit(projectRoot),
        scenario: 'leaf-edit',
        iteration,
        direction,
        ...measurementFields(run),
      });
      measurements.push(record);
      records.push(record);
    }
    if (mutatedOnDisk) {
      writeFileSync(editPath, original);
      mutatedOnDisk = false;
      assertCommand(runCli(projectRoot, ['reindex', '--json']), 'restore leaf corpus');
    }
    const summary = leafSummary(measurements);
    records.push(
      baseRecord({
        mode: 'leaf-summary',
        corpus: args.label,
        projectRoot,
        commit: gitCommit(projectRoot),
        scenario: 'leaf-edit-summary',
        iterations: args.iterations,
        ...summary,
      }),
    );
    if (!summary.accepted) throw new Error(`${args.label} leaf acceptance failed: ${JSON.stringify(summary)}`);
  } catch (error) {
    runError = error instanceof Error ? error : new Error(String(error));
  }
  let cleanupError;
  try {
    if (mutatedOnDisk || !readFileSync(editPath).equals(original)) writeFileSync(editPath, original);
    runCli(projectRoot, ['watch', '--stop', '--json']);
    const repair = runCli(projectRoot, ['reindex', '--json']);
    if (repair.exitCode !== 0) cleanupError = new Error(`leaf corpus repair failed: ${repair.stderr}`);
    const finalGitStatus = gitStatus(projectRoot);
    if (finalGitStatus !== initialGitStatus) {
      cleanupError = new Error(`corpus Git state changed:\nbefore=${initialGitStatus}\nafter=${finalGitStatus}`);
    }
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error));
  } finally {
    activeProjectRoot = undefined;
  }
  if (runError) {
    if (cleanupError) runError.message += `; cleanup also failed: ${cleanupError.message}`;
    throw runError;
  }
  if (cleanupError) throw cleanupError;
}

function runNoopCorpus() {
  const projectRoot = requiredProjectRoot();
  activeProjectRoot = projectRoot;
  const initialGitStatus = gitStatus(projectRoot);
  if (initialGitStatus !== '') throw new Error(`corpus must start clean:\n${initialGitStatus}`);
  let runError;
  try {
    assertCommand(runCli(projectRoot, ['watch', '--stop', '--json']), 'stop no-op corpus service');
    assertCommand(runCli(projectRoot, ['reindex', '--json']), 'prepare no-op corpus');
    assertCommand(runCli(projectRoot, ['reindex', '--json']), 'warm no-op corpus');
    const measurements = [];
    for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
      const startedAt = performance.now();
      const result = runCli(projectRoot, ['reindex', '--json']);
      assertCommand(result, `no-op ${iteration}`);
      const payload = parseJson(result.stdout)?.result;
      const record = baseRecord({
        mode: 'noop',
        corpus: args.label,
        projectRoot,
        commit: gitCommit(projectRoot),
        scenario: 'exact-noop',
        iteration,
        processWallMs: Math.round(performance.now() - startedAt),
        reindexDurationMs: payload?.durationMs,
        reused: payload?.reused,
      });
      measurements.push(record);
      records.push(record);
    }
    const durations = measurements.map((record) => record.reindexDurationMs);
    const summary = {
      medianDurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
      baselineMedianMs: 329,
      baselineP95Ms: 348,
      medianRegression: ratio(percentile(durations, 0.5) - 329, 329),
      p95Regression: ratio(percentile(durations, 0.95) - 348, 348),
    };
    summary.accepted = summary.medianRegression <= 0.1 && summary.p95Regression <= 0.1;
    records.push(
      baseRecord({
        mode: 'noop-summary',
        corpus: args.label,
        projectRoot,
        commit: gitCommit(projectRoot),
        scenario: 'exact-noop-summary',
        iterations: args.iterations,
        ...summary,
      }),
    );
    if (!summary.accepted) throw new Error(`${args.label} no-op acceptance failed: ${JSON.stringify(summary)}`);
  } catch (error) {
    runError = error instanceof Error ? error : new Error(String(error));
  }
  runCli(projectRoot, ['watch', '--stop', '--json']);
  const stateChanged = gitStatus(projectRoot) !== initialGitStatus;
  activeProjectRoot = undefined;
  if (runError) throw runError;
  if (stateChanged) throw new Error('no-op corpus Git state changed');
}

function runCapabilitySnapshot() {
  const projectRoot = requiredProjectRoot();
  const result = runCli(projectRoot, ['status', '--capabilities', '--json']);
  assertCommand(result, 'capability snapshot');
  const status = parseJson(result.stdout)?.result;
  records.push(
    baseRecord({
      mode: 'capability',
      corpus: args.label,
      projectRoot,
      commit: gitCommit(projectRoot),
      scenario: 'pre-registered-capability-snapshot',
      languages: status?.readiness?.languages,
      indexers: status?.readiness?.indexers,
      semantics: status?.readiness?.semantics,
      capabilities: status?.capabilities?.capabilities,
      freshness: status?.freshness?.state,
      stats: status?.stats,
    }),
  );
}

function fixtureScenario(name, options) {
  const projectRoot = activeProjectRoot;
  const absolutePath = join(projectRoot, options.path);
  const original = readFileSync(absolutePath);
  return {
    name,
    expectedMode: options.expectedMode,
    expectedActual: options.expectedActual,
    apply: () => writeFileSync(absolutePath, options.mutate(original)),
    restore: () => writeFileSync(absolutePath, original),
  };
}

function exactRestorer(projectRoot, relativePaths) {
  const originals = new Map(relativePaths.map((path) => [path, readFileSync(join(projectRoot, path))]));
  return () => {
    for (const [path, contents] of originals) writeFileSync(join(projectRoot, path), contents);
  };
}

function reindexWithShadow(projectRoot, label) {
  const startedAt = performance.now();
  const result = runCli(projectRoot, ['reindex', '--json']);
  assertCommand(result, label);
  const payload = parseJson(result.stdout)?.result;
  const status = readStatus(projectRoot);
  return {
    processWallMs: Math.round(performance.now() - startedAt),
    reindexDurationMs: payload?.durationMs,
    reused: payload?.reused,
    shadow: status.affectedSetShadow,
    artifacts: artifactEvidence(projectRoot, status),
  };
}

function measurementFields(run) {
  const estimatedAuthoritativeMs = Math.max(0, run.reindexDurationMs - run.shadow.durationMs);
  return {
    processWallMs: run.processWallMs,
    reindexDurationMs: run.reindexDurationMs,
    shadowDurationMs: run.shadow.durationMs,
    estimatedAuthoritativeMs,
    shadowOverAuthoritative: ratio(run.shadow.durationMs, estimatedAuthoritativeMs),
    reused: run.reused,
    shadow: run.shadow,
    artifacts: run.artifacts,
  };
}

function verifyShadow(shadow, options) {
  if (!shadow || shadow.state !== 'passing') throw new Error(`shadow is not passing: ${JSON.stringify(shadow)}`);
  const computedMissing = shadow.actualFiles.filter((path) => !shadow.predictedFiles.includes(path));
  if (computedMissing.length > 0) throw new Error(`shadow underpredicted: ${computedMissing.join(', ')}`);
  if (shadow.recall !== 1 || shadow.missingFiles.length !== 0) {
    throw new Error(`shadow recall gate failed: ${JSON.stringify(shadow)}`);
  }
  if (options.expectedMode && shadow.mode !== options.expectedMode) {
    throw new Error(`expected ${options.expectedMode} plan, received ${shadow.mode}`);
  }
  for (const path of options.expectedActual ?? []) {
    if (!shadow.actualFiles.includes(path)) throw new Error(`expected actual changed file missing: ${path}`);
  }
  if (options.maxRatio !== undefined && shadow.affectedRatio >= options.maxRatio) {
    throw new Error(`affected ratio ${shadow.affectedRatio} is not below ${options.maxRatio}`);
  }
}

function proveVerifierCanFail(shadow) {
  if (!shadow || shadow.state !== 'passing' || shadow.actualFiles.length === 0) {
    throw new Error('cannot plant underprediction without a passing changed-file record');
  }
  const omitted = shadow.actualFiles[0];
  const planted = { ...shadow, predictedFiles: shadow.predictedFiles.filter((path) => path !== omitted) };
  let rejected = false;
  try {
    verifyShadow(planted, {});
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('planted underprediction did not fail the harness verifier');
  records.push(
    baseRecord({
      mode: 'verifier-probe',
      corpus: 'generated-typescript-fixture',
      scenario: 'planted-underprediction',
      omitted,
      rejected: true,
    }),
  );
}

function leafSummary(measurements) {
  const durations = measurements.map((record) => record.reindexDurationMs);
  const shadowDurations = measurements.map((record) => record.shadowDurationMs);
  const overheadRatios = measurements.map((record) => record.shadowOverAuthoritative);
  const affectedRatios = measurements.map((record) => record.shadow.affectedRatio);
  const recalls = measurements.map((record) => record.shadow.recall);
  const medianOverheadRatio = percentile(overheadRatios, 0.5);
  const p95OverheadRatio = percentile(overheadRatios, 0.95);
  const medianAffectedRatio = percentile(affectedRatios, 0.5);
  const recallPass = recalls.every((value) => value === 1);
  const ratioPass = medianAffectedRatio < 0.2;
  const overheadPass = medianOverheadRatio <= 0.1 && p95OverheadRatio <= 0.2;
  return {
    medianDurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    medianShadowDurationMs: percentile(shadowDurations, 0.5),
    p95ShadowDurationMs: percentile(shadowDurations, 0.95),
    medianOverheadRatio,
    p95OverheadRatio,
    medianAffectedRatio,
    p95AffectedRatio: percentile(affectedRatios, 0.95),
    minimumRecall: Math.min(...recalls),
    recallPass,
    ratioPass,
    overheadPass,
    accepted: recallPass && ratioPass && overheadPass,
  };
}

function artifactEvidence(projectRoot, status) {
  const db = new Database(status.dbPath, { readonly: true });
  let factCounts;
  try {
    factCounts = {
      documents: scalarCount(db, 'documents'),
      symbols: scalarCount(db, 'global_symbols'),
      definitions: scalarCount(db, 'defn_enclosing_ranges'),
      mentions: scalarCount(db, 'mentions'),
      chunks: scalarCount(db, 'chunks'),
    };
  } finally {
    db.close();
  }
  const kindCounts = runCli(projectRoot, ['kind-counts', '--json']);
  assertCommand(kindCounts, 'kind-counts output contract');
  return {
    factCounts,
    factCountsSha256: sha256(JSON.stringify(factCounts)),
    kindCountsSha256: sha256(JSON.stringify(parseJson(kindCounts.stdout)?.result)),
    scipSha256: fileSha256(join(dirname(status.dbPath), 'index.scip')),
    sqliteSha256: fileSha256(status.dbPath),
  };
}

function scalarCount(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function readStatus(projectRoot) {
  const result = runCli(projectRoot, ['status', '--json']);
  assertCommand(result, 'status');
  const status = parseJson(result.stdout)?.result;
  if (!status || typeof status.dbPath !== 'string') throw new Error('status did not return a database path');
  return status;
}

function runCli(projectRoot, command, options = {}) {
  const env = { ...process.env, SCIP_QUERY_PROJECT_ROOT: projectRoot };
  if (options.skipWatchService === false) delete env.SCIP_QUERY_SKIP_WATCH_SERVICE;
  else env.SCIP_QUERY_SKIP_WATCH_SERVICE = '1';
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [cliPath, ...command], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
    env,
  });
  return {
    durationMs: Math.round(performance.now() - startedAt),
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function assertCommand(result, label) {
  if (result.exitCode !== 0 || result.signal || result.error) {
    throw new Error(`${label} failed (${result.exitCode ?? result.signal ?? result.error}): ${result.stderr}`);
  }
}

function createFixture(projectRoot) {
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(projectRoot, 'package.json'), '{"name":"affected-shadow-fixture","type":"module"}\n');
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","strict":true},"include":["src"]}\n',
  );
  writeFileSync(
    join(projectRoot, '.scipquery.json'),
    '{"languages":["typescript"],"watch":{"enabled":true,"debounceMs":50,"cooldownMs":0,"gitPollMs":100,"idleTimeoutMs":250,"autoRefresh":true}}\n',
  );
  writeFileSync(
    join(projectRoot, 'src/leaf.ts'),
    'export function leaf(value: number): number { return value + 1; }\n',
  );
  writeFileSync(
    join(projectRoot, 'src/other.ts'),
    'export function other(value: number): number { return value - 1; }\n',
  );
  writeFileSync(
    join(projectRoot, 'src/consumer.ts'),
    `import { leaf } from './leaf.js';\nexport const consumer = leaf(1);\n`,
  );
  writeFileSync(join(projectRoot, 'src/entry.ts'), `import { consumer } from './consumer.js';\nvoid consumer;\n`);
  writeFileSync(join(projectRoot, 'src/isolated.ts'), 'export const isolated = 1;\n');
  writeFileSync(join(projectRoot, 'src/delete-me.ts'), 'export const deleteMe = 1;\n');
  writeFileSync(
    join(projectRoot, 'src/ambient.d.ts'),
    'export {};\ndeclare global { interface Window { fixtureValue: number; } }\n',
  );
}

function baseRecord(value) {
  return {
    timestamp: new Date().toISOString(),
    runId,
    target: 'affected-set-shadow',
    status: 'ok',
    toolCommit: gitCommit(toolRoot),
    cliSha256: fileSha256(cliPath),
    ...value,
  };
}

function gitStatus(projectRoot) {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git status failed: ${result.stderr}`);
  const ownedHistoryPath = relative(projectRoot, runHistoryPath);
  return result.stdout
    .split('\n')
    .filter((line) => line && (ownedHistoryPath.startsWith('..') || line.slice(3) !== ownedHistoryPath))
    .join('\n');
}

function gitCommit(projectRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

async function waitForRefresh(statePath, previousCompletedAt) {
  let latest;
  await waitFor(
    () => {
      latest = readJson(statePath)?.lastRefresh;
      return Boolean(latest?.completedAt && latest.completedAt !== previousCompletedAt);
    },
    args.timeoutMs,
    'watch refresh',
  );
  return latest;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function appendText(buffer, suffix) {
  return Buffer.concat([buffer, Buffer.from(suffix)]);
}

function replaceText(buffer, before, after) {
  const value = buffer.toString('utf8');
  if (!value.includes(before)) throw new Error(`fixture text not found: ${before}`);
  return Buffer.from(value.replace(before, after));
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function requiredProjectRoot() {
  return resolve(requiredArg(args.projectRoot, '--project-root'));
}

function requiredArg(value, flag) {
  if (!value) throw new Error(`${flag} is required for ${args.mode} mode`);
  return value;
}

function parseArgs(argv) {
  const parsed = {
    mode: undefined,
    projectRoot: undefined,
    editFile: undefined,
    label: undefined,
    cli: undefined,
    out: undefined,
    iterations: 5,
    timeoutMs: 120_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') parsed.mode = argv[++index];
    else if (arg === '--project-root') parsed.projectRoot = argv[++index];
    else if (arg === '--edit-file') parsed.editFile = argv[++index];
    else if (arg === '--label') parsed.label = argv[++index];
    else if (arg === '--cli') parsed.cli = argv[++index];
    else if (arg === '--out') parsed.out = argv[++index];
    else if (arg === '--iterations') parsed.iterations = positiveInteger(argv[++index], '--iterations');
    else if (arg === '--timeout-ms') parsed.timeoutMs = positiveInteger(argv[++index], '--timeout-ms');
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!parsed.mode) throw new Error('--mode fixture|leaf|noop|capability is required');
  parsed.label ??= parsed.mode === 'fixture' ? 'generated-typescript-fixture' : 'unnamed-corpus';
  return parsed;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}
