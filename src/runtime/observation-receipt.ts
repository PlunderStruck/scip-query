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
  captureProjectObservationSnapshot,
  type ProjectObservationSnapshot,
} from '../platform/project-observation-snapshot.js';
import { detectLanguages } from '../reindex/detect.js';
import type { ScipDatabase } from '../storage/db.js';
import type { ProjectConfig } from '../domain/types.js';
import { currentCliDatabase, resolveProjectRoot } from './cli-context.js';
import { loadProjectConfig } from './config.js';

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

export function buildLeasedObservationReceipt(input: {
  projectRoot: string;
  collaborationDomainId?: string;
  generationIdentity: string;
  generationSource: 'immutable' | 'legacy';
  worktreeIdentity: string;
  observedAt: string;
}): ObservationReceiptV2 {
  const gitContext = resolveGitWorktreeContext(input.projectRoot);
  const collaborationDomainId =
    input.collaborationDomainId ?? loadProjectConfig(input.projectRoot).collaborationDomainId;
  const base = buildObservationReceipt({
    projectRoot: input.projectRoot,
    observedAt: new Date(input.observedAt),
    ...(collaborationDomainId ? { collaborationDomainId } : {}),
    ...(gitContext ? { gitContext } : {}),
  });
  const generation = createObservationIdentity(INDEX_GENERATION_IDENTITY_PROJECTION, 1, input.generationIdentity);
  const leasedWorkspaceSource = createObservationIdentity(
    'scip-query:bracketed-workspace-state',
    1,
    input.worktreeIdentity,
  );
  return {
    ...base,
    facts: {
      ...base.facts,
      relevantInputs: [
        ...(base.facts.relevantInputs ?? []),
        {
          subject: 'stop-hook-repository-state',
          identity: leasedWorkspaceSource,
        },
      ],
      index: {
        generation,
        source: input.generationSource,
      },
    },
    observedSources: [
      { kind: 'index-generation', identity: generation },
      {
        kind: 'live-workspace',
        ...(base.facts.workspaceInstance ? { identity: base.facts.workspaceInstance } : {}),
      },
    ],
    stabilityProofs: [
      {
        source: 'index-generation',
        kind: input.generationSource === 'immutable' ? 'immutable' : 'not-established',
      },
      { source: 'live-workspace', kind: 'bracketed' },
    ],
  };
}

/**
 * Capture one fixed whole-repository state and derive its receipt before
 * releasing the snapshot. Callers that require a stable target can bracket
 * an operation with two calls and reject a moved whole-content identity.
 */
export function captureFixedRepositoryObservationReceipt(input: {
  projectRoot: string;
  config: ProjectConfig;
  observedAt?: Date;
  collaborationDomainId?: string;
  db?: Pick<ScipDatabase, 'generation' | 'config'>;
  gitContext?: GitWorktreeContext;
}): ObservationReceiptV2 {
  const gitContext = input.gitContext ?? resolveGitWorktreeContext(input.projectRoot);
  const languages = input.config.languages ?? detectLanguages(input.projectRoot);
  const snapshot = captureProjectObservationSnapshot(input.projectRoot, languages, input.config, gitContext);
  try {
    return buildObservationReceipt({
      projectRoot: input.projectRoot,
      snapshot,
      ...(input.observedAt ? { observedAt: input.observedAt } : {}),
      ...(input.collaborationDomainId ? { collaborationDomainId: input.collaborationDomainId } : {}),
      ...(input.db ? { db: input.db } : {}),
    });
  } finally {
    snapshot.dispose();
  }
}

/**
 * Build the strongest receipt available at JSON-render time. Database-backed
 * commands expose the immutable generation held by their open connection.
 * Non-database commands retain process provenance without claiming repository
 * state authority.
 */
export function currentCliObservationReceipt(): ObservationReceipt {
  const db = currentCliDatabase();
  const projectRoot = db?.config.projectRoot ?? resolveProjectRoot();
  let gitContext = resolveGitWorktreeContext(projectRoot);
  if (!db) {
    return buildObservationReceipt({
      projectRoot,
      ...(gitContext ? { gitContext } : {}),
    });
  }
  const config = loadProjectConfig(projectRoot);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return captureFixedRepositoryObservationReceipt({ projectRoot, config, db, gitContext });
    } catch {
      // A moving or unsupported workspace cannot prove fixed-snapshot facts.
      // Retry once for an ordinary race, then return the weaker honest receipt.
      gitContext = resolveGitWorktreeContext(projectRoot);
    }
  }
  return buildObservationReceipt({
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
