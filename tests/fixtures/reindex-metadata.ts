import {
  CURRENT_REINDEX_METADATA_VERSION,
  LEGACY_REINDEX_METADATA_VERSION,
  RESERVED_REINDEX_METADATA_VERSION,
} from '../../src/domain/reindex-metadata.js';

export const REINDEX_METADATA_COMMON = {
  status: 'complete',
  updatedAt: '2026-07-25T12:00:00.000Z',
  fingerprint: { version: 2, languages: ['typescript'], files: [] },
  requestedLanguages: ['typescript'],
  indexedLanguages: ['typescript'],
  skipped: [],
} as const;

export const REINDEX_METADATA_CAPABILITY_CASES = [
  {
    name: 'legacy complete',
    record: { version: LEGACY_REINDEX_METADATA_VERSION, ...REINDEX_METADATA_COMMON },
    kind: 'legacy',
    capabilities: {
      usableForQuery: true,
      usableForEvidenceCache: true,
      publishableGeneration: true,
      stableGenerationIdentity: true,
      languageShardReuse: false,
      typescriptProjectShardReuse: false,
    },
  },
  {
    name: 'current complete with shard capabilities',
    record: {
      version: CURRENT_REINDEX_METADATA_VERSION,
      ...REINDEX_METADATA_COMMON,
      languageFingerprints: { typescript: { version: 2 } },
      typescriptProjectShards: { '.': { files: [] } },
    },
    kind: 'supported',
    capabilities: {
      usableForQuery: true,
      usableForEvidenceCache: true,
      publishableGeneration: true,
      stableGenerationIdentity: true,
      languageShardReuse: true,
      typescriptProjectShardReuse: true,
    },
  },
  {
    name: 'current partial remains evidence-usable but not publishable',
    record: { version: CURRENT_REINDEX_METADATA_VERSION, ...REINDEX_METADATA_COMMON, status: 'partial' },
    kind: 'supported',
    capabilities: {
      usableForQuery: true,
      usableForEvidenceCache: true,
      publishableGeneration: false,
      stableGenerationIdentity: false,
      languageShardReuse: false,
      typescriptProjectShardReuse: false,
    },
  },
  {
    name: 'current record without a fingerprint is only query-usable',
    record: {
      version: CURRENT_REINDEX_METADATA_VERSION,
      status: 'complete',
      indexedLanguages: ['typescript'],
    },
    kind: 'supported',
    capabilities: {
      usableForQuery: true,
      usableForEvidenceCache: false,
      publishableGeneration: false,
      stableGenerationIdentity: false,
      languageShardReuse: false,
      typescriptProjectShardReuse: false,
    },
  },
  {
    name: 'current identity record can omit indexed languages',
    record: {
      version: CURRENT_REINDEX_METADATA_VERSION,
      status: 'complete',
      updatedAt: REINDEX_METADATA_COMMON.updatedAt,
      fingerprint: REINDEX_METADATA_COMMON.fingerprint,
    },
    kind: 'supported',
    capabilities: {
      usableForQuery: false,
      usableForEvidenceCache: true,
      publishableGeneration: false,
      stableGenerationIdentity: true,
      languageShardReuse: false,
      typescriptProjectShardReuse: false,
    },
  },
  {
    name: 'current opaque fingerprint remains an evidence and identity key',
    record: {
      version: CURRENT_REINDEX_METADATA_VERSION,
      status: 'complete',
      updatedAt: REINDEX_METADATA_COMMON.updatedAt,
      fingerprint: 'opaque-legacy-producer-key',
      indexedLanguages: ['rust'],
    },
    kind: 'supported',
    capabilities: {
      usableForQuery: true,
      usableForEvidenceCache: true,
      publishableGeneration: false,
      stableGenerationIdentity: true,
      languageShardReuse: false,
      typescriptProjectShardReuse: false,
    },
  },
] as const;

export const FUTURE_REINDEX_METADATA = {
  version: RESERVED_REINDEX_METADATA_VERSION,
  ...REINDEX_METADATA_COMMON,
} as const;
