import type * as verificationModule from '../../src/runtime/cleanup-verify.js';
import type * as contextModule from '../../src/runtime/cli-context.js';
import type * as executionModule from '../../src/runtime/command-kit/command-execution.js';
import type * as queryModule from '../../src/queries/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CleanupPlanResult } from '../../src/queries/cleanup/cleanup-plan.js';
import type { CleanupVerification } from '../../src/runtime/cleanup-verify.js';
import type { budgetedDbCommand } from '../../src/runtime/command-kit/command-execution.js';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Parameters<typeof budgetedDbCommand>[1]>(),
  cleanupPlan: vi.fn(),
  verifyCleanupPlan: vi.fn(),
  createCleanupPatch: vi.fn(),
  cleanupVerificationFailures: vi.fn(),
  printJsonEnvelope: vi.fn(),
}));

vi.mock('../../src/queries/index.js', async (original) => ({
  ...(await original<typeof queryModule>()),
  cleanupPlan: mocks.cleanupPlan,
}));
vi.mock('../../src/runtime/command-kit/command-execution.js', async (original) => ({
  ...(await original<typeof executionModule>()),
  budgetedDbCommand: (name: string, handler: Parameters<typeof budgetedDbCommand>[1]) => {
    mocks.handlers.set(name, handler);
    return () => undefined;
  },
  printJsonEnvelope: mocks.printJsonEnvelope,
}));
vi.mock('../../src/runtime/cli-context.js', async (original) => ({
  ...(await original<typeof contextModule>()),
  resolveProjectRoot: () => '/fixture',
}));
vi.mock('../../src/runtime/cleanup-verify.js', async (original) => ({
  ...(await original<typeof verificationModule>()),
  verifyCleanupPlan: mocks.verifyCleanupPlan,
  createCleanupPatch: mocks.createCleanupPatch,
  cleanupVerificationFailures: mocks.cleanupVerificationFailures,
}));
import '../../src/runtime/query-commands/cleanup/handlers.js';

const initialExitCode = process.exitCode;
let stdout: string[];
let stderr: string[];
let plan: CleanupPlanResult;
let verification: CleanupVerification;

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((value) => stdout.push(String(value)));
  vi.spyOn(console, 'error').mockImplementation((value) => stderr.push(String(value)));
  plan = {
    batches: [{ depth: 0, loc: 2, entries: [], filesEmptied: ['src/dead.ts'] }],
    blocked: [],
    totalSymbols: 1,
    totalLoc: 2,
  };
  verification = {
    checkers: ['tsc'],
    uncoveredFiles: [],
    baselineErrors: 0,
    workingTree: { state: 'known', files: [] },
    dirtyOverlap: [],
    dirtyWorkingTree: [],
    batches: [{ depth: 0, status: 'verified' }],
  };
  mocks.cleanupPlan.mockImplementation(() => plan);
  mocks.verifyCleanupPlan.mockImplementation(() => verification);
  mocks.cleanupVerificationFailures.mockReturnValue([]);
  mocks.createCleanupPatch.mockReturnValue('diff --git a/src/dead.ts b/src/dead.ts\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = initialExitCode;
});

function run(opts: Record<string, unknown>) {
  const handler = mocks.handlers.get('cleanup-plan')!;
  return handler({
    db: {} as Parameters<typeof handler>[0]['db'],
    args: [],
    opts,
    budget: { scanLimit: 100, semantic: false, analysisBudget: undefined },
  });
}

describe('cleanup-plan output policy', () => {
  it('requires explicit verification before the empty-plan or JSON branches', async () => {
    plan.batches = [];
    await run({ patch: true, json: true });
    expect(stderr).toEqual(['error: cleanup-plan --patch requires --verify.']);
    expect(process.exitCode).toBe(1);
    expect(mocks.verifyCleanupPlan).not.toHaveBeenCalled();
    expect(mocks.printJsonEnvelope).not.toHaveBeenCalled();
  });

  it('keeps the empty JSON result shape and skips verification', async () => {
    plan.batches = [];
    await run({ verify: true, json: true });
    expect(mocks.printJsonEnvelope.mock.calls[0]?.[3]).toBe(plan);
    expect(mocks.verifyCleanupPlan).not.toHaveBeenCalled();
  });

  it('gives JSON precedence over patch rendering after verification', async () => {
    await run({ verify: true, patch: true, json: true });
    expect(mocks.verifyCleanupPlan).toHaveBeenCalledWith('/fixture', plan);
    expect(mocks.printJsonEnvelope.mock.calls[0]?.[3]).toEqual({ result: plan, verification });
    expect(mocks.createCleanupPatch).not.toHaveBeenCalled();
    expect(mocks.cleanupVerificationFailures).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
  });

  it('refuses patch generation when any verification requirement fails', async () => {
    mocks.cleanupVerificationFailures.mockReturnValue(['dirty plan file', 'uncovered file']);
    await run({ verify: true, patch: true });
    expect(stderr).toEqual(['error: dirty plan file', 'error: uncovered file']);
    expect(process.exitCode).toBe(1);
    expect(mocks.createCleanupPatch).not.toHaveBeenCalled();
  });

  it('rejects empty patches and emits successful patches without a human report', async () => {
    mocks.createCleanupPatch.mockReturnValueOnce(' \n');
    await run({ verify: true, patch: true });
    expect(stderr).toEqual(['error: verified cleanup plan produced an empty patch.']);
    expect(process.exitCode).toBe(1);
    stderr.length = 0;
    await run({ verify: true, patch: true });
    expect(stderr).toEqual(['cleanup-plan --patch: 1 verified batch(es), 2 LOC.']);
    expect(stdout).toEqual(['diff --git a/src/dead.ts b/src/dead.ts\n']);
  });

  it.each(['no-checker', 'unavailable'] as const)('stops verification details when %s', async (kind) => {
    if (kind === 'no-checker') verification.checkers = [];
    else verification.unavailableReason = 'snapshot failed';
    await run({ verify: true });
    const output = stdout.join('\n');
    expect(output).toContain(kind === 'no-checker' ? 'No checker detected' : 'UNAVAILABLE: snapshot failed.');
    expect(output).not.toContain('Batch 0: VERIFIED');
  });

  it('reports verification coverage, dirty state, and batch outcomes in their original order', async () => {
    verification = {
      checkers: ['ruff'],
      uncoveredFiles: ['src/uncovered.ts'],
      baselineErrors: 2,
      workingTree: { state: 'unavailable', reason: 'status failed' },
      dirtyOverlap: ['src/dead.ts'],
      dirtyWorkingTree: ['a', 'b', 'c', 'd', 'e', 'f'],
      batches: [
        { depth: 0, status: 'verified' },
        { depth: 1, status: 'failed', reason: 'new error', errors: ['missing export'] },
      ],
    };
    await run({ verify: true });
    const output = stdout.join('\n');
    const expected = [
      'all indexed definitions selected: src/dead.ts',
      'Checker: ruff',
      'NOT verified): src/uncovered.ts',
      '2 pre-existing error(s)',
      'working-tree inspection unavailable: status failed',
      'plan files dirty in working tree (verification runs at HEAD): src/dead.ts',
      '6 working-tree change(s) were not compiled: a, b, c, d, e, ... 1 more',
      'Batch 0: VERIFIED (ruff) -- lint-level or syntax-level check, not a type proof',
      'Batch 1: FAILED (new error)',
      'missing export',
    ];
    let previous = -1;
    for (const fragment of expected) {
      const index = output.indexOf(fragment);
      expect(index, fragment).toBeGreaterThan(previous);
      previous = index;
    }
  });
});
