#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const args = parseArgs(process.argv.slice(2));
const projectRoot = resolve(args.projectRoot ?? process.cwd());
const cliPath = resolve(args.cli ?? resolve(projectRoot, 'dist/cli.js'));
const runHistoryPath = resolve(
  args.out ?? resolve(projectRoot, 'docs/benchmarks/runs/2026-07-09-automatic-freshness.jsonl'),
);
mkdirSync(dirname(runHistoryPath), { recursive: true });

const runId = new Date().toISOString();
const records = [];
if (args.scenario === 'manual-noop-control') await runManualNoopControls();
else if (args.scenario === 'daemon-lifecycle') await runDaemonLifecycle();
else if (args.scenario === 'daemon-idle-wake') await runDaemonIdleWake();
else await runDaemonEditScenario();

for (const entry of records) appendFileSync(runHistoryPath, `${JSON.stringify(entry)}\n`);
process.stdout.write(`${JSON.stringify({ runId, runHistoryPath, records }, null, 2)}\n`);
if (records.some((record) => record.exitCode !== 0 || record.signal || record.error)) process.exitCode = 1;

async function runManualNoopControls() {
  assertCommand(runCli(['reindex', '--json']), 'prepare no-op control');
  for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
    progress(`manual no-op ${iteration}/${args.iterations}`);
    const result = runCli(['reindex', '--json']);
    const payload = parseJson(result.stdout);
    record({
      scenario: args.scenario,
      iteration,
      command: 'scip-query reindex --json',
      ...commandFields(result),
      stdoutSha256: sha256(result.stdout),
      reportedDurationMs: payload?.result?.durationMs,
      reused: payload?.result?.reused,
      shards: payload?.result?.shards?.map(({ id, reused, durationMs }) => ({ id, reused, durationMs })),
    });
  }
}

async function runDaemonLifecycle() {
  assertCommand(runCli(['reindex', '--json']), 'prepare daemon lifecycle');
  for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
    progress(`daemon lifecycle ${iteration}/${args.iterations}`);
    runCli(['watch', '--stop', '--json']);
    const stoppedStatus = runCli(['watch', '--status', '--json']);
    const started = runCli(['watch', '--daemon', '--idle-timeout', '0', '--json']);
    const reused = runCli(['watch', '--daemon', '--json']);
    const stopped = runCli(['watch', '--stop', '--json']);
    const startedPayload = parseJson(started.stdout)?.result;
    const reusedPayload = parseJson(reused.stdout)?.result;
    const failure = firstFailure(stoppedStatus, started, reused, stopped);
    record({
      scenario: args.scenario,
      iteration,
      command: 'scip-query watch --daemon / reuse / stop',
      durationMs: started.durationMs,
      stoppedStatusDurationMs: stoppedStatus.durationMs,
      reuseDurationMs: reused.durationMs,
      reuseOverStatusDurationMs: reused.durationMs - stoppedStatus.durationMs,
      stopDurationMs: stopped.durationMs,
      exitCode: failure?.exitCode ?? 0,
      signal: failure?.signal ?? null,
      error: failure?.error,
      startDisposition: startedPayload?.disposition,
      reuseDisposition: reusedPayload?.disposition,
      startPid: startedPayload?.state?.pid,
      reusePid: reusedPayload?.state?.pid,
      samePid: startedPayload?.state?.pid === reusedPayload?.state?.pid,
    });
  }
}

async function runDaemonIdleWake() {
  assertCommand(runCli(['reindex', '--json']), 'prepare daemon idle/wake');
  const cacheDir = projectCacheDir();
  const statePath = join(cacheDir, 'watch-state.json');
  for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
    progress(`daemon idle/wake ${iteration}/${args.iterations}`);
    runCli(['watch', '--stop', '--json']);
    const started = runCli(['watch', '--daemon', '--idle-timeout', String(args.idleTimeout), '--json']);
    const startedPayload = parseJson(started.stdout)?.result;
    const idleStartedAt = performance.now();
    await waitFor(() => !existsSync(statePath), args.timeout, 'watch service idle exit');
    const idleExitMs = Math.round(performance.now() - idleStartedAt);
    const woke = runCli(['watch', '--daemon', '--idle-timeout', '0', '--json']);
    const wokePayload = parseJson(woke.stdout)?.result;
    const stopped = runCli(['watch', '--stop', '--json']);
    const failure = firstFailure(started, woke, stopped);
    record({
      scenario: args.scenario,
      iteration,
      command: 'scip-query watch idle exit / wake',
      durationMs: started.durationMs,
      wakeDurationMs: woke.durationMs,
      stopDurationMs: stopped.durationMs,
      idleExitMs,
      exitCode: failure?.exitCode ?? 0,
      signal: failure?.signal ?? null,
      error: failure?.error,
      startPid: startedPayload?.state?.pid,
      wakePid: wokePayload?.state?.pid,
      newPid: startedPayload?.state?.pid !== wokePayload?.state?.pid,
    });
  }
}

async function runDaemonEditScenario() {
  const editPath = resolve(projectRoot, args.editFile);
  if (!existsSync(editPath)) throw new Error(`edit fixture does not exist: ${editPath}`);
  const original = readFileSync(editPath, 'utf8');
  const cacheDir = projectCacheDir();
  const statePath = join(cacheDir, 'watch-state.json');
  assertCommand(runCli(['reindex', '--json']), 'prepare daemon edit');

  for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
    progress(`${args.scenario} ${iteration}/${args.iterations} (${args.debounce}ms/${args.cooldown}ms)`);
    let restored = false;
    try {
      runCli(['watch', '--stop', '--json']);
      const baselineRefresh = currentLastRefresh();
      const started = runCli([
        'watch',
        '--daemon',
        '--debounce',
        String(args.debounce),
        '--cooldown',
        String(args.cooldown),
        '--idle-timeout',
        '0',
        '--json',
      ]);
      assertCommand(started, 'start watch service');
      const eventStartedAtMs = Date.now();
      if (args.scenario === 'daemon-burst') {
        for (let write = 1; write <= args.burstWrites; write += 1) {
          writeFileSync(editPath, `${original}\n// scip-query freshness burst ${runId} ${iteration} ${write}\n`);
          await sleep(args.burstInterval);
        }
      } else {
        writeFileSync(editPath, `${original}\n// scip-query freshness edit ${runId} ${iteration}\n`);
      }

      const refreshed = await waitForRefresh(statePath, baselineRefresh, eventStartedAtMs);
      writeFileSync(editPath, original);
      restored = true;
      const restoredRefresh = await waitForRefresh(statePath, refreshed.completedAt, Date.now());
      const status = runCli(['status', '--json']);
      const outputContract = runCli(['kind-counts', '--json']);
      const stopped = runCli(['watch', '--stop', '--json']);
      const failure = firstFailure(started, status, outputContract, stopped);
      record({
        scenario: args.scenario,
        iteration,
        command: `watch edit ${args.editFile}`,
        durationMs: refreshed.eventToFreshMs,
        exitCode: failure?.exitCode ?? 0,
        signal: failure?.signal ?? null,
        error: failure?.error,
        debounceMs: args.debounce,
        cooldownMs: args.cooldown,
        writes: args.scenario === 'daemon-burst' ? args.burstWrites : 1,
        burstIntervalMs: args.scenario === 'daemon-burst' ? args.burstInterval : undefined,
        eventToObservedMs: refreshed.eventToObservedMs,
        eventToIndexingMs: refreshed.eventToIndexingMs,
        eventToFreshMs: refreshed.eventToFreshMs,
        refreshDurationMs: refreshed.durationMs,
        refreshTrigger: refreshed.trigger,
        indexingTransitions: refreshed.indexingTransitions,
        restoreToFreshMs: restoredRefresh.eventToFreshMs,
        restoredFreshness: parseJson(status.stdout)?.result?.freshness?.state,
        outputSha256: sha256(outputContract.stdout),
      });
    } finally {
      if (!restored || readFileSync(editPath, 'utf8') !== original) writeFileSync(editPath, original);
      runCli(['watch', '--stop', '--json']);
      const repair = runCli(['reindex', '--json']);
      if (repair.exitCode !== 0) process.stderr.write(repair.stderr);
    }
  }
}

async function waitForRefresh(statePath, previousCompletedAt, eventStartedAtMs) {
  const deadline = Date.now() + args.timeout;
  let observedAtMs;
  let indexingAtMs;
  let indexingTransitions = 0;
  let previousWatcherState;
  while (Date.now() <= deadline) {
    const state = readJson(statePath);
    const watcherState = state?.watcher?.state;
    if (watcherState && watcherState !== 'idle' && observedAtMs === undefined) observedAtMs = Date.now();
    if (watcherState === 'indexing' && previousWatcherState !== 'indexing') {
      indexingTransitions += 1;
      indexingAtMs ??= Date.now();
    }
    previousWatcherState = watcherState;
    if (state?.lastRefresh?.completedAt && state.lastRefresh.completedAt !== previousCompletedAt) {
      return {
        ...state.lastRefresh,
        eventToObservedMs: observedAtMs === undefined ? null : observedAtMs - eventStartedAtMs,
        eventToIndexingMs: indexingAtMs === undefined ? null : indexingAtMs - eventStartedAtMs,
        eventToFreshMs: Date.now() - eventStartedAtMs,
        indexingTransitions,
      };
    }
    await sleep(25);
  }
  throw new Error(`timed out after ${args.timeout}ms waiting for watch refresh`);
}

function currentLastRefresh() {
  const status = runCli(['status', '--json']);
  assertCommand(status, 'read current refresh');
  return parseJson(status.stdout)?.result?.freshness?.lastRefresh?.completedAt;
}

function projectCacheDir() {
  const status = runCli(['status', '--json']);
  assertCommand(status, 'resolve project cache');
  const dbPath = parseJson(status.stdout)?.result?.dbPath;
  if (typeof dbPath !== 'string') throw new Error('status --json did not return result.dbPath');
  return dirname(dbPath);
}

function record(value) {
  const entry = { timestamp: new Date().toISOString(), runId, target: 'automatic-freshness', ...value };
  records.push(entry);
}

function runCli(command) {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [cliPath, ...command], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    env: { ...process.env, SCIP_QUERY_SKIP_WATCH_SERVICE: '1' },
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

function commandFields(result) {
  return {
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    error: result.error,
    stderrBytes: result.stderr.length,
  };
}

function firstFailure(...results) {
  return results.find((result) => result.exitCode !== 0 || result.signal || result.error);
}

function assertCommand(result, label) {
  if (result.exitCode === 0 && !result.signal && !result.error) return;
  throw new Error(`${label} failed: ${result.error ?? result.stderr ?? result.signal ?? result.exitCode}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

function sleep(durationMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
}

function progress(message) {
  process.stderr.write(`[freshness-contract] ${message}\n`);
}

function parseArgs(argv) {
  const parsed = {
    scenario: 'manual-noop-control',
    iterations: 5,
    projectRoot: undefined,
    cli: undefined,
    out: undefined,
    editFile: 'src/domain/number-parsing.ts',
    debounce: 750,
    cooldown: 1_000,
    idleTimeout: 50,
    burstWrites: 20,
    burstInterval: 25,
    timeout: 60_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--scenario') parsed.scenario = requiredValue(argv[++index], arg);
    else if (arg === '--iterations') parsed.iterations = positiveInteger(argv[++index], arg);
    else if (arg === '--project-root') parsed.projectRoot = requiredValue(argv[++index], arg);
    else if (arg === '--cli') parsed.cli = requiredValue(argv[++index], arg);
    else if (arg === '--out') parsed.out = requiredValue(argv[++index], arg);
    else if (arg === '--edit-file') parsed.editFile = requiredValue(argv[++index], arg);
    else if (arg === '--debounce') parsed.debounce = nonNegativeInteger(argv[++index], arg);
    else if (arg === '--cooldown') parsed.cooldown = nonNegativeInteger(argv[++index], arg);
    else if (arg === '--idle-timeout') parsed.idleTimeout = nonNegativeInteger(argv[++index], arg);
    else if (arg === '--burst-writes') parsed.burstWrites = positiveInteger(argv[++index], arg);
    else if (arg === '--burst-interval') parsed.burstInterval = nonNegativeInteger(argv[++index], arg);
    else if (arg === '--timeout') parsed.timeout = positiveInteger(argv[++index], arg);
    else throw new Error(`unknown option: ${arg}`);
  }
  const scenarios = new Set([
    'manual-noop-control',
    'daemon-lifecycle',
    'daemon-idle-wake',
    'daemon-edit',
    'daemon-burst',
  ]);
  if (!scenarios.has(parsed.scenario)) throw new Error(`unknown scenario: ${parsed.scenario}`);
  return parsed;
}

function positiveInteger(value, flag) {
  const parsed = nonNegativeInteger(value, flag);
  if (parsed === 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value, flag) {
  const parsed = Number(requiredValue(value, flag));
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function requiredValue(value, flag) {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
