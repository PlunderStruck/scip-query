import type * as executionModule from '../../src/runtime/command-kit/command-execution.js';
import type * as queryModule from '../../src/queries/index.js';
import type { budgetedDbCommand } from '../../src/runtime/command-kit/command-execution.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Parameters<typeof budgetedDbCommand>[1]>(),
  dead: vi.fn(),
  printJsonEnvelope: vi.fn(),
  renderDeadGroup: vi.fn(),
}));
vi.mock('../../src/queries/index.js', async (original) => ({
  ...(await original<typeof queryModule>()),
  dead: mocks.dead,
}));
vi.mock('../../src/runtime/command-kit/command-execution.js', async (original) => ({
  ...(await original<typeof executionModule>()),
  budgetedDbCommand: (name: string, handler: Parameters<typeof budgetedDbCommand>[1]) => {
    mocks.handlers.set(name, handler);
    return () => undefined;
  },
  printJsonEnvelope: mocks.printJsonEnvelope,
}));
vi.mock('../../src/runtime/query-commands/cleanup/renderers.js', () => ({ renderDeadGroup: mocks.renderDeadGroup }));
import '../../src/runtime/query-commands/cleanup/handlers.js';

const symbols = [
  ...Array.from({ length: 22 }, (_, index) => ({ kind: 'dead-code', symbol: `dead-${index}`, loc: 2 })),
  { kind: 'file-internal', symbol: 'internal', loc: 3 },
  { kind: 'implicit-usage', symbol: 'implicit', loc: 5 },
];
const counts = { total: 24, deadCode: 22, fileInternal: 1, implicitUsage: 1, loc: 52 };
let stdout: string[];
beforeEach(() => {
  vi.clearAllMocks();
  stdout = [];
  vi.spyOn(console, 'log').mockImplementation((value) => stdout.push(String(value)));
  mocks.dead.mockReturnValue({ symbols, counts });
});
afterEach(() => vi.restoreAllMocks());
function run(opts: Record<string, unknown>) {
  const handler = mocks.handlers.get('dead')!;
  return handler({
    db: {} as Parameters<typeof handler>[0]['db'],
    args: [],
    opts,
    budget: { scanLimit: 100, semantic: false, analysisBudget: undefined },
  });
}

describe('dead command display policy', () => {
  it.each([
    [{}, [22, 1, 1], 52],
    [{ onlyDead: true }, [22, 0, 0], 44],
    [{ onlyInternal: true }, [0, 1, 0], 3],
    [{ onlyDead: true, onlyInternal: true }, [0, 0, 0], 0],
  ] as const)('filters JSON groups without changing analysis totals: %j', async (opts, lengths, loc) => {
    await run({ ...opts, json: true });
    const result = mocks.printJsonEnvelope.mock.calls[0]![3];
    expect(Object.values(result.shown).map((group) => (group as unknown[]).length)).toEqual(lengths);
    expect(result.shownCounts).toEqual({
      total: lengths.reduce((sum: number, value) => sum + value, 0),
      deadCode: lengths[0],
      fileInternal: lengths[1],
      implicitUsage: lengths[2],
      loc,
    });
    expect(result.totals).toEqual(counts);
    expect(result.symbols).toBe(symbols);
    expect(stdout).toEqual([]);
    expect(mocks.renderDeadGroup).not.toHaveBeenCalled();
  });

  it('bounds human sections while keeping complete counts and ordered explanations', async () => {
    await run({});
    expect(mocks.renderDeadGroup.mock.calls.map((call) => call[1])).toEqual([
      'DEAD CODE',
      'FILE-INTERNAL ONLY',
      'IMPLICIT USAGE',
    ]);
    expect(mocks.renderDeadGroup.mock.calls[0]![0]).toHaveLength(20);
    expect(mocks.renderDeadGroup.mock.calls[0]![3]).toBe(40);
    expect(mocks.renderDeadGroup.mock.calls[0]![4]).toEqual({ count: 22, loc: 44 });
    expect(stdout).toContain('\n  Showing top 20 by LOC. Re-run with --full for the remaining 2.');
    expect(stdout.at(-1)).toBe(
      'Total: 24 symbols — 22 dead code (44 LOC) + 1 file-internal (3 LOC) + 1 implicit usage (5 LOC)',
    );
  });

  it('renders all requested rows with full and omits the continuation notice', async () => {
    await run({ full: true, onlyDead: true });
    expect(mocks.renderDeadGroup).toHaveBeenCalledTimes(1);
    expect(mocks.renderDeadGroup.mock.calls[0]![0]).toHaveLength(22);
    expect(mocks.renderDeadGroup.mock.calls[0]![3]).toBe(44);
    expect(stdout.some((line) => line.includes('Re-run'))).toBe(false);
    expect(stdout.at(-1)).toBe('Total: 22 symbols — 22 dead code (44 LOC)');
  });

  it('returns the empty human result when both exclusive filters are selected', async () => {
    await run({ onlyDead: true, onlyInternal: true });
    expect(mocks.renderDeadGroup).not.toHaveBeenCalled();
    expect(stdout.join('\n')).toContain('No matching dead-code symbols found.');
    expect(stdout.some((line) => line.startsWith('Total:'))).toBe(false);
  });
});
