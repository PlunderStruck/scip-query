import { isProjectFileFingerprint, type ProjectFileFingerprint } from './project-input.js';
import { isValidRecordTimestamp } from './record-validation.js';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './config-types.js';
import type { LastRefreshMetadata } from './maintenance-types.js';

export const LEGACY_REINDEX_METADATA_VERSION = 2;
export const CURRENT_REINDEX_METADATA_VERSION = 3;
export const RESERVED_REINDEX_METADATA_VERSION = 4;

export type ReindexMetadataStatus = 'complete' | 'partial';

interface ReindexMetadataCommon {
  status: ReindexMetadataStatus;
  updatedAt?: string;
  fingerprint?: unknown;
  requestedLanguages?: SupportedLanguage[];
  indexedLanguages?: SupportedLanguage[];
  skipped?: { language: SupportedLanguage; reason: string }[];
  lastRefresh?: LastRefreshMetadata;
  scipCompanion?: 'current' | 'deferred';
  [field: string]: unknown;
}

export interface ReindexMetadataV2 extends ReindexMetadataCommon {
  version: typeof LEGACY_REINDEX_METADATA_VERSION;
}

export interface ReindexMetadataV3 extends ReindexMetadataCommon {
  version: typeof CURRENT_REINDEX_METADATA_VERSION;
  languageFingerprints?: Partial<Record<SupportedLanguage, unknown>>;
  typescriptProjectShards?: Record<string, { files: ProjectFileFingerprint[] }>;
}

export type ReindexMetadata = ReindexMetadataV2 | ReindexMetadataV3;

export interface ReindexMetadataCapabilities {
  usableForQuery: boolean;
  usableForEvidenceCache: boolean;
  publishableGeneration: boolean;
  stableGenerationIdentity: boolean;
  languageShardReuse: boolean;
  typescriptProjectShardReuse: boolean;
}

interface AcceptedReindexMetadata {
  metadata: ReindexMetadata;
  capabilities: ReindexMetadataCapabilities;
}

export type DecodedReindexMetadata =
  | ({ kind: 'supported'; metadata: ReindexMetadataV3 } & AcceptedReindexMetadata)
  | ({ kind: 'legacy'; metadata: ReindexMetadataV2 } & AcceptedReindexMetadata)
  | { kind: 'unsupported'; version: number; direction: 'older' | 'future' }
  | { kind: 'malformed'; reason: string };

const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPPORTED_LANGUAGES);

/**
 * Decodes the persisted metadata record shared by reindex, freshness,
 * generation, and semantic-cache consumers. Version 2 is a readable legacy
 * record; version 3 is current; version 4 is deliberately reserved so adding
 * it requires changing this one boundary and its capability matrix.
 */
export function decodeReindexMetadata(input: unknown): DecodedReindexMetadata {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (error) {
      return { kind: 'malformed', reason: `invalid JSON: ${errorMessage(error)}` };
    }
  }
  if (!isRecord(value)) return { kind: 'malformed', reason: 'metadata must be a JSON object' };
  const version = value['version'];
  if (!Number.isInteger(version)) return { kind: 'malformed', reason: 'version must be an integer' };
  if (version !== LEGACY_REINDEX_METADATA_VERSION && version !== CURRENT_REINDEX_METADATA_VERSION) {
    return {
      kind: 'unsupported',
      version: version as number,
      direction: (version as number) < LEGACY_REINDEX_METADATA_VERSION ? 'older' : 'future',
    };
  }
  const problem = validateSupportedMetadata(value, version);
  if (problem) return { kind: 'malformed', reason: problem };
  const metadata = value as unknown as ReindexMetadata;
  const accepted = {
    metadata,
    capabilities: reindexMetadataCapabilities(metadata),
  };
  return version === LEGACY_REINDEX_METADATA_VERSION
    ? { kind: 'legacy', ...accepted, metadata: metadata as ReindexMetadataV2 }
    : { kind: 'supported', ...accepted, metadata: metadata as ReindexMetadataV3 };
}

export function acceptedReindexMetadata(decoded: DecodedReindexMetadata): ReindexMetadata | null {
  return decoded.kind === 'legacy' || decoded.kind === 'supported' ? decoded.metadata : null;
}

export function canonicalReindexMetadataIdentity(decoded: DecodedReindexMetadata): string | null {
  if ((decoded.kind !== 'legacy' && decoded.kind !== 'supported') || !decoded.capabilities.stableGenerationIdentity) {
    return null;
  }
  const metadata = decoded.metadata;
  return JSON.stringify({
    version: metadata.version,
    status: metadata.status,
    updatedAt: metadata.updatedAt,
    fingerprint: metadata.fingerprint,
    indexedLanguages: metadata.indexedLanguages,
    scipCompanion: metadata.scipCompanion,
  });
}

export function reindexMetadataCapabilities(metadata: ReindexMetadata): ReindexMetadataCapabilities {
  const hasFingerprint = metadata.fingerprint !== undefined;
  const hasStructuredFingerprint = isRecord(metadata.fingerprint);
  const hasIndexedLanguages = metadata.indexedLanguages !== undefined;
  const complete = metadata.status === 'complete';
  const v3 = metadata.version === CURRENT_REINDEX_METADATA_VERSION ? metadata : null;
  return {
    usableForQuery: hasIndexedLanguages,
    usableForEvidenceCache: hasFingerprint,
    publishableGeneration: complete && hasStructuredFingerprint && hasIndexedLanguages,
    stableGenerationIdentity: complete && hasFingerprint && typeof metadata.updatedAt === 'string',
    languageShardReuse: Boolean(v3?.languageFingerprints),
    typescriptProjectShardReuse: Boolean(v3?.typescriptProjectShards),
  };
}

function validateSupportedMetadata(value: Record<string, unknown>, version: number): string | null {
  if (value['status'] !== 'complete' && value['status'] !== 'partial') {
    return 'status must be complete or partial';
  }
  if (value['updatedAt'] !== undefined && !isValidRecordTimestamp(value['updatedAt'])) {
    return 'updatedAt must be a valid timestamp';
  }
  for (const field of ['requestedLanguages', 'indexedLanguages'] as const) {
    if (value[field] !== undefined && !isSupportedLanguageArray(value[field])) {
      return `${field} must contain unique supported languages`;
    }
  }
  if (value['skipped'] !== undefined && !isSkippedLanguageArray(value['skipped'])) {
    return 'skipped must contain supported language/reason pairs';
  }
  if (
    value['scipCompanion'] !== undefined &&
    value['scipCompanion'] !== 'current' &&
    value['scipCompanion'] !== 'deferred'
  ) {
    return 'scipCompanion must be current or deferred';
  }
  if (
    version === CURRENT_REINDEX_METADATA_VERSION &&
    value['languageFingerprints'] !== undefined &&
    !isLanguageFingerprintMap(value['languageFingerprints'])
  ) {
    return 'languageFingerprints must map supported languages to fingerprint objects';
  }
  if (
    version === CURRENT_REINDEX_METADATA_VERSION &&
    value['typescriptProjectShards'] !== undefined &&
    !isTypeScriptProjectShardMap(value['typescriptProjectShards'])
  ) {
    return 'typescriptProjectShards must map project names to file fingerprints';
  }
  return null;
}

function isSupportedLanguageArray(value: unknown): value is SupportedLanguage[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === 'string' && SUPPORTED_LANGUAGE_SET.has(entry))
  ) {
    return false;
  }
  return new Set(value).size === value.length;
}

function isSkippedLanguageArray(value: unknown): value is { language: SupportedLanguage; reason: string }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry['language'] === 'string' &&
        SUPPORTED_LANGUAGE_SET.has(entry['language']) &&
        typeof entry['reason'] === 'string',
    )
  );
}

function isLanguageFingerprintMap(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([language, fingerprint]) => SUPPORTED_LANGUAGE_SET.has(language) && isRecord(fingerprint),
    )
  );
}

function isTypeScriptProjectShardMap(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (shard) => isRecord(shard) && Array.isArray(shard['files']) && shard['files'].every(isProjectFileFingerprint),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
