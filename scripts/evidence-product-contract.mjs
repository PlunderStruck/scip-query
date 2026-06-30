#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const DEFAULT_COMMANDS = [
  ['dead', '--json'],
  ['doc-drift', '--json'],
  ['recent-duplicates', '--json'],
  ['similar', '--json', '--full'],
  ['health', '--json', '--full'],
];

const args = parseArgs(process.argv.slice(2));
const projectRoot = process.cwd();
const cliPath = resolve(projectRoot, 'dist/cli.js');
const date = new Date().toISOString().slice(0, 10);
const runHistoryPath = resolve(projectRoot, args.out ?? `docs/benchmarks/runs/${date}-evidence-products.jsonl`);
const profilePath = resolve(
  projectRoot,
  args.profileOut ?? `docs/benchmarks/runs/${date}-evidence-products.profile.jsonl`,
);
const commands = args.commands.length > 0 ? args.commands : DEFAULT_COMMANDS;

mkdirSync(dirname(runHistoryPath), { recursive: true });
mkdirSync(dirname(profilePath), { recursive: true });

const status = runCli(['status', '--json'], { profile: false });
if (status.exitCode !== 0) {
  process.stderr.write(status.stderr.toString());
  process.exit(status.exitCode ?? 1);
}

const statusJson = JSON.parse(status.stdout.toString());
const dbPath = statusJson.result?.dbPath;
if (typeof dbPath !== 'string') {
  throw new Error('status --json did not include result.dbPath');
}

const evidencePath = join(dirname(dbPath), 'evidence.db');
if (!args.noClear) clearEvidence(evidencePath);

const runId = new Date().toISOString();
const records = [];
for (let iteration = 1; iteration <= args.coldIterations; iteration += 1) {
  for (const command of commands) {
    records.push(recordCommand({ runId, phase: 'cold-fill', iteration, command, evidencePath }));
  }
}
for (let iteration = 1; iteration <= args.warmIterations; iteration += 1) {
  for (const command of commands) {
    records.push(recordCommand({ runId, phase: 'warm-hit', iteration, command, evidencePath }));
  }
}

const failed = records.filter((record) => record.exitCode !== 0 || record.signal || record.error);
const summary = {
  runId,
  runHistoryPath,
  profilePath,
  evidencePath,
  commands: commands.map((command) => command.join(' ')),
  coldIterations: args.coldIterations,
  warmIterations: args.warmIterations,
  failed: failed.length,
  records: records.map(
    ({ phase, iteration, command, durationMs, exitCode, stdoutBytes, stderrBytes, evidenceBytes }) => ({
      phase,
      iteration,
      command,
      durationMs,
      exitCode,
      stdoutBytes,
      stderrBytes,
      evidenceBytes,
    }),
  ),
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (failed.length > 0) process.exit(1);

function recordCommand({ runId, phase, iteration, command, evidencePath }) {
  const result = runCli(command, { profile: true });
  const record = {
    timestamp: new Date().toISOString(),
    runId,
    target: 'evidence-products',
    phase,
    iteration,
    command: `scip-query ${command.join(' ')}`,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    error: result.error?.message,
    stdoutBytes: result.stdout.length,
    stderrBytes: result.stderr.length,
    stdoutSha256: sha256(result.stdout),
    evidenceBytes: fileSize(evidencePath),
    profilePath,
  };
  appendFileSync(runHistoryPath, `${JSON.stringify(record)}\n`);
  return record;
}

function runCli(command, opts) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [cliPath, ...command], {
    cwd: projectRoot,
    env: opts.profile
      ? {
          ...process.env,
          SCIP_QUERY_PROFILE: '1',
          SCIP_QUERY_PROFILE_COMMAND: `scip-query ${command.join(' ')}`,
          SCIP_QUERY_PROFILE_OUT: profilePath,
        }
      : process.env,
    encoding: 'buffer',
    maxBuffer: 100 * 1024 * 1024,
  });
  return {
    durationMs: Math.round(performance.now() - started),
    exitCode: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  };
}

function clearEvidence(evidencePath) {
  for (const path of [evidencePath, `${evidencePath}-wal`, `${evidencePath}-shm`]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseArgs(argv) {
  const parsed = {
    coldIterations: 1,
    warmIterations: 2,
    commands: [],
    noClear: false,
    out: undefined,
    profileOut: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cold-iterations') {
      parsed.coldIterations = positiveInteger(argv[++index], '--cold-iterations');
    } else if (arg === '--warm-iterations') {
      parsed.warmIterations = positiveInteger(argv[++index], '--warm-iterations');
    } else if (arg === '--command') {
      const value = argv[++index];
      if (!value) throw new Error('--command requires a value');
      parsed.commands.push(splitCommand(value));
    } else if (arg === '--out') {
      parsed.out = argv[++index];
      if (!parsed.out) throw new Error('--out requires a value');
    } else if (arg === '--profile-out') {
      parsed.profileOut = argv[++index];
      if (!parsed.profileOut) throw new Error('--profile-out requires a value');
    } else if (arg === '--no-clear') {
      parsed.noClear = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return parsed;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function splitCommand(value) {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((part, index) => !(index === 0 && part === 'scip-query'));
}
