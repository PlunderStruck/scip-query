import { join } from 'node:path';
import { isStringOrNullRecord } from '../../domain/record-validation.js';
import type { IndexedDefinition } from '../../domain/types.js';
import type { ProfileEnvironment } from '../../instrumentation/profile.js';
import { stringArray } from '../../storage/evidence-payload.js';
import {
  BOUNDED_MAILBOX_VERSION,
  boundedMailboxOperationKey,
  boundedMailboxPaths,
  boundedMailboxRequestId,
  type BoundedMailboxPaths,
  type BoundedMailboxRequestIdentity,
  type BoundedMailboxStatus,
} from '../../storage/bounded-mailbox.js';

export const TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION = 3;
export const TYPESCRIPT_SEMANTIC_LEGACY_PROTOCOL_VERSION = 2;
export const TYPESCRIPT_SEMANTIC_MAILBOX_DIR = 'typescript-semantic';

export type TypeScriptSemanticRequest =
  | { kind: 'availability' }
  | { kind: 'import-usage'; file: string }
  | { kind: 'references'; definitions: IndexedDefinition[]; exact?: boolean }
  | { kind: 'reference-fragments'; files: string[] }
  | { kind: 'callees'; definitions: IndexedDefinition[] }
  | { kind: 'callee-coverage'; definitions: IndexedDefinition[] }
  | { kind: 'signature'; definition: IndexedDefinition };

export interface TypeScriptSemanticMailboxEnvelope extends BoundedMailboxRequestIdentity {
  protocolVersion: typeof TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION;
  generation: string;
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
  heapUsedBytes?: number;
  heapLimitBytes?: number;
  softMemoryLimitBytes?: number;
  /** The worker asks to be retired after this response so its compiler programs are released. */
  retireRequested?: boolean;
  mailbox?: BoundedMailboxStatus;
}

// scip-query: ignore-stale — reviewed S1 owned contract; these paths name the semantic-service mailbox boundary.
export interface TypeScriptSemanticMailboxPaths extends BoundedMailboxPaths {
  /** Flat v2 request directory retained for overlap reads. */
  requestDir: string;
}

export function typeScriptSemanticMailboxPaths(cacheDir: string): TypeScriptSemanticMailboxPaths {
  const rootDir = join(cacheDir, TYPESCRIPT_SEMANTIC_MAILBOX_DIR);
  const paths = boundedMailboxPaths(rootDir);
  return {
    ...paths,
    requestDir: paths.legacyRequestDir,
  };
}

export function parseTypeScriptSemanticEnvelope(raw: string): TypeScriptSemanticMailboxEnvelope {
  const parsed = JSON.parse(raw) as Partial<TypeScriptSemanticMailboxEnvelope>;
  const protocolVersion = (parsed as { protocolVersion?: unknown }).protocolVersion;
  const legacy = protocolVersion === TYPESCRIPT_SEMANTIC_LEGACY_PROTOCOL_VERSION;
  if (
    (!legacy && protocolVersion !== TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION) ||
    typeof parsed.id !== 'string' ||
    typeof parsed.generation !== 'string' ||
    typeof parsed.deadlineAtMs !== 'number' ||
    !Number.isFinite(parsed.deadlineAtMs) ||
    (parsed.profileEnvironment !== undefined && !isStringOrNullRecord(parsed.profileEnvironment)) ||
    !parsed.request ||
    !isTypeScriptSemanticRequest(parsed.request) ||
    (!legacy &&
      (parsed.mailboxVersion !== BOUNDED_MAILBOX_VERSION ||
        typeof parsed.operationKey !== 'string' ||
        !/^[a-f0-9]{64}$/.test(parsed.operationKey) ||
        parsed.id !== boundedMailboxRequestId(parsed.operationKey) ||
        typeof parsed.clientId !== 'string' ||
        !parsed.clientId ||
        typeof parsed.enqueuedAtMs !== 'number' ||
        !Number.isFinite(parsed.enqueuedAtMs) ||
        parsed.deadlineAtMs < parsed.enqueuedAtMs))
  ) {
    throw new Error('TypeScript semantic service received an invalid mailbox request.');
  }
  if (!legacy) {
    const current = parsed as TypeScriptSemanticMailboxEnvelope;
    const expectedOperationKey = boundedMailboxOperationKey('typescript-semantic-v3', {
      generation: current.generation,
      profileEnvironment: current.profileEnvironment,
      request: current.request,
    });
    if (current.operationKey !== expectedOperationKey) {
      throw new Error('TypeScript semantic service received a mismatched mailbox operation identity.');
    }
    return current;
  }
  const operationKey = boundedMailboxOperationKey('typescript-semantic-v2', {
    id: parsed.id,
    generation: parsed.generation,
    request: parsed.request,
  });
  return {
    protocolVersion: TYPESCRIPT_SEMANTIC_PROTOCOL_VERSION,
    mailboxVersion: BOUNDED_MAILBOX_VERSION,
    id: parsed.id,
    operationKey,
    clientId: 'legacy-v2',
    enqueuedAtMs: parsed.deadlineAtMs,
    deadlineAtMs: parsed.deadlineAtMs,
    generation: parsed.generation,
    ...(parsed.profileEnvironment ? { profileEnvironment: parsed.profileEnvironment } : {}),
    request: parsed.request,
  };
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
    case 'callee-coverage':
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
