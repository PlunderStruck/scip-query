import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { TlaCheckerMode } from './model-contract.js';
import { binaryAvailable, type CommandAvailabilitySpawn } from '../runtime/command-availability.js';

export type TlaToolStatus = 'passed' | 'failed' | 'skipped' | 'timed-out';
export type TlaResolvedChecker = Exclude<TlaCheckerMode, 'auto'>;

export interface TlaToolDiagnostic {
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface TlaToolResult {
  checker: TlaResolvedChecker;
  status: TlaToolStatus;
  command: string[];
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  diagnostics: TlaToolDiagnostic[];
  stdout: string;
  stderr: string;
}

export interface TlaToolRunOptions {
  projectRoot: string;
  specPath: string;
  configPath?: string;
  checker: TlaCheckerMode;
  tlaToolsJar?: string;
  apalacheBin?: string;
  length?: number;
  timeoutMs?: number;
  metaDir?: string;
  spawn?: CommandAvailabilitySpawn;
}

interface ResolvedCommand {
  checker: TlaResolvedChecker;
  command: string[];
  cwd: string;
  missing?: string;
  cleanupPaths?: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function runTlaTool(opts: TlaToolRunOptions): TlaToolResult {
  const spawn = opts.spawn ?? spawnSync;
  const resolved = resolveTlaCommand(opts, spawn);
  if (resolved.missing) {
    return {
      checker: resolved.checker,
      status: 'skipped',
      command: resolved.command,
      durationMs: 0,
      exitCode: null,
      signal: null,
      timedOut: false,
      diagnostics: [{ severity: 'warning', message: resolved.missing }],
      stdout: '',
      stderr: '',
    };
  }

  const started = performance.now();
  let result: SpawnSyncReturns<string>;
  try {
    result = spawn(resolved.command[0]!, resolved.command.slice(1), {
      cwd: resolved.cwd,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 10,
    }) as SpawnSyncReturns<string>;
  } finally {
    for (const path of resolved.cleanupPaths ?? []) {
      rmSync(path, { recursive: true, force: true });
    }
  }
  const durationMs = Math.round(performance.now() - started);
  const timedOut = result.error?.name === 'ETIMEDOUT';
  const status: TlaToolStatus = timedOut ? 'timed-out' : result.status === 0 ? 'passed' : 'failed';
  return {
    checker: resolved.checker,
    status,
    command: resolved.command,
    durationMs,
    exitCode: result.status,
    signal: result.signal,
    timedOut,
    diagnostics: diagnosticsForRun(status, result.stdout ?? '', result.stderr ?? ''),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function resolveTlaCommand(opts: TlaToolRunOptions, spawn: CommandAvailabilitySpawn): ResolvedCommand {
  const requested = opts.checker;
  if (requested === 'none') {
    return {
      checker: 'none',
      command: ['<none>'],
      cwd: opts.projectRoot,
      missing: 'model checker skipped by --checker none',
    };
  }
  if (requested === 'apalache' || (requested === 'auto' && binaryAvailable(resolveApalacheBin(opts), spawn))) {
    const apalache = resolveApalacheBin(opts);
    if (!binaryAvailable(apalache, spawn)) {
      return missing('apalache', `Apalache binary is not available: ${apalache}`);
    }
    return {
      checker: 'apalache',
      command: [
        apalache,
        'check',
        ...(opts.configPath ? [`--config=${opts.configPath}`] : []),
        `--length=${opts.length ?? 10}`,
        opts.specPath,
      ],
      cwd: dirname(opts.specPath),
    };
  }

  const jar = resolveTlaToolsJar(opts);
  const javaAvailable = binaryAvailable('java', spawn);
  if (requested === 'sany' || requested === 'tlc' || requested === 'auto') {
    if (!jar) {
      const checker = requested === 'sany' ? 'sany' : 'tlc';
      return missing(checker, 'tla2tools.jar was not found; set --tla-tools or TLA_TOOLS_JAR');
    }
    if (!javaAvailable) {
      const checker = requested === 'sany' ? 'sany' : 'tlc';
      return missing(checker, 'java is not available on PATH');
    }
    const checker = requested === 'sany' ? 'sany' : requested === 'tlc' ? 'tlc' : opts.configPath ? 'tlc' : 'sany';
    if (checker === 'sany') {
      return {
        checker,
        command: ['java', '-cp', jar, 'tla2sany.SANY', opts.specPath],
        cwd: dirname(opts.specPath),
      };
    }
    const metaDir = opts.metaDir ?? mkdtempSync(join(tmpdir(), 'scip-tla-tlc-'));
    return {
      checker,
      command: [
        'java',
        '-cp',
        jar,
        'tlc2.TLC',
        '-metadir',
        metaDir,
        ...(opts.configPath ? ['-config', opts.configPath] : []),
        opts.specPath,
      ],
      cwd: dirname(opts.specPath),
      cleanupPaths: opts.metaDir ? [] : [metaDir],
    };
  }

  return missing('none', `unknown checker mode: ${requested}`);
}

function resolveApalacheBin(opts: TlaToolRunOptions): string {
  return opts.apalacheBin ?? process.env['APALACHE_BIN'] ?? 'apalache-mc';
}

function resolveTlaToolsJar(opts: TlaToolRunOptions): string | null {
  const candidates = [
    opts.tlaToolsJar,
    process.env['TLA_TOOLS_JAR'],
    join(opts.projectRoot, 'tla2tools.jar'),
    join(opts.projectRoot, 'tools', 'tla2tools.jar'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function diagnosticsForRun(status: TlaToolStatus, stdout: string, stderr: string): TlaToolDiagnostic[] {
  if (status === 'passed') return [{ severity: 'info', message: 'model checker completed successfully' }];
  if (status === 'timed-out') return [{ severity: 'error', message: 'model checker timed out' }];
  const lines = [...stderrLines(stderr), ...stderrLines(stdout)].slice(0, 20);
  if (lines.length === 0) return [{ severity: 'error', message: 'model checker failed without diagnostics' }];
  return lines.map((message) => ({ severity: 'error', message }));
}

function stderrLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function missing(checker: TlaResolvedChecker, message: string): ResolvedCommand {
  return { checker, command: ['<missing>'], cwd: process.cwd(), missing: message };
}
