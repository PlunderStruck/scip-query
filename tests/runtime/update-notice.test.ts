import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isNewerVersion, maybePrintUpdateNotice, renderUpdateNotice } from '../../src/runtime/update-notice.js';

function tempCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'scip-query-update-notice-'));
}

describe('update notice', () => {
  it('detects newer semantic versions', () => {
    expect(isNewerVersion('0.7.1', '0.7.0')).toBe(true);
    expect(isNewerVersion('0.8.0', '0.7.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(isNewerVersion('0.7.0', '0.7.0')).toBe(false);
    expect(isNewerVersion('0.6.9', '0.7.0')).toBe(false);
  });

  it('prints an agent-directed notice when npm reports a newer release', async () => {
    const notices: string[] = [];

    await maybePrintUpdateNotice({
      cacheDir: tempCacheDir(),
      currentVersion: '0.7.0',
      fetchLatestVersion: async () => '0.7.1',
      now: 100,
      writeNotice: (message) => notices.push(message),
    });

    expect(notices).toEqual([renderUpdateNotice('0.7.0', '0.7.1')]);
    expect(notices[0]).toContain('Agent: tell your human to update');
  });

  it('does not print when the current version is already latest', async () => {
    const writeNotice = vi.fn();

    await maybePrintUpdateNotice({
      cacheDir: tempCacheDir(),
      currentVersion: '0.7.0',
      fetchLatestVersion: async () => '0.7.0',
      now: 100,
      writeNotice,
    });

    expect(writeNotice).not.toHaveBeenCalled();
  });

  it('uses the cached latest version during the check interval', async () => {
    const cacheDir = tempCacheDir();
    const fetchLatestVersion = vi.fn(async () => '0.7.1');

    await maybePrintUpdateNotice({
      cacheDir,
      currentVersion: '0.7.0',
      fetchLatestVersion,
      now: 100,
      writeNotice: () => undefined,
    });
    await maybePrintUpdateNotice({
      cacheDir,
      currentVersion: '0.7.0',
      fetchLatestVersion,
      now: 200,
      writeNotice: () => undefined,
    });

    expect(fetchLatestVersion).toHaveBeenCalledTimes(1);
  });

  it('honors update-check opt out', async () => {
    const cacheDir = tempCacheDir();
    const fetchLatestVersion = vi.fn(async () => '0.7.1');
    const writeNotice = vi.fn();

    await maybePrintUpdateNotice({
      cacheDir,
      currentVersion: '0.7.0',
      env: { SCIP_QUERY_UPDATE_CHECK: '0' },
      fetchLatestVersion,
      now: 100,
      writeNotice,
    });

    expect(fetchLatestVersion).not.toHaveBeenCalled();
    expect(writeNotice).not.toHaveBeenCalled();
    expect(existsSync(join(cacheDir, 'update-check.json'))).toBe(false);
  });

  it('caches failed checks without failing the command', async () => {
    const cacheDir = tempCacheDir();

    await maybePrintUpdateNotice({
      cacheDir,
      currentVersion: '0.7.0',
      fetchLatestVersion: async () => {
        throw new Error('offline');
      },
      now: 100,
      writeNotice: () => undefined,
    });

    const cache = JSON.parse(readFileSync(join(cacheDir, 'update-check.json'), 'utf8')) as {
      checkedAt: number;
      latestVersion: string | null;
    };
    expect(cache).toEqual({ checkedAt: 100, latestVersion: null });
  });
});
