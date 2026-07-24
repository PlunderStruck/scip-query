import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IndexedDefinition } from '../../domain/types.js';
import type { ProfileEnvironment } from '../../instrumentation/profile.js';
import { stringArray } from '../../storage/evidence-payload.js';

export const TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION = 2;
export const TYPESCRIPT_SEMANTIC_MAILBOX_DIR = 'typescript-semantic';

export type TypeScriptSemanticRequest =
  | { kind: 'availability' }
  | { kind: 'import-usage'; file: string }
  | { kind: 'references'; definitions: IndexedDefinition[]; exact?: boolean }
  | { kind: 'reference-fragments'; files: string[] }
  | { kind: 'callees'; definitions: IndexedDefinition[] }
  | { kind: 'signature'; definition: IndexedDefinition };

export interface TypeScriptSemanticMailboxEnvelope {
  protocolVersion: typeof TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION;
  id: string;
  generation: string;
  deadlineAtMs: number;
  profileEnvironment?: ProfileEnvironment;
  request: TypeScriptSemanticRequest;
}

// scip-query: ignore-stale — reviewed S1 owned contract; this protocol module defines and validates the service payload.
export interface TypeScriptSemanticServiceStatus {
  protocolVersion: typeof TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION;
  state: 'idle' | 'ready' | 'unavailable' | 'error';
  requests: number;
  lastRequestAt?: string;
  lastError?: string;
  busyUntil?: string;
  sessionsCreated: number;
  sessionsReused: number;
  sessionsRefreshed: number;
  sessionsReplaced: number;
  projectsCreated: number;
}

// scip-query: ignore-stale — reviewed S1 owned contract; these paths name the semantic-service mailbox boundary.
export interface TypeScriptSemanticMailboxPaths {
  rootDir: string;
  requestDir: string;
  responseDir: string;
}

export function typeScriptSemanticMailboxPaths(cacheDir: string): TypeScriptSemanticMailboxPaths {
  const rootDir = join(cacheDir, TYPESCRIPT_SEMANTIC_MAILBOX_DIR);
  return {
    rootDir,
    requestDir: join(rootDir, 'requests'),
    responseDir: join(rootDir, 'responses'),
  };
}

export function publishedGenerationIdentity(dbPath: string): string | null {
  try {
    const metadata = JSON.parse(readFileSync(join(dirname(dbPath), 'meta.json'), 'utf8')) as {
      version?: unknown;
      status?: unknown;
      updatedAt?: unknown;
      fingerprint?: unknown;
      indexedLanguages?: unknown;
    };
    if (
      (metadata.version !== 2 && metadata.version !== 3) ||
      typeof metadata.status !== 'string' ||
      typeof metadata.updatedAt !== 'string' ||
      metadata.fingerprint === undefined
    ) {
      return null;
    }
    return createHash('sha256')
      .update(
        JSON.stringify({
          version: metadata.version,
          status: metadata.status,
          updatedAt: metadata.updatedAt,
          fingerprint: metadata.fingerprint,
          indexedLanguages: metadata.indexedLanguages,
        }),
      )
      .digest('hex');
  } catch {
    return null;
  }
}

export function parseTypeScriptSemanticEnvelope(raw: string): TypeScriptSemanticMailboxEnvelope {
  const parsed = JSON.parse(raw) as Partial<TypeScriptSemanticMailboxEnvelope>;
  if (
    parsed.protocolVersion !== TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION ||
    typeof parsed.id !== 'string' ||
    typeof parsed.generation !== 'string' ||
    typeof parsed.deadlineAtMs !== 'number' ||
    (parsed.profileEnvironment !== undefined && !isProfileEnvironment(parsed.profileEnvironment)) ||
    !parsed.request ||
    !isTypeScriptSemanticRequest(parsed.request)
  ) {
    throw new Error('TypeScript semantic service received an invalid mailbox request.');
  }
  return parsed as TypeScriptSemanticMailboxEnvelope;
}

function isProfileEnvironment(value: unknown): value is ProfileEnvironment {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string' || entry === null)
  );
}

function isTypeScriptSemanticRequest(value: unknown): value is TypeScriptSemanticRequest {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false;
  const request = value as {
    kind?: unknown;
    file?: unknown;
    files?: unknown;
    definitions?: unknown;
    definition?: unknown;
    exact?: unknown;
  };
  switch (request.kind) {
    case 'availability':
      return true;
    case 'import-usage':
      return typeof request.file === 'string';
    case 'reference-fragments':
      return stringArray(request.files) !== null;
    case 'references':
      return (
        definitionArray(request.definitions) && (request.exact === undefined || typeof request.exact === 'boolean')
      );
    case 'callees':
      return definitionArray(request.definitions);
    case 'signature':
      return isIndexedDefinition(request.definition);
    default:
      return false;
  }
}

function definitionArray(value: unknown): value is IndexedDefinition[] {
  return Array.isArray(value) && value.every(isIndexedDefinition);
}

function isIndexedDefinition(value: unknown): value is IndexedDefinition {
  if (!value || typeof value !== 'object') return false;
  const definition = value as Partial<IndexedDefinition>;
  return (
    typeof definition.symbolId === 'number' &&
    typeof definition.documentId === 'number' &&
    typeof definition.symbol === 'string' &&
    typeof definition.relativePath === 'string' &&
    typeof definition.leaf === 'string' &&
    typeof definition.startLine === 'number' &&
    typeof definition.endLine === 'number'
  );
}
