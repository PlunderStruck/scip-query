import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { ObservationReceipt } from '../domain/observation-receipt.js';
import { gitOutput, resolveGitWorktreeContext, type GitWorktreeContext } from '../platform/git-worktree.js';
import type { ScipDatabase } from '../storage/db.js';
import { currentCliDatabase, resolveProjectRoot } from './cli-context.js';

export {
  OBSERVATION_RECEIPT_SCHEMA_VERSION,
  compareObservationReceipts,
  isObservationReceipt,
} from '../domain/observation-receipt.js';
export type {
  ObservationAuthorityKind,
  ObservationReceipt,
  ObservationReceiptComparison,
} from '../domain/observation-receipt.js';

export interface ObservationReceiptInput {
  projectRoot: string;
  observedAt?: Date;
  db?: Pick<ScipDatabase, 'generation'>;
  gitContext?: GitWorktreeContext;
  statusPorcelain?: string;
  trackedDiff?: string;
}

export function buildObservationReceipt(input: ObservationReceiptInput): ObservationReceipt {
  const index = input.db
    ? {
        generationIdentity: input.db.generation.identity,
        source: input.db.generation.source,
        alignment: 'not-certified' as const,
      }
    : undefined;
  const worktree = input.gitContext
    ? {
        identity: createHash('sha256')
          .update(
            JSON.stringify({
              worktreeId: input.gitContext.worktreeId,
              headCommit: input.gitContext.headCommit,
              status: input.statusPorcelain ?? '',
              trackedDiff: input.trackedDiff ?? '',
            }),
          )
          .digest('hex'),
        clean: input.gitContext.clean,
        ...(input.gitContext.headCommit ? { headCommit: input.gitContext.headCommit } : {}),
        ...(input.gitContext.treeOid ? { treeOid: input.gitContext.treeOid } : {}),
      }
    : undefined;
  const authorityKind = index
    ? worktree
      ? ('index-worktree' as const)
      : ('index-only' as const)
    : worktree
      ? ('worktree-only' as const)
      : ('process-local' as const);
  return {
    schemaVersion: 1,
    authorityKind,
    observedAt: (input.observedAt ?? new Date()).toISOString(),
    projectIdentity: createHash('sha256').update(resolve(input.projectRoot)).digest('hex'),
    ...(index ? { index } : {}),
    ...(worktree ? { worktree } : {}),
  };
}

export function buildLeasedObservationReceipt(input: {
  projectRoot: string;
  generationIdentity: string;
  generationSource: 'immutable' | 'legacy';
  worktreeIdentity: string;
  observedAt: string;
}): ObservationReceipt {
  const gitContext = resolveGitWorktreeContext(input.projectRoot);
  const base = buildObservationReceipt({
    projectRoot: input.projectRoot,
    observedAt: new Date(input.observedAt),
    ...(gitContext ? { gitContext } : {}),
  });
  return {
    ...base,
    authorityKind: 'index-worktree',
    index: {
      generationIdentity: input.generationIdentity,
      source: input.generationSource,
      alignment: 'leased',
    },
    worktree: {
      identity: input.worktreeIdentity,
      clean: gitContext?.clean ?? false,
      ...(gitContext?.headCommit ? { headCommit: gitContext.headCommit } : {}),
      ...(gitContext?.treeOid ? { treeOid: gitContext.treeOid } : {}),
    },
  };
}

/**
 * Build the strongest receipt available at JSON-render time. Database-backed
 * commands expose the immutable generation held by their open connection.
 * Non-database commands still receive a process-local project identity.
 */
export function currentCliObservationReceipt(): ObservationReceipt {
  const db = currentCliDatabase();
  const projectRoot = db?.config.projectRoot ?? resolveProjectRoot();
  if (!db) return buildObservationReceipt({ projectRoot });
  const gitContext = resolveGitWorktreeContext(projectRoot);
  return buildObservationReceipt({
    projectRoot,
    db,
    ...(gitContext
      ? {
          gitContext,
          statusPorcelain: gitOutput(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) ?? '',
          trackedDiff: gitOutput(projectRoot, ['diff', '--no-ext-diff', '--binary', 'HEAD', '--']) ?? '',
        }
      : {}),
  });
}
