import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { canonicalReindexMetadataIdentity, decodeReindexMetadata } from '../domain/reindex-metadata.js';
import type { SemanticReferenceFragment } from '../semantic/types.js';
import {
  BOUNDED_MAILBOX_VERSION,
  boundedMailboxOperationKey,
  boundedMailboxPaths,
  boundedMailboxRequestId,
  type BoundedMailboxPaths,
  type BoundedMailboxRequestIdentity,
  type BoundedMailboxStatus,
} from '../storage/bounded-mailbox.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';

export const TYPESCRIPT_INDEX_PROTOCOL_VERSION = 4;
export const TYPESCRIPT_INDEX_PREVIOUS_PROTOCOL_VERSION = 3;
export const TYPESCRIPT_INDEX_LEGACY_PROTOCOL_VERSION = 2;
export const TYPESCRIPT_INDEX_MAILBOX_DIRECTORY = 'typescript-index';

export interface TypeScriptIndexDocumentRequest {
  kind: 'emit-documents';
  tsconfigPath: string;
  projectArgument: string;
  projectIdentity: string;
  producerIdentity: string;
  modifiedFiles: string[];
  affectedFiles: string[];
}

export interface TypeScriptIndexEnvelope extends BoundedMailboxRequestIdentity {
  protocolVersion: typeof TYPESCRIPT_INDEX_PROTOCOL_VERSION;
  baseGeneration: string;
  request: TypeScriptIndexDocumentRequest;
}

export interface TypeScriptIndexResponseFragment {
  relativePath: string;
  bytesBase64: string | null;
  occurrences: number;
  symbols: number;
  referenceFragments: SemanticReferenceFragment[];
}

export interface TypeScriptIndexDocumentResponse {
  producerIdentity: string;
  cold: boolean;
  durationMs: number;
  fragments: TypeScriptIndexResponseFragment[];
}

// scip-query: ignore-stale — reviewed S1 owned contract; this protocol module defines and validates the service payload.
export interface TypeScriptIndexServiceStatus {
  protocolVersion: typeof TYPESCRIPT_INDEX_PROTOCOL_VERSION;
  state: 'idle' | 'ready' | 'unavailable' | 'error';
  requests: number;
  sessionsCreated: number;
  sessionsReplaced: number;
  initializations: number;
  programUpdates: number;
  documentsEmitted: number;
  documentsRemoved: number;
  lastRequestAt?: string;
  lastDurationMs?: number;
  lastError?: string;
  busyUntil?: string;
  mailbox?: BoundedMailboxStatus;
}

// scip-query: ignore-stale — reviewed S1 owned contract; these paths name the index-service mailbox boundary.
export interface TypeScriptIndexMailboxPaths extends BoundedMailboxPaths {
  /** Flat v2 request directory retained for overlap reads. */
  requestDir: string;
}

export function typeScriptIndexMailboxPaths(cacheDir: string): TypeScriptIndexMailboxPaths {
  const rootDir = join(cacheDir, TYPESCRIPT_INDEX_MAILBOX_DIRECTORY);
  const paths = boundedMailboxPaths(rootDir);
  return {
    ...paths,
    requestDir: paths.legacyRequestDir,
  };
}

export function parseTypeScriptIndexEnvelope(raw: string): TypeScriptIndexEnvelope {
  const parsed = JSON.parse(raw) as Partial<TypeScriptIndexEnvelope>;
  const protocolVersion = (parsed as { protocolVersion?: unknown }).protocolVersion;
  const legacy = protocolVersion === TYPESCRIPT_INDEX_LEGACY_PROTOCOL_VERSION;
  const previous = protocolVersion === TYPESCRIPT_INDEX_PREVIOUS_PROTOCOL_VERSION;
  if (
    (!legacy && !previous && protocolVersion !== TYPESCRIPT_INDEX_PROTOCOL_VERSION) ||
    typeof parsed.id !== 'string' ||
    !parsed.id ||
    typeof parsed.baseGeneration !== 'string' ||
    !parsed.baseGeneration ||
    typeof parsed.deadlineAtMs !== 'number' ||
    !Number.isFinite(parsed.deadlineAtMs) ||
    !isTypeScriptIndexRequest(parsed.request) ||
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
    throw new Error('TypeScript index service received an invalid mailbox request.');
  }
  if (!legacy) {
    const current = parsed as TypeScriptIndexEnvelope;
    const expectedOperationKey = boundedMailboxOperationKey(previous ? 'typescript-index-v3' : 'typescript-index-v4', {
      baseGeneration: current.baseGeneration,
      request: current.request,
    });
    if (current.operationKey !== expectedOperationKey) {
      throw new Error('TypeScript index service received a mismatched mailbox operation identity.');
    }
    return { ...current, protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION };
  }
  const operationKey = boundedMailboxOperationKey('typescript-index-v2', {
    id: parsed.id,
    baseGeneration: parsed.baseGeneration,
    request: parsed.request,
  });
  return {
    protocolVersion: TYPESCRIPT_INDEX_PROTOCOL_VERSION,
    mailboxVersion: BOUNDED_MAILBOX_VERSION,
    id: parsed.id,
    operationKey,
    clientId: 'legacy-v2',
    enqueuedAtMs: parsed.deadlineAtMs,
    deadlineAtMs: parsed.deadlineAtMs,
    baseGeneration: parsed.baseGeneration,
    request: parsed.request,
  };
}

export function publishedTypeScriptIndexGeneration(dbPath: string): string | null {
  try {
    const canonical = canonicalReindexMetadataIdentity(
      decodeReindexMetadata(readSmallArtifactText(join(dirname(dbPath), 'meta.json'), 'reindex metadata')),
    );
    return canonical ? createHash('sha256').update(canonical).digest('hex') : null;
  } catch {
    return null;
  }
}

function isTypeScriptIndexRequest(value: unknown): value is TypeScriptIndexDocumentRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<TypeScriptIndexDocumentRequest>;
  const modifiedFiles = stringArray(request.modifiedFiles) ? request.modifiedFiles : null;
  const affectedFiles = stringArray(request.affectedFiles) ? request.affectedFiles : null;
  return (
    request.kind === 'emit-documents' &&
    typeof request.tsconfigPath === 'string' &&
    Boolean(request.tsconfigPath) &&
    typeof request.projectArgument === 'string' &&
    Boolean(request.projectArgument) &&
    typeof request.projectIdentity === 'string' &&
    Boolean(request.projectIdentity) &&
    typeof request.producerIdentity === 'string' &&
    Boolean(request.producerIdentity) &&
    modifiedFiles !== null &&
    modifiedFiles.length > 0 &&
    new Set(modifiedFiles).size === modifiedFiles.length &&
    affectedFiles !== null &&
    affectedFiles.length > 0 &&
    new Set(affectedFiles).size === affectedFiles.length
  );
}

// scip-query: ignore-twin — protocol validators intentionally stay beside their wire schemas.
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}
