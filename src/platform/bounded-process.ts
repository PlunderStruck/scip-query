import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { platform as hostPlatform } from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  createOwnedProcessTree,
  terminateOwnedProcessTree,
  type ProcessTreeTerminationResult,
} from './process-tree.js';

export const PROCESS_TIMEOUT_MS = {
  probe: 10_000,
  git: 30_000,
  analysis: 180_000,
  install: 300_000,
  indexer: 600_000,
} as const;

export interface BoundedProcessOptions {
  command: string;
  args?: readonly string[];
  label: string;
  timeoutMs: number;
  terminationGraceMs?: number;
  terminationForceMs?: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  signal?: AbortSignal;
  detached?: boolean;
  outputLimitBehavior?: 'terminate' | 'truncate-tail';
}

// scip-query: ignore-stale -- Explicit process result contract preserves timeout and truncation invariants.
export interface BoundedProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: false;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export type BoundedProcessFailureKind = 'spawn' | 'timeout' | 'aborted' | 'stdout-limit' | 'stderr-limit';

export class BoundedProcessError extends Error {
  readonly timedOut: boolean;
  readonly reaped: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;

  constructor(
    readonly kind: BoundedProcessFailureKind,
    readonly label: string,
    message: string,
    options: {
      timedOut?: boolean;
      reaped?: boolean;
      cause?: unknown;
      stdout?: string;
      stderr?: string;
      stdoutTruncated?: boolean;
      stderrTruncated?: boolean;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BoundedProcessError';
    this.timedOut = options.timedOut ?? false;
    this.reaped = options.reaped ?? false;
    this.stdout = options.stdout ?? '';
    this.stderr = options.stderr ?? '';
    this.stdoutTruncated = options.stdoutTruncated ?? false;
    this.stderrTruncated = options.stderrTruncated ?? false;
  }
}

interface PendingFailure {
  kind: BoundedProcessFailureKind;
  message: string;
  timedOut: boolean;
}

function validatePositiveBudget(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number.`);
  }
}

function appendBounded(chunks: Buffer[], chunk: Buffer, currentBytes: number, limit: number): void {
  const remaining = Math.max(0, limit - currentBytes);
  if (remaining > 0) {
    chunks.push(chunk.subarray(0, remaining));
  }
}

function appendTail(chunks: Buffer[], chunk: Buffer, limit: number): void {
  const combined = Buffer.concat([...chunks, chunk]);
  chunks.length = 0;
  chunks.push(combined.subarray(Math.max(0, combined.length - limit)));
}

/**
 * Run one finite child process while continuously draining both output streams.
 *
 * A timeout or output-budget violation initiates tree-wide TERM, escalates to
 * tree-wide KILL after the grace interval, and settles within the force
 * interval. A failure reports whether the owned process tree was reaped.
 */
export function runBoundedProcess(opts: BoundedProcessOptions): Promise<BoundedProcessResult> {
  validatePositiveBudget(opts.timeoutMs, 'timeoutMs');
  validatePositiveBudget(opts.maxStdoutBytes, 'maxStdoutBytes');
  validatePositiveBudget(opts.maxStderrBytes, 'maxStderrBytes');
  const terminationGraceMs = opts.terminationGraceMs ?? 1_000;
  validatePositiveBudget(terminationGraceMs, 'terminationGraceMs');
  const terminationForceMs = opts.terminationForceMs ?? terminationGraceMs;
  validatePositiveBudget(terminationForceMs, 'terminationForceMs');

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    // Watch reindex workers already lead a process group. Nested indexers must
    // stay in that group so cancel/stop can reap scip-typescript without
    // leaving PPID-1 children. CLI runs still detach so -pid cannot hit us.
    const inheritOwnedProcessGroup =
      hostPlatform() !== 'win32' && process.env['SCIP_REINDEX_PROCESS_GROUP_LEADER'] === '1';
    const ownsProcessGroup = hostPlatform() !== 'win32' && !inheritOwnedProcessGroup;
    let child: ChildProcessWithoutNullStreams;
    try {
      // scip-query: process-lifetime-reviewed -- this central runner owns the
      // deadline, bounded drains, TERM-to-KILL escalation, and close/reap wait.
      child = spawn(opts.command, [...(opts.args ?? [])], {
        cwd: opts.cwd,
        env: opts.env,
        detached: ownsProcessGroup ? true : opts.detached,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (cause) {
      reject(
        new BoundedProcessError('spawn', opts.label, `${opts.label} could not start.`, {
          cause,
          reaped: true,
        }),
      );
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let failure: PendingFailure | null = null;
    let settled = false;
    const tree = child.pid === undefined ? null : createOwnedProcessTree(child.pid, ownsProcessGroup);

    const clearLifecycle = (): void => {
      clearTimeout(deadline);
      opts.signal?.removeEventListener('abort', abortListener);
    };

    const rejectFailure = (termination: ProcessTreeTerminationResult): void => {
      if (settled || !failure) return;
      settled = true;
      clearLifecycle();
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      const suffix =
        termination.reaped || !termination.detail ? '' : ` Process-tree cleanup failed: ${termination.detail}`;
      reject(
        new BoundedProcessError(failure.kind, opts.label, `${failure.message}${suffix}`, {
          timedOut: failure.timedOut,
          reaped: termination.reaped,
          stdout: stdoutText,
          stderr: stderrText,
          stdoutTruncated,
          stderrTruncated,
        }),
      );
    };

    const beginTermination = (nextFailure: PendingFailure): void => {
      if (failure || settled) return;
      failure = nextFailure;
      if (!tree) {
        rejectFailure({
          reaped: child.pid === undefined,
          reason: child.pid === undefined ? 'terminated' : 'identity-unavailable',
        });
        return;
      }
      void terminateOwnedProcessTree(tree, {
        gracefulMs: terminationGraceMs,
        forceMs: terminationForceMs,
      }).then(rejectFailure, (cause: unknown) => {
        rejectFailure({
          reaped: false,
          reason: 'signal-failed',
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      });
    };

    const deadline = setTimeout(() => {
      beginTermination({
        kind: 'timeout',
        timedOut: true,
        message: `${opts.label} timed out after ${opts.timeoutMs}ms.`,
      });
    }, opts.timeoutMs);
    deadline.unref();
    const abortListener = (): void => {
      beginTermination({
        kind: 'aborted',
        timedOut: false,
        message: `${opts.label} was cancelled.`,
      });
    };
    opts.signal?.addEventListener('abort', abortListener, { once: true });
    if (opts.signal?.aborted) abortListener();

    child.stdout.on('data', (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (opts.outputLimitBehavior === 'truncate-tail') {
        appendTail(stdout, chunk, opts.maxStdoutBytes);
      } else {
        appendBounded(stdout, chunk, stdoutBytes, opts.maxStdoutBytes);
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > opts.maxStdoutBytes) {
        stdoutTruncated = true;
        if (opts.outputLimitBehavior !== 'truncate-tail') {
          beginTermination({
            kind: 'stdout-limit',
            timedOut: false,
            message: `${opts.label} exceeded stdout limit (${opts.maxStdoutBytes} bytes).`,
          });
        }
      }
    });
    child.stderr.on('data', (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (opts.outputLimitBehavior === 'truncate-tail') {
        appendTail(stderr, chunk, opts.maxStderrBytes);
      } else {
        appendBounded(stderr, chunk, stderrBytes, opts.maxStderrBytes);
      }
      stderrBytes += chunk.length;
      if (stderrBytes > opts.maxStderrBytes) {
        stderrTruncated = true;
        if (opts.outputLimitBehavior !== 'truncate-tail') {
          beginTermination({
            kind: 'stderr-limit',
            timedOut: false,
            message: `${opts.label} exceeded stderr limit (${opts.maxStderrBytes} bytes).`,
          });
        }
      }
    });

    child.on('error', (cause) => {
      if (settled) return;
      if (failure) return;
      if (child.pid === undefined) {
        clearLifecycle();
        settled = true;
        reject(
          new BoundedProcessError('spawn', opts.label, `${opts.label} could not start: ${cause.message}`, {
            cause,
            reaped: true,
          }),
        );
        return;
      }
      beginTermination({
        kind: 'spawn',
        timedOut: false,
        message: `${opts.label} failed after start: ${cause.message}`,
      });
    });

    child.on('close', (status, signal) => {
      if (settled || failure) return;
      settled = true;
      clearLifecycle();
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      resolve({
        status,
        signal,
        stdout: stdoutText,
        stderr: stderrText,
        timedOut: false,
        durationMs: performance.now() - startedAt,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    if (opts.input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(opts.input);
    }
  });
}
