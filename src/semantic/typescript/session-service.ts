import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { writeJsonAtomic } from '../../storage/atomic-json.js';
import {
  buildProjectChangeManifest,
  projectInputSnapshotOrNull,
  type ProjectChangeManifest,
  type ProjectInputSnapshot,
} from '../../reindex/affected-set.js';
import { TypeScriptSemanticHost } from './session-host.js';
import {
  TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
  parseTypeScriptSemanticEnvelope,
  publishedGenerationIdentity,
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
  private readonly generationIdentity: (dbPath: string) => string | null;
  private readonly readSnapshot: (dbPath: string) => ProjectInputSnapshot | null;
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
    this.generationIdentity = opts.generationIdentity ?? publishedGenerationIdentity;
    this.readSnapshot = opts.readSnapshot ?? readPublishedSnapshot;
    this.now = opts.now ?? Date.now;
  }

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
          return [...referenceMap(provider, request.definitions)];
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

  status(): TypeScriptSemanticServiceStatus {
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

  private syncGeneration(requestedGeneration: string): void {
    if (this.generation === requestedGeneration && this.host && this.db) return;
    const nextDb = this.openDb();
    const nextGeneration = this.generationIdentity(nextDb.config.dbPath);
    if (!nextGeneration || nextGeneration !== requestedGeneration) {
      nextDb.close();
      throw new Error('TypeScript semantic request does not match the currently published index generation.');
    }
    const nextSnapshot = this.readSnapshot(nextDb.config.dbPath);
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
  mkdirSync(paths.requestDir, { recursive: true });
  mkdirSync(paths.responseDir, { recursive: true });
}

export function processTypeScriptSemanticMailbox(
  paths: TypeScriptSemanticMailboxPaths,
  host: TypeScriptSemanticServiceHost,
  opts: {
    nowMs?: number;
    beforeRequest?: (deadlineAtMs: number) => void;
    afterRequest?: () => void;
  } = {},
): number {
  initializeTypeScriptSemanticMailbox(paths);
  let processed = 0;
  for (const file of readdirSync(paths.requestDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()) {
    const requestPath = resolve(paths.requestDir, file);
    let id = file.slice(0, -'.json'.length);
    try {
      const envelope = parseTypeScriptSemanticEnvelope(readFileSync(requestPath, 'utf8'));
      id = envelope.id;
      if (envelope.deadlineAtMs < (opts.nowMs ?? Date.now())) {
        throw new Error('TypeScript semantic request expired before processing.');
      }
      opts.beforeRequest?.(envelope.deadlineAtMs);
      const response = host.handle(envelope.generation, envelope.request);
      writeJsonAtomic(resolve(paths.responseDir, `${id}.json`), {
        ok: true,
        protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
        id,
        generation: envelope.generation,
        response,
      });
    } catch (error) {
      writeJsonAtomic(resolve(paths.responseDir, `${id}.json`), {
        ok: false,
        protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      opts.afterRequest?.();
      rmSync(requestPath, { force: true });
      processed += 1;
    }
  }
  return processed;
}

function referenceMap(
  provider: ReturnType<TypeScriptSemanticHost['semanticProvider']>,
  definitions: Parameters<
    NonNullable<ReturnType<TypeScriptSemanticHost['semanticProvider']>['referencesForDefinitions']>
  >[0],
) {
  return (
    provider.referencesForDefinitions?.(definitions) ??
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

function readPublishedSnapshot(dbPath: string): ProjectInputSnapshot | null {
  try {
    const metadata = JSON.parse(readFileSync(resolve(dbPath, '..', 'meta.json'), 'utf8')) as {
      fingerprint?: unknown;
    };
    return projectInputSnapshotOrNull(metadata.fingerprint);
  } catch {
    return null;
  }
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
