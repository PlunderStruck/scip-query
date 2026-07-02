import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setupCiWorkflow } from '../../src/runtime/setup-ci.js';
import { cliVersion } from '../../src/runtime/cli-support.js';

describe('setupCiWorkflow', () => {
  it('writes the scip-query GitHub Actions workflow and refuses accidental overwrite', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-setup-ci-'));
    try {
      const first = setupCiWorkflow(root);
      expect(first.written).toBe(true);
      expect(existsSync(first.path)).toBe(true);
      expect(readFileSync(first.path, 'utf-8')).toContain('actions/cache@v4');
      expect(readFileSync(first.path, 'utf-8')).toContain(`npx scip-query@${cliVersion} diff-gate`);

      const skipped = setupCiWorkflow(root);
      expect(skipped.skipped).toBe(true);
      expect(skipped.reason).toContain('--force');

      writeFileSync(first.path, 'custom\n');
      const forced = setupCiWorkflow(root, { force: true });
      expect(forced.written).toBe(true);
      expect(readFileSync(first.path, 'utf-8')).toContain(`npx scip-query@${cliVersion} reindex`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('supports dry-run without writing the workflow', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-setup-ci-dry-run-'));
    try {
      const result = setupCiWorkflow(root, { dryRun: true });

      expect(result.written).toBe(false);
      expect(result.content).toContain('actions/checkout@v4');
      expect(result.content).toContain('TODO: install this repository');
      expect(result.content).not.toContain('npm ci');
      expect(existsSync(result.path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
