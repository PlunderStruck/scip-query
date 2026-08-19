import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { assertOwnedCacheDir } from '../platform/cache-layout.js';
import { readTextFileWithinLimit } from '../platform/bounded-file.js';
import {
  DEFAULT_GIT_READER,
  gitWorktreeContextHintEnvironmentSupported,
  observeGitWorktreeContext,
  observeGitWorktreeContextFromHint,
  type GitReader,
  type GitWorktreeContext,
  type GitWorktreeContextHint,
  type GitWorktreeContextObservation,
} from '../platform/git-worktree.js';
import { writeJsonAtomic } from '../storage/atomic-json.js';

const GIT_WORKTREE_CONTEXT_FILE = 'git-worktree-context.json';
const GIT_WORKTREE_CONTEXT_MAX_BYTES = 16 * 1024;
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/;
const PATH_ID = /^[0-9a-f]{24}$/;
const SHA256 = /^[0-9a-f]{64}$/;

interface GitWorktreeContextReceipt extends GitWorktreeContextHint {
  version: 1;
  requestedProjectRoot: string;
  cacheOwnerSha256: string;
  checksum: string;
}

/**
 * Uses an owned cache receipt to skip immutable Git metadata discovery on a
 * stable checkout. The receipt is only a hint: physical control paths and live
 * porcelain status must still validate it, and every failure falls back to a
 * complete Git observation.
 */
export function observeGitWorktreeContextWithCache(
  projectRoot: string,
  cacheDir: string,
  git: GitReader = DEFAULT_GIT_READER,
): GitWorktreeContextObservation | undefined {
  const cacheEligible = git !== DEFAULT_GIT_READER || gitWorktreeContextHintEnvironmentSupported();
  const receipt = cacheEligible ? readGitWorktreeContextReceipt(projectRoot, cacheDir) : undefined;
  if (receipt) {
    const observation = observeGitWorktreeContextFromHint(projectRoot, receipt, git);
    if (observation) return observation;
  }

  const observation = observeGitWorktreeContext(projectRoot, git);
  if (observation && cacheEligible) {
    try {
      persistGitWorktreeContextReceipt(projectRoot, cacheDir, observation.context, receipt);
    } catch {
      // This optimization is disposable. A missing receipt only costs one
      // metadata process on the next invocation and cannot block the command.
    }
  }
  return observation;
}

function readGitWorktreeContextReceipt(projectRoot: string, cacheDir: string): GitWorktreeContextReceipt | undefined {
  try {
    const ownership = assertOwnedCacheDir(projectRoot, cacheDir);
    const path = join(ownership.physicalCacheDir, GIT_WORKTREE_CONTEXT_FILE);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > GIT_WORKTREE_CONTEXT_MAX_BYTES) return undefined;
    const parsed: unknown = JSON.parse(
      readTextFileWithinLimit(path, {
        inputKind: 'Git worktree context receipt',
        maxBytes: GIT_WORKTREE_CONTEXT_MAX_BYTES,
      }),
    );
    if (!isGitWorktreeContextReceipt(parsed)) return undefined;
    if (
      parsed.requestedProjectRoot !== ownership.record.canonicalProjectRoot ||
      parsed.cacheOwnerSha256 !== ownership.ownerSha256 ||
      parsed.checksum !== gitWorktreeContextReceiptChecksum(parsed)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function persistGitWorktreeContextReceipt(
  projectRoot: string,
  cacheDir: string,
  context: GitWorktreeContext,
  existing: GitWorktreeContextReceipt | undefined,
): void {
  if (!context.headCommit || !context.treeOid) return;
  const ownership = assertOwnedCacheDir(projectRoot, cacheDir);
  const withoutChecksum = {
    version: 1,
    requestedProjectRoot: ownership.record.canonicalProjectRoot,
    cacheOwnerSha256: ownership.ownerSha256,
    projectRoot: context.projectRoot,
    gitDir: context.gitDir,
    commonDir: context.commonDir,
    repositoryId: context.repositoryId,
    worktreeId: context.worktreeId,
    headCommit: context.headCommit,
    treeOid: context.treeOid,
  } as const;
  const receipt: GitWorktreeContextReceipt = {
    ...withoutChecksum,
    checksum: gitWorktreeContextReceiptChecksum(withoutChecksum),
  };
  if (existing?.checksum === receipt.checksum) return;
  writeJsonAtomic(join(ownership.physicalCacheDir, GIT_WORKTREE_CONTEXT_FILE), receipt, {
    spacing: 2,
    trailingNewline: true,
  });
}

function isGitWorktreeContextReceipt(value: unknown): value is GitWorktreeContextReceipt {
  if (!isRecord(value)) return false;
  return (
    value['version'] === 1 &&
    isAbsoluteString(value['requestedProjectRoot']) &&
    matches(SHA256, value['cacheOwnerSha256']) &&
    isAbsoluteString(value['projectRoot']) &&
    isAbsoluteString(value['gitDir']) &&
    isAbsoluteString(value['commonDir']) &&
    matches(PATH_ID, value['repositoryId']) &&
    matches(PATH_ID, value['worktreeId']) &&
    matches(GIT_OBJECT_ID, value['headCommit']) &&
    matches(GIT_OBJECT_ID, value['treeOid']) &&
    matches(SHA256, value['checksum'])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsoluteString(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value);
}

function gitWorktreeContextReceiptChecksum(
  receipt: Omit<GitWorktreeContextReceipt, 'checksum'> | GitWorktreeContextReceipt,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: receipt.version,
        requestedProjectRoot: receipt.requestedProjectRoot,
        cacheOwnerSha256: receipt.cacheOwnerSha256,
        projectRoot: receipt.projectRoot,
        gitDir: receipt.gitDir,
        commonDir: receipt.commonDir,
        repositoryId: receipt.repositoryId,
        worktreeId: receipt.worktreeId,
        headCommit: receipt.headCommit,
        treeOid: receipt.treeOid,
      }),
    )
    .digest('hex');
}

function matches(expression: RegExp, value: unknown): value is string {
  return typeof value === 'string' && expression.test(value);
}
