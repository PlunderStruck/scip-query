import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';

import { stableJson } from '../domain/stable-json.js';
import type { ProjectConfig } from '../domain/types.js';
import type { ObservationReceiptV2 } from '../domain/observation-receipt.js';
import { captureFixedRepositoryObservationReceipt } from './observation-receipt.js';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

export interface RepositoryEvaluationSnapshot {
  root: string;
  receipt: ObservationReceiptV2;
  dispose(): void;
}

/**
 * Materialize the candidate's complete Git-visible state in an isolated
 * checkout. The returned root has the same committed base plus exact tracked,
 * deleted, and untracked overlays, while all Git administration lives in a
 * temporary directory outside the candidate repository.
 */
export function createRepositoryEvaluationSnapshot(input: {
  projectRoot: string;
  config: ProjectConfig;
  collaborationDomainId: string;
  prefix?: string;
}): RepositoryEvaluationSnapshot {
  const projectRoot = resolve(input.projectRoot);
  const before = captureFixedRepositoryObservationReceipt({
    projectRoot,
    config: input.config,
    collaborationDomainId: input.collaborationDomainId,
  });
  const container = mkdtempSync(join(tmpdir(), input.prefix ?? 'scip-protected-evaluation-'));
  const root = join(container, 'checkout');
  try {
    const head = gitText(projectRoot, ['rev-parse', '--verify', 'HEAD']).trim();
    execFileSync('git', ['clone', '--quiet', '--no-checkout', '--shared', '--', projectRoot, root], {
      stdio: 'ignore',
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    execFileSync('git', ['-C', root, 'checkout', '--quiet', '--detach', '--force', head], {
      stdio: 'ignore',
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    for (const path of gitVisibleOverlayPaths(projectRoot)) copyOverlayPath(projectRoot, root, path);
    const after = captureFixedRepositoryObservationReceipt({
      projectRoot,
      config: input.config,
      collaborationDomainId: input.collaborationDomainId,
    });
    if (!sameRepositoryState(before, after)) {
      throw new Error('candidate repository content changed while its protected evaluation snapshot was created');
    }
    const receipt = captureFixedRepositoryObservationReceipt({
      projectRoot: root,
      config: input.config,
      collaborationDomainId: input.collaborationDomainId,
    });
    if (!sameRepositoryState(before, receipt)) {
      throw new Error('isolated protected evaluation snapshot does not match the candidate repository content');
    }
    return {
      root,
      receipt,
      dispose() {
        rmSync(container, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(container, { recursive: true, force: true });
    throw error;
  }
}

export function assertRepositoryEvaluationSnapshotFixed(
  snapshot: RepositoryEvaluationSnapshot,
  config: ProjectConfig,
  collaborationDomainId: string,
): void {
  const current = captureFixedRepositoryObservationReceipt({
    projectRoot: snapshot.root,
    config,
    collaborationDomainId,
  });
  if (!sameRepositoryState(snapshot.receipt, current)) {
    throw new Error('protected evaluator changed the isolated repository snapshot while it was running');
  }
}

function gitVisibleOverlayPaths(projectRoot: string): string[] {
  const output = execFileSync(
    'git',
    ['-C', projectRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.'],
    {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      killSignal: 'SIGKILL',
    },
  );
  return output
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      if (record.length < 4 || record[2] !== ' ') throw new Error('Git returned malformed worktree status data');
      return safeRepositoryPath(record.slice(3));
    })
    .sort();
}

function copyOverlayPath(sourceRoot: string, targetRoot: string, relativePath: string): void {
  const source = join(sourceRoot, relativePath);
  const target = join(targetRoot, relativePath);
  rmSync(target, { recursive: true, force: true });
  if (!existsSync(source)) return;
  const stat = lstatSync(source);
  mkdirSync(dirname(target), { recursive: true });
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target);
  } else if (stat.isFile()) {
    copyFileSync(source, target);
    chmodSync(target, stat.mode & 0o777);
  } else if (stat.isDirectory()) {
    cpSync(source, target, { recursive: true, dereference: false, preserveTimestamps: true });
  } else {
    throw new Error(`unsupported repository entry type at ${JSON.stringify(relativePath)}`);
  }
}

function safeRepositoryPath(value: string): string {
  const path = normalize(value).replaceAll('\\', '/');
  if (!path || path === '.' || path === '..' || path.startsWith('../') || isAbsolute(path)) {
    throw new Error(`Git returned unsafe repository path ${JSON.stringify(value)}`);
  }
  return path;
}

function sameRepositoryState(left: ObservationReceiptV2, right: ObservationReceiptV2): boolean {
  return (
    stableJson(left.facts.collaborationDomain) === stableJson(right.facts.collaborationDomain) &&
    stableJson(left.facts.wholeContent) === stableJson(right.facts.wholeContent)
  );
}

function gitText(projectRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    killSignal: 'SIGKILL',
  });
}
