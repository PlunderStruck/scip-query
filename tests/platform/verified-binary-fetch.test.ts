import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  VerifiedBinaryFetchError,
  fetchVerifiedBinary,
  resolveScipQueryCachePath,
  sha256,
} from '../../src/platform/verified-binary-fetch.js';

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
  it('streams, verifies, and caches; a second call reuses the cache without a fetch', async () => {
    const cachePath = createCachePath();
    const bytes = Buffer.from('fixture payload');
    const expectedSha256 = digest(bytes);
    const fetchImpl = vi.fn(async () => byteResponse([bytes], { contentLength: bytes.length }));

    await expect(
      fetchVerifiedBinary({
        cachePath,
        url: 'https://example.test/thing.bin',
        expectedSha256,
        fetchImpl,
      }),
    ).resolves.toEqual({ status: 'downloaded', path: cachePath, sha256: expectedSha256 });
    expect(readFileSync(cachePath)).toEqual(bytes);

    await expect(
      fetchVerifiedBinary({
        cachePath,
        url: 'https://example.test/thing.bin',
        expectedSha256,
        fetchImpl,
      }),
    ).resolves.toEqual({ status: 'cached', path: cachePath, sha256: expectedSha256 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchArtifacts(cachePath)).toEqual([]);
  });

  it('times out a fetch implementation that ignores AbortSignal and never settles', async () => {
    const cachePath = createCachePath();
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch;

    const error = await fetchVerifiedBinary({
      cachePath,
      url: 'https://example.test/never.bin',
      expectedSha256: 'a'.repeat(64),
      fetchImpl,
      timeoutMs: 10,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(VerifiedBinaryFetchError);
    expect(error).toMatchObject({ kind: 'timeout', message: expect.stringMatching(/timed out after 10ms/) });
    expect(existsSync(cachePath)).toBe(false);
    expect(fetchArtifacts(cachePath)).toEqual([]);
  });

  it('honors caller abort even when the fetch implementation ignores AbortSignal', async () => {
    const cachePath = createCachePath();
    const controller = new AbortController();
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch;
    const pending = fetchVerifiedBinary({
      cachePath,
      url: 'https://example.test/abort.bin',
      expectedSha256: 'a'.repeat(64),
      fetchImpl,
      timeoutMs: 1_000,
      signal: controller.signal,
    });

    controller.abort(new Error('caller stopped'));
    const error = await pending.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(VerifiedBinaryFetchError);
    expect(error).toMatchObject({ kind: 'aborted', message: expect.stringMatching(/was aborted/) });
    expect((error as Error).cause).toMatchObject({ message: 'caller stopped' });
    expect(fetchArtifacts(cachePath)).toEqual([]);
  });

  it('allows a missing Content-Length while enforcing the observed stream ceiling', async () => {
    const cachePath = createCachePath();
    const bytes = Buffer.from('chunked payload');

    await expect(
      fetchVerifiedBinary({
        cachePath,
        url: 'https://example.test/chunked.bin',
        expectedSha256: digest(bytes),
        fetchImpl: (async () => byteResponse([bytes.subarray(0, 3), bytes.subarray(3)])) as typeof fetch,
        maxBytes: bytes.length,
      }),
    ).resolves.toMatchObject({ status: 'downloaded' });
    expect(readFileSync(cachePath)).toEqual(bytes);
  });

  it.each([
    {
      label: 'malformed',
      response: () => byteResponse([Buffer.from('abc')], { rawContentLength: 'false' }),
      maxBytes: 10,
      message: /invalid Content-Length/,
    },
    {
      label: 'oversized',
      response: () => byteResponse([Buffer.from('abc')], { contentLength: 11 }),
      maxBytes: 10,
      message: /declares 11 bytes, above the 10 byte limit/,
    },
    {
      label: 'short',
      response: () => byteResponse([Buffer.from('abc')], { contentLength: 4 }),
      maxBytes: 10,
      message: /length mismatch: declared 4 bytes, received 3/,
    },
  ])('rejects a $label advertised length and leaves no owned artifacts', async ({ response, maxBytes, message }) => {
    const cachePath = createCachePath();
    const error = await fetchVerifiedBinary({
      cachePath,
      url: 'https://example.test/length.bin',
      expectedSha256: digest(Buffer.from('abc')),
      fetchImpl: (async () => response()) as typeof fetch,
      maxBytes,
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ kind: 'length', message: expect.stringMatching(message) });
    expect(existsSync(cachePath)).toBe(false);
    expect(fetchArtifacts(cachePath)).toEqual([]);
  });

  it('aborts a chunked stream as soon as observed bytes exceed the ceiling', async () => {
    const cachePath = createCachePath();
    const error = await fetchVerifiedBinary({
      cachePath,
      url: 'https://example.test/overflow.bin',
      expectedSha256: 'a'.repeat(64),
      fetchImpl: (async () => byteResponse([Buffer.alloc(6), Buffer.alloc(6)])) as typeof fetch,
      maxBytes: 10,
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ kind: 'length', message: expect.stringMatching(/exceeded its 10 byte limit/) });
    expect(fetchArtifacts(cachePath)).toEqual([]);
  });

  it('serializes two callers for one cache path and rechecks the cache under the lock', async () => {
    const cachePath = createCachePath();
    const bytes = Buffer.from('shared payload');
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await fetchGate;
      return byteResponse([bytes], { contentLength: bytes.length });
    });

    const first = fetchVerifiedBinary({
      cachePath,
      url: 'https://example.test/shared.bin',
      expectedSha256: digest(bytes),
      fetchImpl,
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const second = fetchVerifiedBinary({
      cachePath,
      url: 'https://example.test/shared.bin',
      expectedSha256: digest(bytes),
      fetchImpl,
      timeoutMs: 1_000,
    });
    releaseFetch();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'downloaded' }),
      expect.objectContaining({ status: 'cached' }),
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchArtifacts(cachePath)).toEqual([]);
  });

  it('reports lock timeout without starting a competing download', async () => {
    const cachePath = createCachePath();
    const bytes = Buffer.from('owned payload');
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await fetchGate;
      return byteResponse([bytes], { contentLength: bytes.length });
    });
    const owner = fetchVerifiedBinary({
      cachePath,
      url: 'https://example.test/owned.bin',
      expectedSha256: digest(bytes),
      fetchImpl,
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    const contenderError = await fetchVerifiedBinary({
      cachePath,
      url: 'https://example.test/owned.bin',
      expectedSha256: digest(bytes),
      fetchImpl,
      timeoutMs: 1_000,
      lockWaitMs: 5,
    }).catch((reason: unknown) => reason);

    expect(contenderError).toMatchObject({
      kind: 'lock-timeout',
      message: expect.stringMatching(/timed out waiting 5ms/),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    releaseFetch();
    await expect(owner).resolves.toMatchObject({ status: 'downloaded' });
    expect(fetchArtifacts(cachePath)).toEqual([]);
  });

  it('rejects checksum mismatch without publishing or retaining staging bytes', async () => {
    const cachePath = createCachePath();
    const bytes = Buffer.from('unexpected payload');
    const error = await fetchVerifiedBinary({
      cachePath,
      url: 'https://example.test/thing.bin',
      expectedSha256: 'a'.repeat(64),
      fetchImpl: (async () => byteResponse([bytes], { contentLength: bytes.length })) as typeof fetch,
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ kind: 'checksum', message: expect.stringMatching(/checksum mismatch/) });
    expect(existsSync(cachePath)).toBe(false);
    expect(fetchArtifacts(cachePath)).toEqual([]);
  });

  it.each([
    {
      label: 'write',
      overrides: {
        writeImpl: (() => {
          throw new Error('write failed');
        }) as never,
      },
      message: /failed to stage verified binary/,
    },
    {
      label: 'rename',
      overrides: {
        renameImpl: (() => {
          throw new Error('rename failed');
        }) as never,
      },
      message: /failed to install verified binary/,
    },
  ])('cleans its exclusive staging file after a $label failure', async ({ overrides, message }) => {
    const cachePath = createCachePath();
    const bytes = Buffer.from('verified payload');
    const error = await fetchVerifiedBinary({
      cachePath,
      url: 'https://example.test/install.bin',
      expectedSha256: digest(bytes),
      fetchImpl: (async () => byteResponse([bytes], { contentLength: bytes.length })) as typeof fetch,
      ...overrides,
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ kind: 'install', message: expect.stringMatching(message) });
    expect(existsSync(cachePath)).toBe(false);
    expect(fetchArtifacts(cachePath)).toEqual([]);
  });

  it('throws on a non-OK response and releases cache ownership', async () => {
    const cachePath = createCachePath();
    const error = await fetchVerifiedBinary({
      cachePath,
      url: 'https://example.test/missing.bin',
      expectedSha256: 'a'.repeat(64),
      fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch,
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ kind: 'http', message: expect.stringMatching(/HTTP 404/) });
    expect(fetchArtifacts(cachePath)).toEqual([]);
  });
});

describe('sha256', () => {
  it('matches node:crypto directly', () => {
    const bytes = Buffer.from('hello world');
    expect(sha256(bytes)).toBe(digest(bytes));
  });
});

function createCachePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-verified-binary-'));
  return join(root, 'cache', 'thing.bin');
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function byteResponse(
  chunks: readonly Buffer[],
  opts: { contentLength?: number; rawContentLength?: string } = {},
): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
  const headers = new Headers();
  if (opts.contentLength !== undefined) headers.set('content-length', String(opts.contentLength));
  if (opts.rawContentLength !== undefined) headers.set('content-length', opts.rawContentLength);
  return new Response(body, { status: 200, headers });
}

function fetchArtifacts(cachePath: string): string[] {
  const dir = dirname(cachePath);
  if (!existsSync(dir)) return [];
  const prefix = basename(cachePath);
  return readdirSync(dir)
    .filter((entry) => entry === `${prefix}.fetch.lock` || entry.startsWith(`${prefix}.tmp-`))
    .sort();
}
