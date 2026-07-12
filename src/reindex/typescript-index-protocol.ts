import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SemanticReferenceFragment } from '../semantic/types.js';

export const TYPESCRIPT_INDEX_PROTOCOL_VERSION = 2;
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

export interface TypeScriptIndexEnvelope {
  protocolVersion: typeof TYPESCRIPT_INDEX_PROTOCOL_VERSION;
  id: string;
  baseGeneration: string;
  deadlineAtMs: number;
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
}

export interface TypeScriptIndexMailboxPaths {
  rootDir: string;
  requestDir: string;
  responseDir: string;
}

export function typeScriptIndexMailboxPaths(cacheDir: string): TypeScriptIndexMailboxPaths {
  const rootDir = join(cacheDir, TYPESCRIPT_INDEX_MAILBOX_DIRECTORY);
  return {
    rootDir,
    requestDir: join(rootDir, 'requests'),
    responseDir: join(rootDir, 'responses'),
  };
}

export function parseTypeScriptIndexEnvelope(raw: string): TypeScriptIndexEnvelope {
  const parsed = JSON.parse(raw) as Partial<TypeScriptIndexEnvelope>;
  if (
    parsed.protocolVersion !== TYPESCRIPT_INDEX_PROTOCOL_VERSION ||
    typeof parsed.id !== 'string' ||
    !parsed.id ||
    typeof parsed.baseGeneration !== 'string' ||
    !parsed.baseGeneration ||
    typeof parsed.deadlineAtMs !== 'number' ||
    !Number.isFinite(parsed.deadlineAtMs) ||
    !isTypeScriptIndexRequest(parsed.request)
  ) {
    throw new Error('TypeScript index service received an invalid mailbox request.');
  }
  return parsed as TypeScriptIndexEnvelope;
}

export function publishedTypeScriptIndexGeneration(dbPath: string): string | null {
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
      metadata.status !== 'complete' ||
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
    new Set(affectedFiles).size === affectedFiles.length &&
    modifiedFiles.every((file) => affectedFiles.includes(file))
  );
}

// scip-query: ignore-twin — protocol validators intentionally stay beside their wire schemas.
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}
