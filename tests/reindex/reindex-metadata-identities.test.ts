import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as metadata from '../../src/domain/reindex-metadata.js';

import { canonicalReindexMetadataIdentity, decodeReindexMetadata } from '../../src/domain/reindex-metadata.js';
import { publishedTypeScriptIndexGeneration } from '../../src/reindex/typescript-index-protocol.js';
import { stableMetadataIdentity } from '../../src/storage/sqlite-generation.js';
import { FUTURE_REINDEX_METADATA, REINDEX_METADATA_CAPABILITY_CASES } from '../fixtures/reindex-metadata.js';

describe('reindex metadata identity consumers', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reuses decoding only for identical bytes and detects same-size edits with restored timestamps', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'scip-query-metadata-bytes-'));
    tempDirs.push(cacheDir);
    const dbPath = join(cacheDir, 'index.db');
    const metaPath = join(cacheDir, 'meta.json');
    const record = { ...REINDEX_METADATA_CAPABILITY_CASES[1]!.record, fingerprint: { file: cacheDir, revision: 'a' } };
    const raw = JSON.stringify(record);
    const decode = vi.spyOn(metadata, 'decodeReindexMetadata');
    writeFileSync(metaPath, raw);
    const first = publishedTypeScriptIndexGeneration(dbPath);
    expect(first).not.toBeNull();
    expect(publishedTypeScriptIndexGeneration(dbPath)).toBe(first);
    expect(decode).toHaveBeenCalledTimes(1);
    const before = statSync(metaPath);
    writeFileSync(metaPath, JSON.stringify({ ...record, fingerprint: { ...record.fingerprint, revision: 'b' } }));
    utimesSync(metaPath, before.atime, before.mtime);
    const changed = publishedTypeScriptIndexGeneration(dbPath);
    expect(changed).not.toBe(first);
    expect(changed).not.toBeNull();
    expect(publishedTypeScriptIndexGeneration(dbPath)).toBe(changed);
    expect(decode).toHaveBeenCalledTimes(2);
    writeFileSync(metaPath, JSON.stringify(FUTURE_REINDEX_METADATA));
    expect(publishedTypeScriptIndexGeneration(dbPath)).toBeNull();
    rmSync(metaPath);
    expect(publishedTypeScriptIndexGeneration(dbPath)).toBeNull();
    writeFileSync(metaPath, raw);
    expect(publishedTypeScriptIndexGeneration(dbPath)).toBe(first);
  });

  it.each(REINDEX_METADATA_CAPABILITY_CASES)(
    'applies the shared stable-identity capability to $name',
    ({ record, capabilities }) => {
      const raw = JSON.stringify(record, null, 2);
      const decoded = decodeReindexMetadata(raw);
      const canonical = canonicalReindexMetadataIdentity(decoded);
      expect(canonical === null).toBe(!capabilities.stableGenerationIdentity);
      expect(stableMetadataIdentity(raw)).toBe(canonical ?? raw);
    },
  );

  it('uses the decoder canonical projection for the TypeScript index generation', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'scip-query-metadata-identity-'));
    tempDirs.push(cacheDir);
    const dbPath = join(cacheDir, 'index.db');
    const current = REINDEX_METADATA_CAPABILITY_CASES[1]!.record;
    const canonical = canonicalReindexMetadataIdentity(decodeReindexMetadata(current))!;
    writeFileSync(join(cacheDir, 'meta.json'), JSON.stringify(current, null, 2));

    expect(publishedTypeScriptIndexGeneration(dbPath)).toBe(createHash('sha256').update(canonical).digest('hex'));
  });

  it.each([
    ['future', FUTURE_REINDEX_METADATA],
    ['malformed', { version: 3, status: 'complete', fingerprint: 'not-an-object' }],
    ['missing', null],
  ])('refuses a %s metadata record as a TypeScript index generation', (_name, record) => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'scip-query-metadata-identity-invalid-'));
    tempDirs.push(cacheDir);
    const dbPath = join(cacheDir, 'index.db');
    mkdirSync(cacheDir, { recursive: true });
    if (record !== null) writeFileSync(join(cacheDir, 'meta.json'), JSON.stringify(record));

    expect(publishedTypeScriptIndexGeneration(dbPath)).toBeNull();
  });
});
