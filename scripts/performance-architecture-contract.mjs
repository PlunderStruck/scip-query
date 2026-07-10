#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  const profilePath = resolve(
    args.profileOut ?? join(dirname(runHistoryPath), `2026-07-02-performance-architecture.${Date.now()}.profile.jsonl`),
  );

  deps.mkdirSync(dirname(runHistoryPath), { recursive: true });
  deps.mkdirSync(dirname(profilePath), { recursive: true });

  if (args.cacheState === 'retro-gate') {
    runRetroGate(args, deps, cliPath, runHistoryPath, profilePath);
    return;
  }

  const status = runCli(deps, cliPath, repoPath, ['status', '--json'], profilePath, false, args.cacheState);
  if (status.exitCode !== 0) {
    process.stderr.write(status.stderr.toString());
    process.exit(status.exitCode ?? 1);
  }
  const statusJson = JSON.parse(status.stdout.toString());
  const dbPath = statusJson.result?.dbPath;
  if (typeof dbPath !== 'string') throw new Error('status --json did not include result.dbPath');

  const cacheDir = dirname(dbPath);
  const evidencePath = join(cacheDir, 'evidence.db');
  const metaPath = join(cacheDir, 'meta.json');
  const beforeIndexBytes = fileSize(dbPath);
  const beforeEvidenceBytes = fileSize(evidencePath);
  if (!args.noClear && args.cacheState === 'cold-index') {
    clearIndex(deps, dbPath, metaPath);
    clearHealthReportCache(deps, cacheDir);
  }
  if (!args.noClear && args.cacheState === 'evidence-cold') {
    clearEvidence(deps, evidencePath);
    clearHealthReportCache(deps, cacheDir);
  }

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
      label: args.label,
      runId,
      iteration,
      dbPath,
      evidencePath,
      beforeIndexBytes,
      beforeEvidenceBytes,
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
  let cacheStateExplicit = false;
  const parsed = {
    repo: '.',
    command: 'health --json',
    warmIterations: 1,
    noClear: false,
    cacheState: 'evidence-cold',
    label: 'measurement',
    out: undefined,
    profileOut: undefined,
    cli: undefined,
    retroCount: 5,
    retroDryRun: false,
    retroWorktreeRoot: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') parsed.repo = requiredValue(argv[++index], arg);
    else if (arg === '--command') parsed.command = requiredValue(argv[++index], arg);
    else if (arg === '--warm-iterations') parsed.warmIterations = nonNegativeInteger(argv[++index], arg);
    else if (arg === '--no-clear') {
      parsed.noClear = true;
    } else if (arg === '--cache-state') {
      parsed.cacheState = requiredValue(argv[++index], arg);
      cacheStateExplicit = true;
    } else if (arg === '--label') parsed.label = requiredValue(argv[++index], arg);
    else if (arg === '--out') parsed.out = requiredValue(argv[++index], arg);
    else if (arg === '--profile-out') parsed.profileOut = requiredValue(argv[++index], arg);
    else if (arg === '--cli') parsed.cli = requiredValue(argv[++index], arg);
    else if (arg === '--retro-count') parsed.retroCount = nonNegativeInteger(argv[++index], arg);
    else if (arg === '--retro-dry-run') parsed.retroDryRun = true;
    else if (arg === '--retro-worktree-root') parsed.retroWorktreeRoot = requiredValue(argv[++index], arg);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (parsed.noClear && !cacheStateExplicit) parsed.cacheState = 'evidence-warm';
  return parsed;
}

function runRetroGate(args, deps, cliPath, runHistoryPath, profilePath) {
  const repoPath = resolve(args.repo);
  const commitOutput = gitOutput(deps, repoPath, ['rev-list', '--reverse', `--max-count=${args.retroCount}`, 'HEAD']);
  const commits = commitOutput ? commitOutput.split(/\r?\n/).filter(Boolean) : [];
  if (commits.length === 0) throw new Error('retro-gate replay found no commits');

  const createdWorktreeRoot = !args.retroWorktreeRoot && !args.retroDryRun;
  const worktreeRoot = resolve(
    args.retroWorktreeRoot ??
      (args.retroDryRun
        ? join(tmpdir(), 'scip-query-retro-gate-dry-run')
        : deps.mkdtempSync(join(tmpdir(), 'scip-query-retro-gate-'))),
  );
  const plan = buildRetroGatePlan({
    repoPath,
    commits,
    command: splitCommand(args.command),
    worktreeRoot,
  });

  if (args.retroDryRun) {
    process.stdout.write(`${JSON.stringify({ runHistoryPath, profilePath, dryRun: true, plan }, null, 2)}\n`);
    return;
  }

  deps.mkdirSync(worktreeRoot, { recursive: true });
  const runId = new Date().toISOString();
  const records = [];
  for (let iteration = 0; iteration < plan.length; iteration += 1) {
    const item = plan[iteration];
    const add = deps.spawnSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', item.worktreePath, item.commit],
      {
        cwd: repoPath,
        env: { ...process.env, HUSKY: '0' },
        encoding: 'buffer',
      },
    );
    if (add.status !== 0) {
      throw new Error(`git worktree add failed for ${item.commit}: ${(add.stderr ?? Buffer.alloc(0)).toString()}`);
    }

    try {
      const status = runCli(
        deps,
        cliPath,
        item.worktreePath,
        ['status', '--json'],
        profilePath,
        false,
        args.cacheState,
      );
      if (status.exitCode !== 0) {
        throw new Error(`status --json failed for ${item.commit}: ${status.stderr.toString()}`);
      }
      const statusJson = JSON.parse(status.stdout.toString());
      let dbPath = statusJson.result?.dbPath;
      if (typeof dbPath !== 'string') throw new Error('status --json did not include result.dbPath');

      let cacheDir = dirname(dbPath);
      let evidencePath = join(cacheDir, 'evidence.db');
      const beforeIndexBytes = fileSize(dbPath);
      const beforeEvidenceBytes = fileSize(evidencePath);
      const started = performance.now();
      const indexResult = runCli(deps, cliPath, item.worktreePath, ['reindex'], profilePath, true, args.cacheState);
      if (indexResult.exitCode === 0) {
        const postStatus = runCli(
          deps,
          cliPath,
          item.worktreePath,
          ['status', '--json'],
          profilePath,
          false,
          args.cacheState,
        );
        if (postStatus.exitCode === 0) {
          const postStatusJson = JSON.parse(postStatus.stdout.toString());
          if (typeof postStatusJson.result?.dbPath === 'string') {
            dbPath = postStatusJson.result.dbPath;
            cacheDir = dirname(dbPath);
            evidencePath = join(cacheDir, 'evidence.db');
          }
        }
      }
      const gateResult =
        indexResult.exitCode === 0
          ? runCli(deps, cliPath, item.worktreePath, item.command, profilePath, true, args.cacheState)
          : {
              durationMs: 0,
              exitCode: indexResult.exitCode,
              signal: indexResult.signal,
              error: indexResult.error,
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
            };
      const durationMs = Math.round(performance.now() - started);
      const record = {
        ...buildRunRecord({
          repoPath: item.worktreePath,
          gitHead: item.commit,
          dirty: false,
          command: item.command,
          cacheState: args.cacheState,
          label: args.label,
          runId,
          iteration: iteration + 1,
          dbPath,
          evidencePath,
          beforeIndexBytes,
          beforeEvidenceBytes,
          profilePath,
          result: {
            durationMs,
            exitCode: indexResult.exitCode === 0 ? gateResult.exitCode : indexResult.exitCode,
            signal: gateResult.signal ?? indexResult.signal,
            error: gateResult.error ?? indexResult.error,
            stdout: gateResult.stdout,
            stderr: Buffer.concat([indexResult.stderr, gateResult.stderr]),
          },
          evidenceRows: collectEvidenceRows(evidencePath),
          nowIso: new Date().toISOString(),
        }),
        retroCommit: item.commit,
        retroParent: item.parent,
        retroWorktreePath: item.worktreePath,
        indexDurationMs: indexResult.durationMs,
        gateDurationMs: gateResult.durationMs,
        indexExitCode: indexResult.exitCode,
        gateExitCode: gateResult.exitCode,
        indexStdoutSha256: sha256(indexResult.stdout),
        gateStdoutSha256: sha256(gateResult.stdout),
      };
      deps.appendFileSync(runHistoryPath, `${JSON.stringify(record)}\n`);
      records.push(record);
    } finally {
      deps.spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', '--force', item.worktreePath], {
        cwd: repoPath,
        env: { ...process.env, HUSKY: '0' },
        encoding: 'buffer',
      });
    }
  }

  if (createdWorktreeRoot) deps.rmSync(worktreeRoot, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ runId, runHistoryPath, profilePath, records }, null, 2)}\n`);
  if (records.some((record) => record.exitCode !== 0)) process.exit(1);
}

export function buildRetroGatePlan({ repoPath, commits, command, worktreeRoot }) {
  return commits.map((commit) => {
    const worktreePath = join(worktreeRoot, `retro-${commit.slice(0, 12)}`);
    const parent = `${commit}^`;
    return {
      repoPath,
      commit,
      parent,
      worktreePath,
      command: command.includes('--base') ? command : [...command, '--base', parent],
    };
  });
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
    label: input.label,
    iteration: input.iteration,
    durationMs: input.result.durationMs,
    exitCode: input.result.exitCode,
    signal: input.result.signal,
    error: input.result.error?.message,
    stdoutBytes: input.result.stdout.length,
    stderrBytes: input.result.stderr.length,
    stdoutSha256: sha256(input.result.stdout),
    beforeIndexBytes: input.beforeIndexBytes,
    beforeEvidenceBytes: input.beforeEvidenceBytes,
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

function clearIndex(deps, dbPath, metaPath) {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, metaPath]) {
    if (deps.existsSync(path)) deps.rmSync(path, { force: true });
  }
}

function clearHealthReportCache(deps, cacheDir) {
  const healthReportPath = join(cacheDir, 'health-report-cache.json');
  if (deps.existsSync(healthReportPath)) deps.rmSync(healthReportPath, { force: true });
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
  return { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, spawnSync };
}
