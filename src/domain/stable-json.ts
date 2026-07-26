/**
 * Encodes a JSON-compatible value with recursively sorted object keys.
 *
 * This is an identity primitive: callers hash the returned bytes, so equal
 * logical values must encode identically even when object insertion order
 * differs. Array order remains significant.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
