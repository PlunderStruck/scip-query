#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
  const result = runCli(['reindex', '--json']);
  const payload = parseJson(result.stdout);
  const record = {
    timestamp: new Date().toISOString(),
    runId,
    target: 'automatic-freshness',
    scenario: 'manual-noop-control',
    iteration,
    command: 'scip-query reindex --json',
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    error: result.error,
    stdoutSha256: sha256(result.stdout),
    stderrBytes: result.stderr.length,
    reused: payload?.result?.reused,
    shards: payload?.result?.shards?.map(({ id, reused, durationMs }) => ({ id, reused, durationMs })),
  };
  appendFileSync(runHistoryPath, `${JSON.stringify(record)}\n`);
  records.push(record);
}

process.stdout.write(`${JSON.stringify({ runId, runHistoryPath, records }, null, 2)}\n`);
if (records.some((record) => record.exitCode !== 0 || record.signal || record.error)) process.exitCode = 1;

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

function parseArgs(argv) {
  const parsed = { iterations: 5, projectRoot: undefined, cli: undefined, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--iterations') {
      parsed.iterations = positiveInteger(argv[++index], arg);
    } else if (arg === '--project-root') {
      parsed.projectRoot = requiredValue(argv[++index], arg);
    } else if (arg === '--cli') {
      parsed.cli = requiredValue(argv[++index], arg);
    } else if (arg === '--out') {
      parsed.out = requiredValue(argv[++index], arg);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return parsed;
}

function positiveInteger(value, flag) {
  const parsed = Number(requiredValue(value, flag));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function requiredValue(value, flag) {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
