/** Millisecond samples summarized without mutating their acquisition order. */
export function summarizeTimings(values: readonly number[]): {
  iterations: number;
  min: number;
  median: number;
  max: number;
} {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0 ? 0 : sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return {
    iterations: sorted.length,
    min: rounded(sorted[0] ?? 0),
    median: rounded(median),
    max: rounded(sorted.at(-1) ?? 0),
  };
}

export function rounded(value: number): number {
  return Number(value.toFixed(3));
}
