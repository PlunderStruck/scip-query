import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DIFF_GATE_CHECKS, diffGate, type DiffGateCheck, type DiffGateResult } from '../queries/impact/diff-gate.js';
import type { ScipDatabase } from '../storage/db.js';
import { tryAcquireProcessFileLock, type ProcessFileLockObservation } from '../platform/process-file-lock.js';
import { runIsolatedJsonProcess } from './isolated-analysis-runner.js';
import { commandAnalysisBudget, type AnalysisBudgetDisclosure } from './cli-support.js';
import { recordDiffGateOutcomes, type DiffGateOutcomeResult } from './diff-gate-outcomes.js';

export const DIFF_GATE_RUN_COMMAND = '__diff-gate-run';
export const DIFF_GATE_REQUEST_ENV = 'SCIP_QUERY_DIFF_GATE_REQUEST';
export const DIFF_GATE_TIMEOUT_ENV = 'SCIP_QUERY_DIFF_GATE_TIMEOUT_MS';
export const DEFAULT_DIFF_GATE_TIMEOUT_MS = 60_000;
export const DEFAULT_FULL_DIFF_GATE_TIMEOUT_MS = 180_000;
export const MAX_DIFF_GATE_TIMEOUT_MS = 600_000;

export interface DiffGateExecutionRequest {
  base?: string;
  minTogether: number;
  maxEchoChecks?: number;
  maxHelpers?: number;
  includeBaseline: boolean;
  includeOutcomeLedger: boolean;
  full: boolean;
  skip: DiffGateCheck[];
}

export type IsolatedDiffGateOutcomes = Omit<DiffGateOutcomeResult, 'ledger'> & {
  ledger?: DiffGateOutcomeResult['ledger'];
};

export interface DiffGateExecutionResult {
  result: DiffGateResult;
  outcomes: IsolatedDiffGateOutcomes;
  analysisBudget?: AnalysisBudgetDisclosure;
}

export interface IsolatedDiffGateOptions {
  projectRoot: string;
  cacheDir: string;
  cliPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class DiffGateBusyError extends Error {
  readonly code = 'SCIP_QUERY_DIFF_GATE_BUSY';

  constructor(
    readonly lockPath: string,
    readonly observation: ProcessFileLockObservation,
  ) {
    const owner = observation.owner;
    const startedAt = observation.record?.startedAt;
    super(
      `another diff-gate is already running${owner ? ` (PID ${owner.pid})` : ''}${
        startedAt ? ` since ${startedAt}` : ''
      }; wait for that gate to finish instead of starting a duplicate`,
    );
    this.name = 'DiffGateBusyError';
  }
}

/**
 * Execute current-diff policy and secondary outcome bookkeeping in the same
 * isolated child. The parent owns the wall-clock deadline for both.
 */
export function executeDiffGate(db: ScipDatabase, request: DiffGateExecutionRequest): DiffGateExecutionResult {
  const budget = commandAnalysisBudget(db, 'diff-gate', request.full, { quiet: true });
  const gateOptions = {
    base: request.base,
    minTogether: request.minTogether,
    maxEchoChecks: request.maxEchoChecks,
    maxHelpers: request.maxHelpers,
    includeBaseline: request.includeBaseline,
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
    historyMode: request.full ? ('full' as const) : ('bounded' as const),
    skip: request.skip,
  };
  const result = diffGate(db, gateOptions);
  const outcomes = recordDiffGateOutcomes(db, result, {
    replayGate: (baseCommit, checks) => {
      const required = new Set(checks);
      return diffGate(db, {
        ...gateOptions,
        base: baseCommit,
        includeBaseline: required.has('baseline'),
        skip: DIFF_GATE_CHECKS.filter((check) => !required.has(check)),
      });
    },
  });
  return {
    result,
    outcomes: {
      observed: outcomes.observed,
      now: outcomes.now,
      ...(outcomes.warning ? { warning: outcomes.warning } : {}),
      ...(request.includeOutcomeLedger ? { ledger: outcomes.ledger } : {}),
    },
    ...(budget.analysisBudget ? { analysisBudget: budget.analysisBudget } : {}),
  };
}

/** Parse and validate the private child request before it reaches policy code. */
export function parseDiffGateExecutionRequest(raw: string | undefined): DiffGateExecutionRequest {
  if (!raw) throw new Error(`${DIFF_GATE_REQUEST_ENV} is required for ${DIFF_GATE_RUN_COMMAND}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${DIFF_GATE_REQUEST_ENV} is not valid JSON.`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${DIFF_GATE_REQUEST_ENV} must contain an object.`);
  }
  const request = parsed as Partial<DiffGateExecutionRequest>;
  if (
    (request.base !== undefined && typeof request.base !== 'string') ||
    !positiveFinite(request.minTogether) ||
    (request.maxEchoChecks !== undefined && !nonNegativeFinite(request.maxEchoChecks)) ||
    (request.maxHelpers !== undefined && !nonNegativeFinite(request.maxHelpers)) ||
    typeof request.includeBaseline !== 'boolean' ||
    typeof request.includeOutcomeLedger !== 'boolean' ||
    typeof request.full !== 'boolean' ||
    !Array.isArray(request.skip) ||
    request.skip.some((check) => !DIFF_GATE_CHECKS.includes(check))
  ) {
    throw new Error(`${DIFF_GATE_REQUEST_ENV} contains invalid diff-gate options.`);
  }
  return {
    ...(request.base === undefined ? {} : { base: request.base }),
    minTogether: request.minTogether,
    ...(request.maxEchoChecks === undefined ? {} : { maxEchoChecks: request.maxEchoChecks }),
    ...(request.maxHelpers === undefined ? {} : { maxHelpers: request.maxHelpers }),
    includeBaseline: request.includeBaseline,
    includeOutcomeLedger: request.includeOutcomeLedger,
    full: request.full,
    skip: [...request.skip],
  };
}

/**
 * Run one gate under a per-project lease and in a child whose lifetime the
 * parent can enforce even when the analysis thread never yields.
 */
export function runIsolatedDiffGate(
  request: DiffGateExecutionRequest,
  options: IsolatedDiffGateOptions,
): DiffGateExecutionResult {
  const lockPath = join(options.cacheDir, 'runtime', 'diff-gate.lock');
  return withDiffGateLease(lockPath, options.projectRoot, () =>
    runIsolatedJsonProcess<DiffGateExecutionResult>({
      cliPath: options.cliPath ?? process.argv[1] ?? fileURLToPath(import.meta.url),
      command: DIFF_GATE_RUN_COMMAND,
      args: ['--json'],
      env: {
        ...(options.env ?? process.env),
        SCIP_QUERY_PROJECT_ROOT: options.projectRoot,
        [DIFF_GATE_REQUEST_ENV]: JSON.stringify(request),
      },
      label: 'diff-gate',
      timeoutMs: options.timeoutMs ?? diffGateTimeoutMs(request.full, options.env ?? process.env),
      maxBuffer: 50 * 1024 * 1024,
    }),
  );
}

export function withDiffGateLease<T>(lockPath: string, projectRoot: string, run: () => T): T {
  const acquisition = tryAcquireProcessFileLock(lockPath, {
    kind: 'diff-gate',
    detail: { projectRoot },
  });
  if (acquisition.kind === 'contended') {
    throw new DiffGateBusyError(lockPath, acquisition.observation);
  }
  try {
    return run();
  } finally {
    acquisition.lock.release();
  }
}

export function diffGateTimeoutMs(full: boolean, env: NodeJS.ProcessEnv = process.env): number {
  const fallback = full ? DEFAULT_FULL_DIFF_GATE_TIMEOUT_MS : DEFAULT_DIFF_GATE_TIMEOUT_MS;
  const raw = env[DIFF_GATE_TIMEOUT_ENV];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_DIFF_GATE_TIMEOUT_MS);
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
