import type { ObservationReceipt } from '../domain/observation-receipt.js';
import {
  createObservationIdentity,
  OBSERVATION_RECEIPT_SCHEMA_VERSION,
  type ObservationReceiptV2,
  type ObservationSourceFact,
  type ObservationStabilityProof,
} from '../domain/observation-receipt.js';
import { projectInputSnapshotOrNull } from '../domain/project-input.js';
import { decodeReindexMetadata } from '../domain/reindex-metadata.js';
import { resolveGitWorktreeContext, type GitWorktreeContext } from '../platform/git-worktree.js';
import {
  canonicalProjectInputSnapshot,
  canonicalRepositoryContentSnapshot,
  type ProjectObservationSnapshot,
} from '../platform/project-observation-snapshot.js';
import type { ScipDatabase } from '../storage/db.js';
import { currentCliDatabase, resolveProjectRoot } from './cli-context.js';

export {
  createObservationIdentity,
  decodeObservationReceipt,
  deriveObservationStateAuthority,
  LEGACY_OBSERVATION_RECEIPT_SCHEMA_VERSION,
  OBSERVATION_IDENTITY_CANONICALIZATION_VERSION,
  OBSERVATION_IDENTITY_HASH_ALGORITHM,
  OBSERVATION_IDENTITY_SCHEMA_VERSION,
  OBSERVATION_RECEIPT_SCHEMA_VERSION,
  OBSERVATION_STATE_AUTHORITY_POLICY_VERSION,
  compareObservationReceipts,
  isObservationReceipt,
  observationReceiptGenerationIdentity,
  observationReceiptStabilityLabel,
  observationReceiptWorkspaceIdentity,
} from '../domain/observation-receipt.js';
export type {
  DecodedObservationReceipt,
  DerivedObservationStateAuthority,
  ObservationAuthorityKind,
  ObservationComparedFact,
  ObservationComparisonReason,
  ObservationIdentity,
  ObservationReceipt,
  ObservationReceiptComparison,
  ObservationReceiptV1,
  ObservationReceiptV2,
  ObservationRelationshipJudgment,
  ObservationRelationshipState,
  ObservationSourceFact,
  ObservationSourceKind,
  ObservationStabilityProof,
  ObservationStabilityProofKind,
  ObservationStateAuthority,
  RelevantInputIdentity,
  RelevantInputRelationshipJudgment,
} from '../domain/observation-receipt.js';

export const COLLABORATION_DOMAIN_IDENTITY_PROJECTION = 'scip-query:collaboration-domain' as const;
export const WORKSPACE_INSTANCE_IDENTITY_PROJECTION = 'scip-query:workspace-instance' as const;
export const INDEX_GENERATION_IDENTITY_PROJECTION = 'scip-query:index-generation' as const;
export const REPOSITORY_CONTENT_IDENTITY_PROJECTION = 'scip-query:repository-content' as const;
export const INDEX_INPUT_IDENTITY_PROJECTION = 'scip-query:index-inputs' as const;
export const INDEX_INPUT_RELEVANT_SUBJECT = 'scip-query:index-inputs' as const;

export interface ObservationReceiptInput {
  projectRoot: string;
  observedAt?: Date;
  collaborationDomainId?: string;
  db?: Pick<ScipDatabase, 'generation' | 'config'>;
  gitContext?: GitWorktreeContext;
  snapshot?: ProjectObservationSnapshot;
  /** Sources the producer actually read; omitted only for legacy adapters that infer all supplied inputs. */
  observedSourceKinds?: readonly ObservationSourceFact['kind'][];
}

/**
 * Build a v2 receipt from facts already held by the caller. This adapter does
 * not pretend that a live Git status is a whole-content snapshot: until the
 * fixed-snapshot slice supplies such a fact, live-workspace stability remains
 * explicitly not established.
 */
export function buildObservationReceipt(input: ObservationReceiptInput): ObservationReceiptV2 {
  const snapshot = input.snapshot;
  const declaredSources = input.observedSourceKinds ? new Set(input.observedSourceKinds) : undefined;
  const gitContext =
    input.gitContext ??
    snapshot?.gitContext ??
    (declaredSources?.has('live-workspace') ? resolveGitWorktreeContext(input.projectRoot) : undefined);
  const collaborationDomainId = input.collaborationDomainId ?? input.db?.config.collaborationDomainId;
  const collaborationDomain = collaborationDomainId
    ? createObservationIdentity(COLLABORATION_DOMAIN_IDENTITY_PROJECTION, 1, collaborationDomainId)
    : undefined;
  const workspaceInstance = gitContext
    ? createObservationIdentity(WORKSPACE_INSTANCE_IDENTITY_PROJECTION, 1, gitContext.worktreeId)
    : undefined;
  const repositoryContent = snapshot
    ? createObservationIdentity(
        REPOSITORY_CONTENT_IDENTITY_PROJECTION,
        1,
        canonicalRepositoryContentSnapshot(snapshot.repositoryContent),
      )
    : undefined;
  const snapshotIndexInputs = snapshot
    ? createObservationIdentity(
        INDEX_INPUT_IDENTITY_PROJECTION,
        snapshot.indexInputs.version,
        canonicalProjectInputSnapshot(snapshot.indexInputs),
      )
    : undefined;
  const generationInputs =
    input.db && snapshot ? generationIndexInputIdentity(input.db.generation.metadataRaw) : undefined;
  const index = input.db
    ? {
        generation: createObservationIdentity(INDEX_GENERATION_IDENTITY_PROJECTION, 1, input.db.generation.identity),
        ...(generationInputs ? { inputs: generationInputs } : {}),
        source: input.db.generation.source,
      }
    : undefined;
  const observedSourceKinds =
    declaredSources ??
    new Set([
      ...(index ? (['index-generation'] as const) : []),
      ...(repositoryContent
        ? (['repository-snapshot'] as const)
        : workspaceInstance
          ? (['live-workspace'] as const)
          : []),
    ]);
  const observedSources: ObservationSourceFact[] = [
    ...(index && observedSourceKinds.has('index-generation')
      ? [{ kind: 'index-generation' as const, identity: index.generation }]
      : []),
    ...(repositoryContent && observedSourceKinds.has('repository-snapshot')
      ? [{ kind: 'repository-snapshot' as const, identity: repositoryContent }]
      : []),
    ...(workspaceInstance && observedSourceKinds.has('live-workspace')
      ? [{ kind: 'live-workspace' as const, identity: workspaceInstance }]
      : []),
    ...(observedSourceKinds.has('process') ? [{ kind: 'process' as const }] : []),
  ];
  const stabilityProofs: ObservationStabilityProof[] = [
    ...(index && observedSourceKinds.has('index-generation')
      ? [
          {
            source: 'index-generation' as const,
            kind: index.source === 'immutable' ? ('immutable' as const) : ('not-established' as const),
          },
        ]
      : []),
    ...(repositoryContent && observedSourceKinds.has('repository-snapshot')
      ? [{ source: 'repository-snapshot' as const, kind: 'fixed-snapshot' as const }]
      : []),
    ...(workspaceInstance && observedSourceKinds.has('live-workspace')
      ? [{ source: 'live-workspace' as const, kind: 'not-established' as const }]
      : []),
    ...(observedSourceKinds.has('process') ? [{ source: 'process' as const, kind: 'not-established' as const }] : []),
  ];
  if (observedSources.length === 0) {
    observedSources.push({ kind: 'process' });
    stabilityProofs.push({ source: 'process', kind: 'not-established' });
  }
  return {
    schemaVersion: OBSERVATION_RECEIPT_SCHEMA_VERSION,
    observedAt: (input.observedAt ?? (snapshot ? new Date(snapshot.capturedAt) : new Date())).toISOString(),
    facts: {
      ...(collaborationDomain ? { collaborationDomain } : {}),
      ...(workspaceInstance ? { workspaceInstance } : {}),
      ...(repositoryContent ? { wholeContent: repositoryContent } : {}),
      ...(snapshotIndexInputs
        ? {
            relevantInputs: [
              {
                subject: INDEX_INPUT_RELEVANT_SUBJECT,
                identity: snapshotIndexInputs,
              },
            ],
          }
        : {}),
      ...(index ? { index } : {}),
    },
    observedSources,
    stabilityProofs,
    ...(gitContext
      ? {
          diagnostics: {
            clean: gitContext.clean,
            ...(gitContext.headCommit ? { headCommit: gitContext.headCommit } : {}),
            ...(gitContext.treeOid ? { treeOid: gitContext.treeOid } : {}),
          },
        }
      : {}),
  };
}

/**
 * Identify the immutable index generation used by an operation without
 * claiming that the operation observed every live repository file.
 */
export function buildIndexGenerationObservationReceipt(input: {
  projectRoot: string;
  db: Pick<ScipDatabase, 'generation' | 'config'>;
  gitContext?: GitWorktreeContext;
  observedAt?: Date;
}): ObservationReceiptV2 {
  return buildObservationReceipt({
    projectRoot: input.projectRoot,
    db: input.db,
    ...(input.gitContext ? { gitContext: input.gitContext } : {}),
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
    observedSourceKinds: ['index-generation'],
  });
}

export function currentCliIndexGenerationObservationReceipt(): ObservationReceipt {
  const db = currentCliDatabase();
  if (!db) {
    return buildObservationReceipt({
      projectRoot: resolveProjectRoot(),
      observedSourceKinds: ['process'],
    });
  }
  const projectRoot = db.config.projectRoot;
  const gitContext = resolveGitWorktreeContext(projectRoot);
  return buildIndexGenerationObservationReceipt({
    projectRoot,
    db,
    ...(gitContext ? { gitContext } : {}),
  });
}

function generationIndexInputIdentity(metadataRaw: string | undefined) {
  if (!metadataRaw) return undefined;
  const decoded = decodeReindexMetadata(metadataRaw);
  if (decoded.kind !== 'legacy' && decoded.kind !== 'supported') return undefined;
  const snapshot = projectInputSnapshotOrNull(decoded.metadata.fingerprint);
  return snapshot && Number.isSafeInteger(snapshot.version) && snapshot.version > 0
    ? createObservationIdentity(
        INDEX_INPUT_IDENTITY_PROJECTION,
        snapshot.version,
        canonicalProjectInputSnapshot(snapshot),
      )
    : undefined;
}
