import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DIFF_GATE_TIMEOUT_MS,
  DEFAULT_FULL_DIFF_GATE_TIMEOUT_MS,
  DIFF_GATE_REQUEST_ENV,
  diffGateDeadlineContract,
  DiffGateBusyError,
  DiffGateDetectorTimeoutError,
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

  it('derives a host deadline that strictly contains preflight, child execution, reaping, and serialization', () => {
    const contract = diffGateDeadlineContract(DEFAULT_DIFF_GATE_TIMEOUT_MS, 5_000);

    expect(contract).toMatchObject({
      childTimeoutMs: DEFAULT_DIFF_GATE_TIMEOUT_MS,
      preflightMs: 5_000,
    });
    expect(contract.hostTimeoutSeconds * 1_000).toBeGreaterThan(
      contract.preflightMs + contract.childTimeoutMs + contract.processReapGraceMs + contract.serializationGraceMs,
    );
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

  it('kills a non-yielding isolated detector, reports its identity, and releases the lease', () => {
    const root = tempRoot('scip-query-diff-gate-timeout-');
    const script = join(root, 'never-finishes.cjs');
    writeFileSync(
      script,
      [
        "const fs = require('node:fs');",
        'fs.writeFileSync(process.env.SCIP_QUERY_DIFF_GATE_PROGRESS_PATH, JSON.stringify({',
        '  schemaVersion: 1,',
        '  token: process.env.SCIP_QUERY_DIFF_GATE_PROGRESS_TOKEN,',
        "  stage: 'current-gate',",
        "  activeCheck: 'architecture',",
        "  lastCompletedCheck: 'coverage-contract',",
        '  updatedAt: new Date().toISOString(),',
        '}));',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );

    let observed: unknown;
    try {
      runIsolatedDiffGate(request, {
        projectRoot: root,
        cacheDir: root,
        cliPath: script,
        // Process startup can exceed 100ms under the fully parallel suite.
        // Keep enough time for the child to publish its detector identity,
        // while still proving that a non-yielding process is forcibly reaped.
        timeoutMs: 1_000,
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(DiffGateDetectorTimeoutError);
    expect(observed).toBeInstanceOf(IsolatedProcessTimeoutError);
    expect(observed).toMatchObject({
      progress: {
        stage: 'current-gate',
        activeCheck: 'architecture',
        lastCompletedCheck: 'coverage-contract',
      },
      reaped: true,
    });
    expect((observed as Error).message).toContain('Active detector: architecture');
    expect((observed as Error).message).toContain('Last completed detector: coverage-contract');

    expect(withDiffGateLease(join(root, 'runtime', 'diff-gate.lock'), root, () => 'lease-reclaimed')).toBe(
      'lease-reclaimed',
    );
    expect(readdirSync(join(root, 'runtime')).filter((name) => name.startsWith('diff-gate-progress-'))).toEqual([]);
  });
});
