import type { ObservationReceipt } from '../domain/observation-receipt.js';
import {
  createObservationIdentity,
  OBSERVATION_RECEIPT_SCHEMA_VERSION,
  type ObservationReceiptV2,
  type ObservationSourceFact,
  type ObservationStabilityProof,
} from '../domain/observation-receipt.js';
import { resolveGitWorktreeContext, type GitWorktreeContext } from '../platform/git-worktree.js';
import type { ScipDatabase } from '../storage/db.js';
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

export interface ObservationReceiptInput {
  projectRoot: string;
  observedAt?: Date;
  collaborationDomainId?: string;
  db?: Pick<ScipDatabase, 'generation' | 'config'>;
  gitContext?: GitWorktreeContext;
}

/**
 * Build a v2 receipt from facts already held by the caller. This adapter does
 * not pretend that a live Git status is a whole-content snapshot: until the
 * fixed-snapshot slice supplies such a fact, live-workspace stability remains
 * explicitly not established.
 */
export function buildObservationReceipt(input: ObservationReceiptInput): ObservationReceiptV2 {
  const collaborationDomainId = input.collaborationDomainId ?? input.db?.config.collaborationDomainId;
  const collaborationDomain = collaborationDomainId
    ? createObservationIdentity(COLLABORATION_DOMAIN_IDENTITY_PROJECTION, 1, collaborationDomainId)
    : undefined;
  const workspaceInstance = input.gitContext
    ? createObservationIdentity(WORKSPACE_INSTANCE_IDENTITY_PROJECTION, 1, input.gitContext.worktreeId)
    : undefined;
  const index = input.db
    ? {
        generation: createObservationIdentity(INDEX_GENERATION_IDENTITY_PROJECTION, 1, input.db.generation.identity),
        source: input.db.generation.source,
      }
    : undefined;
  const observedSources: ObservationSourceFact[] = [
    ...(index ? [{ kind: 'index-generation' as const, identity: index.generation }] : []),
    ...(workspaceInstance ? [{ kind: 'live-workspace' as const, identity: workspaceInstance }] : []),
  ];
  const stabilityProofs: ObservationStabilityProof[] = [
    ...(index
      ? [
          {
            source: 'index-generation' as const,
            kind: index.source === 'immutable' ? ('immutable' as const) : ('not-established' as const),
          },
        ]
      : []),
    ...(workspaceInstance ? [{ source: 'live-workspace' as const, kind: 'not-established' as const }] : []),
  ];
  if (observedSources.length === 0) {
    observedSources.push({ kind: 'process' });
    stabilityProofs.push({ source: 'process', kind: 'not-established' });
  }
  return {
    schemaVersion: OBSERVATION_RECEIPT_SCHEMA_VERSION,
    observedAt: (input.observedAt ?? new Date()).toISOString(),
    facts: {
      ...(collaborationDomain ? { collaborationDomain } : {}),
      ...(workspaceInstance ? { workspaceInstance } : {}),
      ...(index ? { index } : {}),
    },
    observedSources,
    stabilityProofs,
    ...(input.gitContext
      ? {
          diagnostics: {
            clean: input.gitContext.clean,
            ...(input.gitContext.headCommit ? { headCommit: input.gitContext.headCommit } : {}),
            ...(input.gitContext.treeOid ? { treeOid: input.gitContext.treeOid } : {}),
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
 * Build the strongest receipt available at JSON-render time. Database-backed
 * commands expose the immutable generation held by their open connection.
 * Non-database commands retain process provenance without claiming repository
 * state authority.
 */
export function currentCliObservationReceipt(): ObservationReceipt {
  const db = currentCliDatabase();
  const projectRoot = db?.config.projectRoot ?? resolveProjectRoot();
  const gitContext = resolveGitWorktreeContext(projectRoot);
  return buildObservationReceipt({
    projectRoot,
    ...(db ? { db } : {}),
    ...(gitContext ? { gitContext } : {}),
  });
}
