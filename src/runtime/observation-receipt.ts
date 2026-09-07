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
  const facts = buildObservationFacts(input, gitContext);
  const sources = declaredSources ?? inferredObservationSources(facts);
  const evidence = observationSourceEvidence(facts, sources);
  return {
    schemaVersion: OBSERVATION_RECEIPT_SCHEMA_VERSION,
    observedAt: (input.observedAt ?? (snapshot ? new Date(snapshot.capturedAt) : new Date())).toISOString(),
    facts,
    ...evidence,
    ...(gitContext ? { diagnostics: observationGitDiagnostics(gitContext) } : {}),
  };
}

function buildObservationFacts(
  input: ObservationReceiptInput,
  gitContext: GitWorktreeContext | undefined,
): ObservationReceiptV2['facts'] {
  const facts: ObservationReceiptV2['facts'] = {};
  const collaborationDomainId = input.collaborationDomainId ?? input.db?.config.collaborationDomainId;
  if (collaborationDomainId) {
    facts.collaborationDomain = createObservationIdentity(
      COLLABORATION_DOMAIN_IDENTITY_PROJECTION,
      1,
      collaborationDomainId,
    );
  }
  if (gitContext) {
    facts.workspaceInstance = createObservationIdentity(
      WORKSPACE_INSTANCE_IDENTITY_PROJECTION,
      1,
      gitContext.worktreeId,
    );
  }
  if (input.snapshot) {
    facts.wholeContent = createObservationIdentity(
      REPOSITORY_CONTENT_IDENTITY_PROJECTION,
      1,
      canonicalRepositoryContentSnapshot(input.snapshot.repositoryContent),
    );
    facts.relevantInputs = [
      {
        subject: INDEX_INPUT_RELEVANT_SUBJECT,
        identity: createObservationIdentity(
          INDEX_INPUT_IDENTITY_PROJECTION,
          input.snapshot.indexInputs.version,
          canonicalProjectInputSnapshot(input.snapshot.indexInputs),
        ),
      },
    ];
  }
  if (input.db) {
    const inputs = input.snapshot ? generationIndexInputIdentity(input.db.generation.metadataRaw) : undefined;
    facts.index = {
      generation: createObservationIdentity(INDEX_GENERATION_IDENTITY_PROJECTION, 1, input.db.generation.identity),
      ...(inputs ? { inputs } : {}),
      source: input.db.generation.source,
    };
  }
  return facts;
}

function inferredObservationSources(facts: ObservationReceiptV2['facts']): Set<ObservationSourceFact['kind']> {
  const sources = new Set<ObservationSourceFact['kind']>();
  if (facts.index) sources.add('index-generation');
  if (facts.wholeContent) sources.add('repository-snapshot');
  else if (facts.workspaceInstance) sources.add('live-workspace');
  return sources;
}

/** Record a source and its stability proof together, under the same eligibility decision. */
function observationSourceEvidence(
  facts: ObservationReceiptV2['facts'],
  sources: ReadonlySet<ObservationSourceFact['kind']>,
): Pick<ObservationReceiptV2, 'observedSources' | 'stabilityProofs'> {
  const observedSources: ObservationSourceFact[] = [];
  const stabilityProofs: ObservationStabilityProof[] = [];
  const add = (fact: ObservationSourceFact, kind: ObservationStabilityProof['kind']): void => {
    observedSources.push(fact);
    stabilityProofs.push({ source: fact.kind, kind });
  };
  if (facts.index && sources.has('index-generation')) {
    add(
      { kind: 'index-generation', identity: facts.index.generation },
      facts.index.source === 'immutable' ? 'immutable' : 'not-established',
    );
  }
  if (facts.wholeContent && sources.has('repository-snapshot')) {
    add({ kind: 'repository-snapshot', identity: facts.wholeContent }, 'fixed-snapshot');
  }
  if (facts.workspaceInstance && sources.has('live-workspace')) {
    add({ kind: 'live-workspace', identity: facts.workspaceInstance }, 'not-established');
  }
  if (sources.has('process')) add({ kind: 'process' }, 'not-established');
  if (observedSources.length === 0) add({ kind: 'process' }, 'not-established');
  return { observedSources, stabilityProofs };
}

function observationGitDiagnostics(gitContext: GitWorktreeContext): ObservationReceiptV2['diagnostics'] {
  return {
    clean: gitContext.clean,
    ...(gitContext.headCommit ? { headCommit: gitContext.headCommit } : {}),
    ...(gitContext.treeOid ? { treeOid: gitContext.treeOid } : {}),
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
