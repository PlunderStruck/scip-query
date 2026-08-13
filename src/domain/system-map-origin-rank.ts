/**
 * Rank system-map origin tags so printers and query assembly sort the same way.
 * Lower ranks come first.
 */
export function systemMapOriginRank(origins: readonly string[]): number {
  if (origins.includes('symbol-anchor')) return 0;
  if (origins.includes('literal-owner')) return 1;
  if (origins.some((origin) => origin.startsWith('boundary-import:'))) return 2;
  if (origins.includes('reference-owner')) return 3;
  return 4;
}

export interface SystemMapDrilldownSortKey {
  origins: readonly string[];
  depth: number;
  startLine: number;
  shortName: string;
}

export function compareSystemMapDrilldownSymbols(
  left: SystemMapDrilldownSortKey,
  right: SystemMapDrilldownSortKey,
): number {
  return (
    systemMapOriginRank(left.origins) - systemMapOriginRank(right.origins) ||
    left.depth - right.depth ||
    left.startLine - right.startLine ||
    left.shortName.localeCompare(right.shortName)
  );
}
