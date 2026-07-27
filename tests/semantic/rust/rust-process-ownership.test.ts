import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOwnedProcessTree } from '../../../src/platform/process-tree.js';
import {
  registerRustAnalyzerProcessTree,
  terminateRegisteredRustAnalyzerProcessTrees,
} from '../../../src/semantic/rust/process-ownership.js';

describe('rust-analyzer process ownership records', () => {
  it.runIf(process.platform !== 'win32')(
    'lets a parent reap a registered analyzer after its Worker is gone',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'scip-query-rust-owner-'));
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
        detached: true,
        stdio: 'ignore',
      });
      try {
        expect(child.pid).toBeDefined();
        const tree = createOwnedProcessTree(child.pid!, true);
        expect(tree.rootIdentity).not.toBeNull();
        expect(registerRustAnalyzerProcessTree(directory, tree)).toContain(String(child.pid));

        const results = await terminateRegisteredRustAnalyzerProcessTrees(directory, {
          gracefulMs: 50,
          forceMs: 250,
        });

        expect(results).toEqual([expect.objectContaining({ reaped: true, reason: 'terminated' })]);
        expect(processExists(child.pid!)).toBe(false);
      } finally {
        if (child.pid && processExists(child.pid)) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // The fixture already exited.
          }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('reports malformed ownership records as unreaped rather than signaling from them', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'scip-query-rust-owner-invalid-'));
    try {
      writeFileSync(join(directory, 'rust-analyzer-owner-41.json'), '{"version":1,"rootIdentity":{"pid":41}}\n');
      await expect(
        terminateRegisteredRustAnalyzerProcessTrees(directory, { gracefulMs: 1, forceMs: 1 }),
      ).resolves.toEqual([
        expect.objectContaining({
          reaped: false,
          reason: 'identity-unavailable',
        }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
