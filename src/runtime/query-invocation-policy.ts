/** Defaults for CLI invocations; library query defaults have separate contracts. */
export const SEARCH_CLI_DEFAULTS = { context: 2, limit: 6 } as const;
export const CODE_CLI_DEFAULTS = { context: 0, members: 'exported' } as const;

/** Exact integer grammar shared by canonical parsing and its fast-path subset. */
export function parseCliInteger(value: string, minimum = Number.MIN_SAFE_INTEGER): number | null {
  if (!/^[+-]?\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}
