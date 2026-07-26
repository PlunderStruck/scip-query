import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from './process-identity.js';

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
  maxStdoutBytes: number;
  maxStderrBytes: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  signal?: AbortSignal;
  detached?: boolean;
  outputLimitBehavior?: 'terminate' | 'truncate-tail';
}

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

function shouldEscalate(child: ChildProcessWithoutNullStreams, identity: ProcessIdentity | null): boolean {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return false;
  }
  if (!identity) {
    // This is a child handle created and retained by this runner. When a platform
    // cannot expose a start token, the still-live ChildProcess is the strongest
    // ownership evidence available.
    return true;
  }
  const currentIdentity = readProcessIdentity(child.pid);
  return currentIdentity !== null && sameProcessIdentity(identity, currentIdentity);
}

/**
 * Run one finite child process while continuously draining both output streams.
 *
 * A timeout or output-budget violation initiates TERM, escalates to KILL after
 * the grace interval, and rejects only after the child emits `close`. Therefore
 * a settled promise also certifies that the child has been reaped.
 */
export function runBoundedProcess(opts: BoundedProcessOptions): Promise<BoundedProcessResult> {
  validatePositiveBudget(opts.timeoutMs, 'timeoutMs');
  validatePositiveBudget(opts.maxStdoutBytes, 'maxStdoutBytes');
  validatePositiveBudget(opts.maxStderrBytes, 'maxStderrBytes');
  const terminationGraceMs = opts.terminationGraceMs ?? 1_000;
  validatePositiveBudget(terminationGraceMs, 'terminationGraceMs');

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let child: ChildProcessWithoutNullStreams;
    try {
      // scip-query: process-lifetime-reviewed -- this central runner owns the
      // deadline, bounded drains, TERM-to-KILL escalation, and close/reap wait.
      child = spawn(opts.command, [...(opts.args ?? [])], {
        cwd: opts.cwd,
        env: opts.env,
        detached: opts.detached,
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
    let closed = false;
    let killTimer: NodeJS.Timeout | null = null;
    const identity = child.pid === undefined ? null : readProcessIdentity(child.pid);

    const beginTermination = (nextFailure: PendingFailure): void => {
      if (failure || closed) return;
      failure = nextFailure;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!closed && shouldEscalate(child, identity)) {
          child.kill('SIGKILL');
        }
      }, terminationGraceMs);
      killTimer.unref();
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
      if (closed) return;
      if (failure) return;
      if (child.pid === undefined) {
        clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        opts.signal?.removeEventListener('abort', abortListener);
        closed = true;
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
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', abortListener);
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (failure) {
        reject(
          new BoundedProcessError(failure.kind, opts.label, failure.message, {
            timedOut: failure.timedOut,
            reaped: true,
            stdout: stdoutText,
            stderr: stderrText,
            stdoutTruncated,
            stderrTruncated,
          }),
        );
        return;
      }
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
