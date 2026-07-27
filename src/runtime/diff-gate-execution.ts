import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIFF_GATE_CHECKS, diffGate, type DiffGateCheck, type DiffGateResult } from '../queries/impact/diff-gate.js';
import { withDiffGateProgressObserver, type DiffGateProgressObserver } from '../queries/internal/diff-gate-progress.js';
import { isRecordObject } from '../domain/record-validation.js';
import { readSmallArtifactText } from '../filesystem/bounded-file.js';
import type { ScipDatabase } from '../storage/db.js';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import { tryAcquireProcessFileLock, type ProcessFileLockObservation } from '../platform/process-file-lock.js';
import { IsolatedProcessTimeoutError, runIsolatedJsonProcess } from './isolated-analysis-runner.js';
import { commandAnalysisBudget, type AnalysisBudgetDisclosure } from './cli-support.js';
import { recordDiffGateOutcomes, type DiffGateOutcomeResult } from './diff-gate-outcomes.js';

export const DIFF_GATE_RUN_COMMAND = '__diff-gate-run';
export const DIFF_GATE_REQUEST_ENV = 'SCIP_QUERY_DIFF_GATE_REQUEST';
export const DIFF_GATE_TIMEOUT_ENV = 'SCIP_QUERY_DIFF_GATE_TIMEOUT_MS';
export const DIFF_GATE_PROGRESS_PATH_ENV = 'SCIP_QUERY_DIFF_GATE_PROGRESS_PATH';
export const DIFF_GATE_PROGRESS_TOKEN_ENV = 'SCIP_QUERY_DIFF_GATE_PROGRESS_TOKEN';
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

export interface DiffGateProgressRecord {
  schemaVersion: 1;
  token: string;
  stage: 'initializing' | 'current-gate' | 'outcome-ledger' | 'replay-gate' | 'complete';
  activeCheck?: DiffGateCheck;
  lastCompletedCheck?: DiffGateCheck;
  replayBase?: string;
  updatedAt: string;
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

export class DiffGateDetectorTimeoutError extends IsolatedProcessTimeoutError {
  constructor(
    timeoutMs: number,
    readonly progress?: DiffGateProgressRecord,
    reaped = true,
  ) {
    super('diff-gate', timeoutMs, reaped);
    const active = progress?.activeCheck
      ? ` Active detector: ${progress.activeCheck} (${progress.stage}).`
      : progress
        ? ` Active phase: ${progress.stage}.`
        : ' No detector progress record was available.';
    const completed = progress?.lastCompletedCheck ? ` Last completed detector: ${progress.lastCompletedCheck}.` : '';
    this.message = `diff-gate timed out after ${timeoutMs}ms.${active}${completed}`;
    this.name = 'DiffGateDetectorTimeoutError';
  }
}

/**
 * Execute current-diff policy and secondary outcome bookkeeping in the same
 * isolated child. The parent owns the wall-clock deadline for both.
 */
export function executeDiffGate(db: ScipDatabase, request: DiffGateExecutionRequest): DiffGateExecutionResult {
  const budget = commandAnalysisBudget(db, 'diff-gate', request.full, { quiet: true });
  const progress = createDiffGateProgressReporter(process.env);
  progress.stage('current-gate');
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
  const result = withDiffGateProgressObserver(progress.observer('current-gate'), () => diffGate(db, gateOptions));
  progress.stage('outcome-ledger');
  const outcomes = recordDiffGateOutcomes(db, result, {
    replayGate: (baseCommit, checks) => {
      const required = new Set(checks);
      progress.stage('replay-gate', baseCommit);
      return withDiffGateProgressObserver(progress.observer('replay-gate', baseCommit), () =>
        diffGate(db, {
          ...gateOptions,
          base: baseCommit,
          includeBaseline: required.has('baseline'),
          skip: DIFF_GATE_CHECKS.filter((check) => !required.has(check)),
        }),
      );
    },
  });
  progress.stage('complete');
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
  return withDiffGateLease(lockPath, options.projectRoot, () => {
    const progressToken = randomUUID();
    const progressPath = join(options.cacheDir, 'runtime', `diff-gate-progress-${progressToken}.json`);
    const timeoutMs = options.timeoutMs ?? diffGateTimeoutMs(request.full, options.env ?? process.env);
    try {
      writeDiffGateProgress(progressPath, {
        schemaVersion: 1,
        token: progressToken,
        stage: 'initializing',
        updatedAt: new Date().toISOString(),
      });
      return runIsolatedJsonProcess<DiffGateExecutionResult>({
        cliPath: options.cliPath ?? process.argv[1] ?? fileURLToPath(import.meta.url),
        command: DIFF_GATE_RUN_COMMAND,
        args: ['--json'],
        env: {
          ...(options.env ?? process.env),
          SCIP_QUERY_PROJECT_ROOT: options.projectRoot,
          [DIFF_GATE_REQUEST_ENV]: JSON.stringify(request),
          [DIFF_GATE_PROGRESS_PATH_ENV]: progressPath,
          [DIFF_GATE_PROGRESS_TOKEN_ENV]: progressToken,
        },
        label: 'diff-gate',
        timeoutMs,
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (error) {
      if (error instanceof IsolatedProcessTimeoutError) {
        throw new DiffGateDetectorTimeoutError(
          timeoutMs,
          readDiffGateProgress(progressPath, progressToken),
          error.reaped,
        );
      }
      throw error;
    } finally {
      try {
        unlinkSync(progressPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Progress is diagnostic-only; cleanup failure must not mask the gate result.
        }
      }
    }
  });
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

function createDiffGateProgressReporter(env: NodeJS.ProcessEnv): {
  stage(stage: DiffGateProgressRecord['stage'], replayBase?: string): void;
  observer(stage: 'current-gate' | 'replay-gate', replayBase?: string): DiffGateProgressObserver;
} {
  const progressPath = env[DIFF_GATE_PROGRESS_PATH_ENV];
  const token = env[DIFF_GATE_PROGRESS_TOKEN_ENV];
  let record: DiffGateProgressRecord | undefined =
    progressPath && token
      ? {
          schemaVersion: 1,
          token,
          stage: 'initializing',
          updatedAt: new Date().toISOString(),
        }
      : undefined;
  const publish = (patch: Partial<DiffGateProgressRecord>): void => {
    if (!progressPath || !record) return;
    record = { ...record, ...patch, updatedAt: new Date().toISOString() };
    writeDiffGateProgress(progressPath, record);
  };
  return {
    stage: (stage, replayBase) =>
      publish({
        stage,
        activeCheck: undefined,
        ...(replayBase ? { replayBase } : { replayBase: undefined }),
      }),
    observer: (stage, replayBase) => ({
      onCheckStart: (activeCheck) => publish({ stage, activeCheck, replayBase }),
      onCheckComplete: (lastCompletedCheck) =>
        publish({ stage, activeCheck: undefined, lastCompletedCheck, replayBase }),
    }),
  };
}

function writeDiffGateProgress(path: string, record: DiffGateProgressRecord): void {
  try {
    writeJsonAtomic(path, record, { spacing: 2, trailingNewline: true });
  } catch {
    // The gate remains authoritative; progress only enriches a later timeout.
  }
}

function readDiffGateProgress(path: string, token: string): DiffGateProgressRecord | undefined {
  try {
    const value: unknown = JSON.parse(readSmallArtifactText(path, 'diff-gate progress record'));
    if (
      !isRecordObject(value) ||
      value['schemaVersion'] !== 1 ||
      value['token'] !== token ||
      typeof value['stage'] !== 'string' ||
      typeof value['updatedAt'] !== 'string'
    ) {
      return undefined;
    }
    const stage = value['stage'];
    if (!['initializing', 'current-gate', 'outcome-ledger', 'replay-gate', 'complete'].includes(stage)) {
      return undefined;
    }
    const activeCheck = value['activeCheck'];
    const lastCompletedCheck = value['lastCompletedCheck'];
    if (
      (activeCheck !== undefined && !DIFF_GATE_CHECKS.includes(activeCheck as DiffGateCheck)) ||
      (lastCompletedCheck !== undefined && !DIFF_GATE_CHECKS.includes(lastCompletedCheck as DiffGateCheck)) ||
      (value['replayBase'] !== undefined && typeof value['replayBase'] !== 'string')
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      token,
      stage: stage as DiffGateProgressRecord['stage'],
      ...(activeCheck === undefined ? {} : { activeCheck: activeCheck as DiffGateCheck }),
      ...(lastCompletedCheck === undefined ? {} : { lastCompletedCheck: lastCompletedCheck as DiffGateCheck }),
      ...(value['replayBase'] === undefined ? {} : { replayBase: value['replayBase'] }),
      updatedAt: value['updatedAt'],
    };
  } catch {
    return undefined;
  }
}
