/**
 * Encodes a JSON-compatible value with recursively sorted object keys.
 *
 * This is an identity primitive: callers hash the returned bytes, so equal
 * logical values must encode identically even when object insertion order
 * differs. Array order remains significant.
 */
export function stableJson(value: unknown): string {
  return stableJsonWithComparator(value, compareLocaleKeys);
}

/** Encodes process-local identities without paying for locale collation. */
export function codeUnitStableJson(value: unknown): string {
  return stableJsonWithComparator(value, compareCodeUnitKeys);
}

function stableJsonWithComparator(value: unknown, compareKeys: (left: string, right: string) => number): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJsonWithComparator(entry, compareKeys)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonWithComparator(entry, compareKeys)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function compareLocaleKeys(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareCodeUnitKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
