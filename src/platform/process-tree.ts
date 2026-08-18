import { execFileSync } from 'node:child_process';
import { platform as hostPlatform } from 'node:os';
import { readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from './process-identity.js';

const PROCESS_LIST_TIMEOUT_MS = 1_000;
const PROCESS_LIST_MAX_BYTES = 2 * 1024 * 1024;
const TERMINATION_POLL_MS = 25;

export type ProcessTreeTerminationReason =
  | 'terminated'
  | 'identity-unavailable'
  | 'identity-mismatch'
  | 'signal-failed'
  | 'deadline';

export interface ProcessTreeTerminationResult {
  reaped: boolean;
  reason: ProcessTreeTerminationReason;
  detail?: string;
}

export interface ProcessTreeMemorySample {
  rssBytes: number;
  processCount: number;
}

// scip-query: ignore-stale -- Capability port isolates platform-specific process-tree effects for testing.
export interface ProcessTreeRuntime {
  platform: NodeJS.Platform;
  now(): number;
  readIdentity(pid: number): ProcessIdentity | null;
  isProcessAlive(pid: number): boolean;
  isProcessGroupAlive(rootPid: number): boolean;
  listDescendantPids(rootPid: number): readonly number[];
  signal(pid: number, signal: NodeJS.Signals | 0): void;
  terminateWindowsTree(pid: number): void;
  sleep(ms: number): Promise<void>;
}

// scip-query: ignore-stale -- Ownership handle preserves the identity and lifecycle of a managed process tree.
export interface OwnedProcessTree {
  readonly rootPid: number;
  readonly rootIdentity: ProcessIdentity | null;
  readonly ownsProcessGroup: boolean;
  readonly knownMembers: Map<number, ProcessIdentity>;
}

export interface TerminateOwnedProcessTreeOptions {
  gracefulMs: number;
  forceMs: number;
}

export function createOwnedProcessTree(
  rootPid: number,
  ownsProcessGroup: boolean,
  runtime: ProcessTreeRuntime = DEFAULT_PROCESS_TREE_RUNTIME,
): OwnedProcessTree {
  const rootIdentity = runtime.readIdentity(rootPid);
  const knownMembers = new Map<number, ProcessIdentity>();
  if (rootIdentity) knownMembers.set(rootPid, rootIdentity);
  return { rootPid, rootIdentity, ownsProcessGroup, knownMembers };
}

/**
 * Samples the resident memory held by a POSIX process and all descendants that
 * exist in the same process-table snapshot. Returns null when the platform or
 * process table cannot provide complete tree coverage.
 */
export function sampleProcessTreeMemory(rootPid: number = process.pid): ProcessTreeMemorySample | null {
  if (hostPlatform() === 'win32') return null;
  try {
    const output = readPosixProcessTable(true);
    return parsePosixProcessTreeMemory(output, rootPid);
  } catch {
    return null;
  }
}

export function parsePosixProcessTreeMemory(output: string, rootPid: number): ProcessTreeMemorySample | null {
  const childrenByParent = new Map<number, number[]>();
  const rssByPid = new Map<number, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const rssKiB = Number(match[3]);
    rssByPid.set(pid, rssKiB);
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  if (!rssByPid.has(rootPid)) return null;

  let rssKiB = 0;
  const pending = [rootPid];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    rssKiB += rssByPid.get(pid) ?? 0;
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return { rssBytes: rssKiB * 1024, processCount: seen.size };
}

export async function terminateOwnedProcessTree(
  tree: OwnedProcessTree,
  options: TerminateOwnedProcessTreeOptions,
  runtime: ProcessTreeRuntime = DEFAULT_PROCESS_TREE_RUNTIME,
): Promise<ProcessTreeTerminationResult> {
  if (!tree.rootIdentity) {
    const reaped = await waitForTreeExit(tree, options.gracefulMs + options.forceMs, runtime);
    return {
      reaped,
      reason: reaped ? 'terminated' : 'identity-unavailable',
      detail: reaped ? undefined : `Could not establish the birth identity of process ${tree.rootPid}.`,
    };
  }

  const rootState = refreshKnownMembers(tree, runtime);
  if (rootState === 'mismatch') {
    return {
      reaped: false,
      reason: 'identity-mismatch',
      detail: `Process ${tree.rootPid} no longer has the identity owned by this runner.`,
    };
  }
  if (rootState === 'exited' && !treeIsAlive(tree, runtime)) {
    return { reaped: true, reason: 'terminated' };
  }

  if (runtime.platform === 'win32') {
    try {
      // Windows does not expose POSIX process-group signals. taskkill /T /F is
      // the finite tree primitive, so use it only after revalidating the root.
      runtime.terminateWindowsTree(tree.rootPid);
    } catch (error) {
      const reaped = await waitForTreeExit(tree, options.forceMs, runtime);
      return {
        reaped,
        reason: reaped ? 'terminated' : 'signal-failed',
        detail: reaped ? undefined : errorMessage(error),
      };
    }
    const reaped = await waitForTreeExit(tree, options.forceMs, runtime);
    return { reaped, reason: reaped ? 'terminated' : 'deadline' };
  }

  const gracefulSignal = signalKnownTree(tree, 'SIGTERM', runtime);
  const gracefullyReaped = await waitForTreeExit(tree, options.gracefulMs, runtime);
  if (gracefullyReaped) return { reaped: true, reason: 'terminated' };

  const forceSignal = signalKnownTree(tree, 'SIGKILL', runtime);
  const reaped = await waitForTreeExit(tree, options.forceMs, runtime);
  if (reaped) return { reaped: true, reason: 'terminated' };
  if (forceSignal) {
    return { reaped: false, reason: forceSignal.reason, detail: forceSignal.detail };
  }
  if (gracefulSignal) {
    return { reaped: false, reason: gracefulSignal.reason, detail: gracefulSignal.detail };
  }
  return {
    reaped: false,
    reason: 'deadline',
    detail: `Process tree ${tree.rootPid} did not exit before its termination deadline.`,
  };
}

type RootState = 'owned' | 'exited' | 'mismatch';

function refreshKnownMembers(tree: OwnedProcessTree, runtime: ProcessTreeRuntime): RootState {
  const currentRoot = runtime.readIdentity(tree.rootPid);
  if (!currentRoot) return 'exited';
  if (!tree.rootIdentity || !sameProcessIdentity(tree.rootIdentity, currentRoot)) return 'mismatch';

  tree.knownMembers.set(tree.rootPid, currentRoot);
  for (const pid of runtime.listDescendantPids(tree.rootPid)) {
    const identity = runtime.readIdentity(pid);
    if (identity) tree.knownMembers.set(pid, identity);
  }
  return 'owned';
}

function signalKnownTree(
  tree: OwnedProcessTree,
  signal: NodeJS.Signals,
  runtime: ProcessTreeRuntime,
): { reason: 'identity-mismatch' | 'signal-failed'; detail: string } | null {
  const rootState = refreshKnownMembers(tree, runtime);
  if (rootState === 'mismatch') {
    return {
      reason: 'identity-mismatch',
      detail: `Process ${tree.rootPid} changed identity before ${signal}.`,
    };
  }

  if (rootState === 'owned' && tree.ownsProcessGroup) {
    try {
      runtime.signal(-tree.rootPid, signal);
      return null;
    } catch (error) {
      if (!isMissingProcessError(error)) {
        return { reason: 'signal-failed', detail: errorMessage(error) };
      }
    }
  }

  let firstFailure: string | null = null;
  for (const identity of tree.knownMembers.values()) {
    const current = runtime.readIdentity(identity.pid);
    if (!current || !sameProcessIdentity(identity, current)) continue;
    try {
      runtime.signal(identity.pid, signal);
    } catch (error) {
      if (!isMissingProcessError(error) && firstFailure === null) {
        firstFailure = errorMessage(error);
      }
    }
  }
  return firstFailure === null ? null : { reason: 'signal-failed', detail: firstFailure };
}

async function waitForTreeExit(
  tree: OwnedProcessTree,
  timeoutMs: number,
  runtime: ProcessTreeRuntime,
): Promise<boolean> {
  const deadline = runtime.now() + timeoutMs;
  while (treeIsAlive(tree, runtime)) {
    if (runtime.now() >= deadline) return false;
    await runtime.sleep(Math.min(TERMINATION_POLL_MS, Math.max(1, deadline - runtime.now())));
  }
  return true;
}

function treeIsAlive(tree: OwnedProcessTree, runtime: ProcessTreeRuntime): boolean {
  if (!tree.rootIdentity && runtime.isProcessAlive(tree.rootPid)) return true;
  for (const identity of tree.knownMembers.values()) {
    const current = runtime.readIdentity(identity.pid);
    if (current && sameProcessIdentity(identity, current)) return true;
  }
  if (tree.ownsProcessGroup && runtime.isProcessGroupAlive(tree.rootPid)) return true;
  return false;
}

function listPosixDescendantPids(rootPid: number): readonly number[] {
  const output = readPosixProcessTable(false);
  const childrenByParent = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }

  const descendants: number[] = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    descendants.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function readPosixProcessTable(includeRss: boolean): string {
  return execFileSync('ps', ['-axo', includeRss ? 'pid=,ppid=,rss=' : 'pid=,ppid='], {
    encoding: 'utf8',
    timeout: PROCESS_LIST_TIMEOUT_MS,
    maxBuffer: PROCESS_LIST_MAX_BYTES,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function isMissingProcessError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_PROCESS_TREE_RUNTIME: ProcessTreeRuntime = {
  platform: hostPlatform(),
  now: Date.now,
  readIdentity: readProcessIdentity,
  isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EPERM'
      );
    }
  },
  isProcessGroupAlive(rootPid) {
    if (this.platform === 'win32') return false;
    try {
      process.kill(-rootPid, 0);
      return true;
    } catch (error) {
      return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EPERM'
      );
    }
  },
  listDescendantPids(rootPid) {
    if (this.platform === 'win32') return [];
    try {
      return listPosixDescendantPids(rootPid);
    } catch {
      return [];
    }
  },
  signal(pid, signal) {
    process.kill(pid, signal);
  },
  terminateWindowsTree(pid) {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      timeout: PROCESS_LIST_TIMEOUT_MS,
      maxBuffer: PROCESS_LIST_MAX_BYTES,
      stdio: 'ignore',
      windowsHide: true,
    });
  },
  async sleep(ms) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  },
};
