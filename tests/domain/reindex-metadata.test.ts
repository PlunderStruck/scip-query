import { describe, expect, it } from 'vitest';

import {
  CURRENT_REINDEX_METADATA_VERSION,
  decodeReindexMetadata,
  RESERVED_REINDEX_METADATA_VERSION,
  canonicalReindexMetadataIdentity,
} from '../../src/domain/reindex-metadata.js';
import {
  FUTURE_REINDEX_METADATA,
  REINDEX_METADATA_CAPABILITY_CASES,
  REINDEX_METADATA_COMMON,
} from '../fixtures/reindex-metadata.js';

describe('reindex metadata decoder', () => {
  it.each(REINDEX_METADATA_CAPABILITY_CASES)(
    'classifies the $name capability row',
    ({ record, kind, capabilities }) => {
      const decoded = decodeReindexMetadata(record);
      expect(decoded.kind).toBe(kind);
      if (decoded.kind === 'legacy' || decoded.kind === 'supported') {
        expect(decoded.capabilities).toEqual(capabilities);
      }
    },
  );

  it('makes a reserved future version visible instead of casting it to the current model', () => {
    expect(decodeReindexMetadata(FUTURE_REINDEX_METADATA)).toEqual({
      kind: 'unsupported',
      version: RESERVED_REINDEX_METADATA_VERSION,
      direction: 'future',
    });
  });

  it.each([
    ['invalid JSON', '{'],
    ['missing version', { ...REINDEX_METADATA_COMMON }],
    ['fractional version', { version: 2.5, ...REINDEX_METADATA_COMMON }],
    ['missing status', { version: 3 }],
    ['unknown status', { version: 3, ...REINDEX_METADATA_COMMON, status: 'ready' }],
    ['invalid timestamp', { version: 3, ...REINDEX_METADATA_COMMON, updatedAt: 'today' }],
    [
      'unknown indexed language',
      { version: 3, ...REINDEX_METADATA_COMMON, indexedLanguages: ['typescript', 'brainfuck'] },
    ],
    [
      'duplicate indexed language',
      { version: 3, ...REINDEX_METADATA_COMMON, indexedLanguages: ['typescript', 'typescript'] },
    ],
    ['invalid skipped row', { version: 3, ...REINDEX_METADATA_COMMON, skipped: [{ language: 'typescript' }] }],
    ['unknown companion state', { version: 3, ...REINDEX_METADATA_COMMON, scipCompanion: 'stale' }],
    ['unknown shard language', { version: 3, ...REINDEX_METADATA_COMMON, languageFingerprints: { brainfuck: {} } }],
    [
      'invalid project shard',
      { version: 3, ...REINDEX_METADATA_COMMON, typescriptProjectShards: { '.': { files: [{}] } } },
    ],
  ])('rejects %s', (_name, record) => {
    expect(decodeReindexMetadata(record)).toEqual(expect.objectContaining({ kind: 'malformed' }));
  });

  it('uses the same canonical identity projection for pretty and compact current records', () => {
    const record = {
      version: CURRENT_REINDEX_METADATA_VERSION,
      ...REINDEX_METADATA_COMMON,
      scipCompanion: 'current',
      extensionOwnedByFutureWriter: { retained: true },
    };
    const compact = decodeReindexMetadata(JSON.stringify(record));
    const pretty = decodeReindexMetadata(JSON.stringify(record, null, 2));
    expect(canonicalReindexMetadataIdentity(compact)).toBe(canonicalReindexMetadataIdentity(pretty));
    expect(canonicalReindexMetadataIdentity(compact)).not.toContain('extensionOwnedByFutureWriter');
  });
});
