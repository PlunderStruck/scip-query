import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchVerifiedBinary, resolveScipQueryCachePath, sha256 } from '../../src/platform/verified-binary-fetch.js';

describe('resolveScipQueryCachePath', () => {
  it('prefers SCIP_QUERY_CACHE_DIR, falls back to XDG_CACHE_HOME, then ~/.cache/scip-query', () => {
    expect(resolveScipQueryCachePath('thing.bin', { SCIP_QUERY_CACHE_DIR: '/tmp/custom' })).toBe(
      join('/tmp/custom', 'thing.bin'),
    );
    expect(resolveScipQueryCachePath('thing.bin', { XDG_CACHE_HOME: '/tmp/xdg' })).toBe(
      join('/tmp/xdg', 'scip-query', 'thing.bin'),
    );
    expect(resolveScipQueryCachePath('thing.bin', {})).toContain(join('.cache', 'scip-query', 'thing.bin'));
  });
});

describe('fetchVerifiedBinary', () => {
  it('downloads, verifies, and caches; a second call reuses the cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-verified-binary-'));
    const cachePath = join(root, 'cache', 'thing.bin');
    const bytes = Buffer.from('fixture payload');
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as Response;
    }) as typeof fetch;

    const downloaded = await fetchVerifiedBinary({
      cachePath,
      url: 'https://example.test/thing.bin',
      expectedSha256,
      fetchImpl,
    });
    expect(downloaded.status).toBe('downloaded');
    expect(readFileSync(cachePath)).toEqual(bytes);
    expect(fetchCount).toBe(1);

    const cached = await fetchVerifiedBinary({
      cachePath,
      url: 'https://example.test/thing.bin',
      expectedSha256,
      fetchImpl,
    });
    expect(cached.status).toBe('cached');
    expect(fetchCount).toBe(1); // cache hit: no second network call
  });

  it('throws on checksum mismatch and does not write the bad bytes into the cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-verified-binary-'));
    const cachePath = join(root, 'cache', 'thing.bin');
    const bytes = Buffer.from('unexpected payload');
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      }) as Response) as typeof fetch;

    await expect(
      fetchVerifiedBinary({
        cachePath,
        url: 'https://example.test/thing.bin',
        expectedSha256: 'a'.repeat(64),
        fetchImpl,
      }),
    ).rejects.toThrow(/checksum mismatch/);
  });

  it('throws on a non-OK response', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-verified-binary-'));
    const cachePath = join(root, 'cache', 'thing.bin');
    const fetchImpl = (async () => ({ ok: false, status: 404 }) as Response) as typeof fetch;

    await expect(
      fetchVerifiedBinary({ cachePath, url: 'https://example.test/thing.bin', expectedSha256: 'x', fetchImpl }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe('sha256', () => {
  it('matches node:crypto directly', () => {
    const bytes = Buffer.from('hello world');
    expect(sha256(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});
