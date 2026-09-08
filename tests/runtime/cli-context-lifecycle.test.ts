import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDbAsync } from '../../src/runtime/cli-context.js';
import {
  cachedGitProjectFileInventory,
  enterProjectFileListingCache,
} from '../../src/platform/project-file-inventory-context.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('async command cache lifetime', () => {
  it('restores the enclosing file inventory when opening the database fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-context-lifecycle-'));
    vi.stubEnv('SCIP_QUERY_PROJECT_ROOT', root);
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('command exited');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const release = enterProjectFileListingCache();
    try {
      const outer = cachedGitProjectFileInventory(root, 100, () => 'H outer.ts\0');
      await expect(withDbAsync(async () => undefined)).rejects.toThrow('command exited');
      const observed = cachedGitProjectFileInventory(root, 100, () => 'H wrong-scope.ts\0');
      expect(observed).toBe(outer);
    } finally {
      release();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
