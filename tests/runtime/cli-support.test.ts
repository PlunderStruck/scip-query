import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandAnalysisBudget } from '../../src/runtime/cli-support.js';
import type { ScipDatabase } from '../../src/storage/db.js';

function fakeLargeDb(): ScipDatabase {
  return {
    config: { dbPath: '/tmp/missing-index.db' },
    get: (sql: string) => {
      if (sql.includes('documents')) return { c: 10_000 };
      if (sql.includes('global_symbols')) return { c: 100_000 };
      return { c: 0 };
    },
  } as unknown as ScipDatabase;
}

describe('commandAnalysisBudget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('suppresses large-index warnings for JSON commands without changing the budget', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(commandAnalysisBudget(fakeLargeDb(), 'cleanup-plan', false, { quiet: true })).toEqual({
      scanLimit: 2500,
      semantic: false,
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps large-index warnings for human output', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(commandAnalysisBudget(fakeLargeDb(), 'cleanup-plan', false)).toEqual({ scanLimit: 2500, semantic: false });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Large index detected'));
  });
});
