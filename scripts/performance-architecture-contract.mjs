#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export const DEFAULT_RUN_HISTORY = 'docs/benchmarks/runs/2026-07-02-performance-architecture.jsonl';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}

export function main(argv, deps = defaultDeps()) {
  const args = parseArgs(argv);
  const repoPath = resolve(args.repo);
  const cliPath = resolve(args.cli ?? process.env.SCIP_QUERY_CLI ?? join(REPO_ROOT, 'dist/cli.js'));
  const runHistoryPath = resolve(args.out ?? DEFAULT_RUN_HISTORY);
  const profilePath =
    args.profileOut ?? join(dirname(runHistoryPath), `2026-07-02-performance-architecture.${Date.now()}.profile.jsonl`);

  deps.mkdirSync(dirname(runHistoryPath), { recursive: true });
  deps.mkdirSync(dirname(profilePath), { recursive: true });

  const status = runCli(deps, cliPath, repoPath, ['status', '--json'], profilePath, false, args.cacheState);
  if (status.exitCode !== 0) {
    process.stderr.write(status.stderr.toString());
    process.exit(status.exitCode ?? 1);
  }
  const statusJson = JSON.parse(status.stdout.toString());
  const dbPath = statusJson.result?.dbPath;
  if (typeof dbPath !== 'string') throw new Error('status --json did not include result.dbPath');

  const evidencePath = join(dirname(dbPath), 'evidence.db');
  if (!args.noClear && args.cacheState === 'evidence-cold') clearEvidence(deps, evidencePath);

  const command = splitCommand(args.command);
  const runId = new Date().toISOString();
  const records = [];
  for (let iteration = 1; iteration <= args.warmIterations; iteration += 1) {
    const result = runCli(deps, cliPath, repoPath, command, profilePath, true, args.cacheState);
    const record = buildRunRecord({
      repoPath,
      gitHead: gitOutput(deps, repoPath, ['rev-parse', 'HEAD']),
      dirty: gitOutput(deps, repoPath, ['status', '--short']) !== '',
      command,
      cacheState: args.cacheState,
      runId,
      iteration,
      dbPath,
      evidencePath,
      profilePath,
      result,
      evidenceRows: collectEvidenceRows(evidencePath),
      nowIso: new Date().toISOString(),
    });
    deps.appendFileSync(runHistoryPath, `${JSON.stringify(record)}\n`);
    records.push(record);
  }

  const summary = { runId, runHistoryPath, profilePath, records };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (records.some((record) => record.exitCode !== 0)) process.exit(1);
}

export function parseArgs(argv) {
  const parsed = {
    repo: '.',
    command: 'health --json',
    warmIterations: 1,
    noClear: false,
    cacheState: 'evidence-cold',
    out: undefined,
    profileOut: undefined,
    cli: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') parsed.repo = requiredValue(argv[++index], arg);
    else if (arg === '--command') parsed.command = requiredValue(argv[++index], arg);
    else if (arg === '--warm-iterations') parsed.warmIterations = nonNegativeInteger(argv[++index], arg);
    else if (arg === '--no-clear') {
      parsed.noClear = true;
      parsed.cacheState = 'evidence-warm';
    } else if (arg === '--cache-state') parsed.cacheState = requiredValue(argv[++index], arg);
    else if (arg === '--out') parsed.out = requiredValue(argv[++index], arg);
    else if (arg === '--profile-out') parsed.profileOut = requiredValue(argv[++index], arg);
    else if (arg === '--cli') parsed.cli = requiredValue(argv[++index], arg);
    else throw new Error(`unknown option: ${arg}`);
  }
  return parsed;
}

export function buildRunRecord(input) {
  return {
    timestamp: input.nowIso,
    runId: input.runId,
    repoPath: input.repoPath,
    gitHead: input.gitHead,
    dirty: input.dirty,
    command: `scip-query ${input.command.join(' ')}`,
    cacheState: input.cacheState,
    iteration: input.iteration,
    durationMs: input.result.durationMs,
    exitCode: input.result.exitCode,
    signal: input.result.signal,
    error: input.result.error?.message,
    stdoutBytes: input.result.stdout.length,
    stderrBytes: input.result.stderr.length,
    stdoutSha256: sha256(input.result.stdout),
    indexBytes: fileSize(input.dbPath),
    evidenceBytes: fileSize(input.evidencePath),
    evidenceRows: input.evidenceRows,
    profilePath: input.profilePath,
  };
}

export function collectEvidenceRows(evidencePath) {
  const empty = {
    file_evidence: {},
    project_evidence: {},
    semantic_callees: { total: 0 },
    semantic_references: { total: 0 },
    finding_outcome_ledger: { total: 0 },
  };
  if (!existsSync(evidencePath)) return empty;
  try {
    const db = new Database(evidencePath, { readonly: true, fileMustExist: true });
    try {
      return {
        file_evidence: countByKind(db, 'file_evidence'),
        project_evidence: countByKind(db, 'project_evidence'),
        semantic_callees: { total: countRows(db, 'semantic_callees') },
        semantic_references: { total: countRows(db, 'semantic_references') },
        finding_outcome_ledger: { total: countRows(db, 'finding_outcome_ledger') },
      };
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
}

function countByKind(db, table) {
  if (!tableExists(db, table)) return {};
  const rows = db.prepare(`SELECT kind, COUNT(*) AS count FROM ${table} GROUP BY kind`).all();
  return Object.fromEntries(rows.map((row) => [row.kind, row.count]));
}

function countRows(db, table) {
  if (!tableExists(db, table)) return 0;
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function runCli(deps, cliPath, repoPath, command, profilePath, profile, cacheState) {
  const started = performance.now();
  const result = deps.spawnSync(process.execPath, [cliPath, ...command], {
    cwd: repoPath,
    env: profile
      ? {
          ...process.env,
          SCIP_QUERY_PROFILE: '1',
          SCIP_QUERY_PROFILE_COMMAND: `scip-query ${command.join(' ')}`,
          SCIP_QUERY_PROFILE_CACHE_STATE: cacheState,
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

function gitOutput(deps, cwd, args) {
  const result = deps.spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function clearEvidence(deps, evidencePath) {
  for (const path of [evidencePath, `${evidencePath}-wal`, `${evidencePath}-shm`]) {
    if (deps.existsSync(path)) deps.rmSync(path, { force: true });
  }
}

function splitCommand(value) {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((part, index) => !(index === 0 && part === 'scip-query'));
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

function nonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function requiredValue(value, flag) {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function defaultDeps() {
  return { appendFileSync, existsSync, mkdirSync, rmSync, spawnSync };
}
