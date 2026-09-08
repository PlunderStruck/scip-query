import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as wake from '../../src/platform/path-change-wake.js';
import { runQueryServiceServer } from '../../src/runtime/query-service-server.js';

const fixture = vi.hoisted(() => ({ close: vi.fn(), open: vi.fn() }));
vi.mock('../../src/runtime/cli-context.js', () => ({ openProjectDb: fixture.open }));

describe('query service resource ownership', () => {
  let root: string;
  let originalSignals: Record<'SIGINT' | 'SIGTERM', ReturnType<typeof process.listeners>>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scip-query-service-lifecycle-'));
    originalSignals = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
    fixture.close.mockReset();
    fixture.open.mockReset().mockReturnValue({ generation: { identity: 'test-generation' }, close: fixture.close });
    vi.stubEnv('SCIP_QUERY_QUERY_SERVICE_IDLE_MS', '1');
  });

  afterEach(() => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!originalSignals[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function expectReleased(): void {
    expect(existsSync(join(root, 'server.lock'))).toBe(false);
    expect(existsSync(join(root, 'server.json'))).toBe(false);
    expect(process.listeners('SIGINT')).toEqual(originalSignals.SIGINT);
    expect(process.listeners('SIGTERM')).toEqual(originalSignals.SIGTERM);
  }

  it('removes signal listeners and releases ownership after normal idle shutdown', async () => {
    await runQueryServiceServer(root, root);
    expect(fixture.close).toHaveBeenCalledOnce();
    expectReleased();
  });

  it('still removes state and releases the lock if database close fails', async () => {
    fixture.close.mockImplementation(() => {
      throw new Error('database close failed');
    });
    await expect(runQueryServiceServer(root, root)).rejects.toThrow('database close failed');
    expectReleased();
  });

  it('releases an opened database and lock if later resource acquisition fails', async () => {
    vi.spyOn(wake, 'createPathChangeWake').mockImplementationOnce(() => {
      throw new Error('wake creation failed');
    });
    await expect(runQueryServiceServer(root, root)).rejects.toThrow('wake creation failed');
    expect(fixture.close).toHaveBeenCalledOnce();
    expectReleased();
  });

  it('releases the lock if opening the database fails', async () => {
    fixture.open.mockImplementationOnce(() => {
      throw new Error('database open failed');
    });
    await expect(runQueryServiceServer(root, root)).rejects.toThrow('database open failed');
    expectReleased();
  });
});
