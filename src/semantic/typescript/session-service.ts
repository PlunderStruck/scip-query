import { randomUUID } from 'node:crypto';
import {
  buildProjectChangeManifest,
  projectInputSnapshotOrNull,
  type ProjectChangeManifest,
  type ProjectInputSnapshot,
} from '../../domain/project-input.js';
import {
  applyProfileEnvironment,
  captureProfileEnvironment,
  type ProfileEnvironment,
} from '../../instrumentation/profile.js';
import type { ScipDatabase } from '../../storage/db.js';
import { generationMetadata } from '../../storage/sqlite-generation.js';
import {
  claimBoundedMailboxRequests,
  completeBoundedMailboxClaim,
  initializeBoundedMailbox,
  inspectBoundedMailbox,
  readBoundedMailboxClaim,
  rejectBoundedMailboxClaim,
  type BoundedMailboxLimits,
  type BoundedMailboxStatus,
} from '../../storage/bounded-mailbox.js';
import { TypeScriptSemanticHost } from './session-host.js';
import {
  TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
  parseTypeScriptSemanticEnvelope,
  type TypeScriptSemanticMailboxPaths,
  type TypeScriptSemanticRequest,
  type TypeScriptSemanticServiceStatus,
} from './session-protocol.js';

export interface TypeScriptSemanticServiceHostOptions {
  openDb: () => ScipDatabase;
  createHost?: (db: ScipDatabase) => TypeScriptSemanticHost;
  generationIdentity?: (dbPath: string) => string | null;
  readSnapshot?: (dbPath: string) => ProjectInputSnapshot | null;
  now?: () => number;
}

export class TypeScriptSemanticServiceHost {
  private readonly openDb: () => ScipDatabase;
  private readonly createHost: (db: ScipDatabase) => TypeScriptSemanticHost;
  private readonly generationIdentity: (db: ScipDatabase) => string | null;
  private readonly readSnapshot: (db: ScipDatabase) => ProjectInputSnapshot | null;
  private readonly now: () => number;
  private db: ScipDatabase | null = null;
  private host: TypeScriptSemanticHost | null = null;
  private generation: string | null = null;
  private snapshot: ProjectInputSnapshot | null = null;
  private requests = 0;
  private lastRequestAtMs: number | null = null;
  private lastError: string | null = null;
  private available: boolean | null = null;

  constructor(opts: TypeScriptSemanticServiceHostOptions) {
    this.openDb = opts.openDb;
    this.createHost = opts.createHost ?? ((db) => new TypeScriptSemanticHost(db));
    this.generationIdentity = opts.generationIdentity
      ? (db) => opts.generationIdentity!(db.config.dbPath)
      : (db) => db.generation.identity;
    this.readSnapshot = opts.readSnapshot ? (db) => opts.readSnapshot!(db.config.dbPath) : readPublishedSnapshot;
    this.now = opts.now ?? Date.now;
  }

  // scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
  handle(generation: string, request: TypeScriptSemanticRequest): unknown {
    try {
      this.syncGeneration(generation);
      const provider = this.host!.semanticProvider();
      this.available = provider.availability().available;
      this.requests += 1;
      this.lastRequestAtMs = this.now();
      this.lastError = null;
      switch (request.kind) {
        case 'availability':
          return provider.availability();
        case 'import-usage':
          return provider.importUsage(request.file);
        case 'references':
          return [...referenceMap(provider, request.definitions, { exact: request.exact === true })];
        case 'reference-fragments':
          if (!provider.referenceFragmentsForFiles) {
            throw new Error('TypeScript provider does not support reference fragments.');
          }
          return [...provider.referenceFragmentsForFiles(request.files)];
        case 'callees':
          return [...resolveCalleeMap(provider, request.definitions)];
        case 'signature':
          return provider.signatureFor(request.definition);
        default:
          return assertNever(request);
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  status(mailbox?: BoundedMailboxStatus): TypeScriptSemanticServiceStatus {
    const stats = this.host?.snapshotStats();
    return {
      protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
      state: this.lastError ? 'error' : !this.host ? 'idle' : this.available ? 'ready' : 'unavailable',
      requests: this.requests,
      ...(this.lastRequestAtMs === null ? {} : { lastRequestAt: new Date(this.lastRequestAtMs).toISOString() }),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      sessionsCreated: stats?.sessionsCreated ?? 0,
      sessionsReused: stats?.sessionsReused ?? 0,
      sessionsRefreshed: stats?.sessionsRefreshed ?? 0,
      sessionsReplaced: stats?.sessionsReplaced ?? 0,
      projectsCreated: stats?.projectsCreated ?? 0,
      ...(mailbox ? { mailbox } : {}),
    };
  }

  closeTypeScriptService(): void {
    this.host?.dispose();
    this.db?.close();
    this.host = null;
    this.db = null;
    this.generation = null;
    this.snapshot = null;
    this.available = null;
  }

  // scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
  private syncGeneration(requestedGeneration: string): void {
    if (this.generation === requestedGeneration && this.host && this.db) return;
    const nextDb = this.openDb();
    const nextGeneration = this.generationIdentity(nextDb);
    if (!nextGeneration || nextGeneration !== requestedGeneration) {
      nextDb.close();
      throw new Error('TypeScript semantic request does not match the currently published index generation.');
    }
    const nextSnapshot = this.readSnapshot(nextDb);
    if (!this.host || !this.db) {
      this.db = nextDb;
      this.host = this.createHost(nextDb);
    } else {
      const previousDb = this.db;
      this.host.advanceGeneration(nextDb, transitionManifest(this.snapshot, nextSnapshot));
      this.db = nextDb;
      previousDb.close();
    }
    this.generation = nextGeneration;
    this.snapshot = nextSnapshot;
    this.available = null;
  }
}

export function initializeTypeScriptSemanticMailbox(paths: TypeScriptSemanticMailboxPaths): void {
  initializeBoundedMailbox(paths);
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function processTypeScriptSemanticMailbox(
  paths: TypeScriptSemanticMailboxPaths,
  host: TypeScriptSemanticServiceHost,
  opts: {
    nowMs?: number;
    beforeRequest?: (deadlineAtMs: number) => void;
    afterRequest?: () => void;
    ownerId?: string;
    limits?: Partial<BoundedMailboxLimits>;
  } = {},
): number {
  initializeTypeScriptSemanticMailbox(paths);
  const nowMs = opts.nowMs ?? Date.now();
  const claims = claimBoundedMailboxRequests(paths, {
    ownerId: opts.ownerId ?? TYPESCRIPT_SEMANTIC_MAILBOX_OWNER,
    nowMs,
    limits: opts.limits,
  });
  let processed = 0;
  for (const claim of claims) {
    let id = claim.requestId;
    let previousProfileEnvironment: ProfileEnvironment | null = null;
    try {
      const envelope = parseTypeScriptSemanticEnvelope(readBoundedMailboxClaim(claim, opts.limits));
      id = envelope.id;
      if (id !== claim.requestId) {
        throw new Error('TypeScript semantic request identity does not match its mailbox path.');
      }
      if (envelope.deadlineAtMs < nowMs) {
        throw new Error('TypeScript semantic request expired before processing.');
      }
      previousProfileEnvironment = captureProfileEnvironment();
      applyProfileEnvironment(envelope.profileEnvironment ?? {});
      opts.beforeRequest?.(envelope.deadlineAtMs);
      const response = host.handle(envelope.generation, envelope.request);
      completeBoundedMailboxClaim(
        paths,
        claim,
        {
          ok: true,
          protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
          id,
          generation: envelope.generation,
          response,
        },
        { nowMs, limits: opts.limits },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rejectBoundedMailboxClaim(
        paths,
        claim,
        {
          ok: false,
          protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
          id,
          error: message,
        },
        message,
        { nowMs, limits: opts.limits },
      );
    } finally {
      if (previousProfileEnvironment) applyProfileEnvironment(previousProfileEnvironment);
      opts.afterRequest?.();
      processed += 1;
    }
  }
  return processed;
}

export function typeScriptSemanticMailboxStatus(paths: TypeScriptSemanticMailboxPaths): BoundedMailboxStatus {
  return inspectBoundedMailbox(paths);
}

function referenceMap(
  provider: ReturnType<TypeScriptSemanticHost['semanticProvider']>,
  definitions: Parameters<
    NonNullable<ReturnType<TypeScriptSemanticHost['semanticProvider']>['referencesForDefinitions']>
  >[0],
  opts?: Parameters<NonNullable<ReturnType<TypeScriptSemanticHost['semanticProvider']>['referencesForDefinitions']>>[1],
) {
  return (
    provider.referencesForDefinitions?.(definitions, opts) ??
    new Map(definitions.map((definition) => [definition.symbolId, provider.referencesFor(definition)]))
  );
}

function resolveCalleeMap(
  provider: ReturnType<TypeScriptSemanticHost['semanticProvider']>,
  definitions: Parameters<
    NonNullable<ReturnType<TypeScriptSemanticHost['semanticProvider']>['calleesForDefinitions']>
  >[0],
) {
  return (
    provider.calleesForDefinitions?.(definitions) ??
    new Map(definitions.map((definition) => [definition.symbolId, provider.calleesFor(definition)]))
  );
}

function readPublishedSnapshot(db: ScipDatabase): ProjectInputSnapshot | null {
  const metadata = generationMetadata<{ fingerprint?: unknown }>(db.generation);
  return projectInputSnapshotOrNull(metadata?.fingerprint);
}

function transitionManifest(
  previous: ProjectInputSnapshot | null,
  current: ProjectInputSnapshot | null,
): ProjectChangeManifest {
  if (current) return buildProjectChangeManifest(previous, current);
  return {
    version: 1,
    changes: [],
    projectIdentityChanged: true,
    uncertainty: ['prior-snapshot-unavailable'],
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled TypeScript semantic request: ${JSON.stringify(value)}`);
}

const TYPESCRIPT_SEMANTIC_MAILBOX_OWNER = `typescript-semantic-${process.pid}-${randomUUID()}`;
