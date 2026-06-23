export interface FileLineRange {
  file: string;
}

export function rangesByFile<Range extends FileLineRange>(
  ranges: readonly Range[],
): ReadonlyMap<string, readonly Range[]> {
  const map = new Map<string, Range[]>();
  for (const range of ranges) {
    let bucket = map.get(range.file);
    if (!bucket) {
      bucket = [];
      map.set(range.file, bucket);
    }
    bucket.push(range);
  }
  return map;
}
