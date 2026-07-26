import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DIFF_GATE_TIMEOUT_MS,
  DEFAULT_FULL_DIFF_GATE_TIMEOUT_MS,
  DIFF_GATE_REQUEST_ENV,
  DiffGateBusyError,
  diffGateTimeoutMs,
  parseDiffGateExecutionRequest,
  runIsolatedDiffGate,
  withDiffGateLease,
  type DiffGateExecutionRequest,
} from '../../src/runtime/diff-gate-execution.js';
import { IsolatedProcessTimeoutError } from '../../src/runtime/isolated-analysis-runner.js';

const roots: string[] = [];
const request: DiffGateExecutionRequest = {
  minTogether: 6,
  includeBaseline: false,
  includeOutcomeLedger: false,
  full: false,
  skip: [],
};

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('diff-gate execution containment', () => {
  it('validates the private worker request before executing policy', () => {
    expect(parseDiffGateExecutionRequest(JSON.stringify(request))).toEqual(request);
    expect(() => parseDiffGateExecutionRequest(undefined)).toThrow(DIFF_GATE_REQUEST_ENV);
    expect(() => parseDiffGateExecutionRequest(JSON.stringify({ ...request, skip: ['not-a-detector'] }))).toThrow(
      /invalid diff-gate options/,
    );
  });

  it('keeps a finite default deadline and caps configured overrides', () => {
    expect(diffGateTimeoutMs(false, {})).toBe(DEFAULT_DIFF_GATE_TIMEOUT_MS);
    expect(diffGateTimeoutMs(true, {})).toBe(DEFAULT_FULL_DIFF_GATE_TIMEOUT_MS);
    expect(diffGateTimeoutMs(false, { SCIP_QUERY_DIFF_GATE_TIMEOUT_MS: '25' })).toBe(25);
    expect(diffGateTimeoutMs(false, { SCIP_QUERY_DIFF_GATE_TIMEOUT_MS: '99999999' })).toBe(600_000);
    expect(diffGateTimeoutMs(false, { SCIP_QUERY_DIFF_GATE_TIMEOUT_MS: 'never' })).toBe(DEFAULT_DIFF_GATE_TIMEOUT_MS);
  });

  it('rejects a duplicate while a live process owns the project lease', () => {
    const root = tempRoot('scip-query-diff-gate-lease-');
    const lockPath = join(root, 'runtime', 'diff-gate.lock');

    withDiffGateLease(lockPath, root, () => {
      expect(() => withDiffGateLease(lockPath, root, () => 'duplicate')).toThrow(DiffGateBusyError);
      try {
        withDiffGateLease(lockPath, root, () => 'duplicate');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'SCIP_QUERY_DIFF_GATE_BUSY',
          observation: { owner: { pid: process.pid } },
        });
      }
    });

    expect(withDiffGateLease(lockPath, root, () => 'next')).toBe('next');
  });

  it('releases the lease when protected execution throws', () => {
    const root = tempRoot('scip-query-diff-gate-release-');
    const lockPath = join(root, 'runtime', 'diff-gate.lock');

    expect(() =>
      withDiffGateLease(lockPath, root, () => {
        throw new Error('analysis failed');
      }),
    ).toThrow('analysis failed');
    expect(withDiffGateLease(lockPath, root, () => 'recovered')).toBe('recovered');
  });

  it('kills a non-yielding isolated gate at its deadline and releases the lease', () => {
    const root = tempRoot('scip-query-diff-gate-timeout-');
    const script = join(root, 'never-finishes.cjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');

    expect(() =>
      runIsolatedDiffGate(request, {
        projectRoot: root,
        cacheDir: root,
        cliPath: script,
        timeoutMs: 50,
      }),
    ).toThrow(IsolatedProcessTimeoutError);

    expect(withDiffGateLease(join(root, 'runtime', 'diff-gate.lock'), root, () => 'lease-reclaimed')).toBe(
      'lease-reclaimed',
    );
  });
});
