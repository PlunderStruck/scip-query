import type { ScipDatabase } from '../../storage/db.js';
import { mentionedReferenceSymbolRows, mentionReferenceCountRows } from '../../storage/scip-mentions.js';

type ReferenceCounts = Map<number, Map<string, number>>;

export type ReferenceEvidenceSource =
  | 'scip-mention'
  | 'source-fallback'
  | 'caller-map';

export function emptyReferenceCounts(): ReferenceCounts {
  return new Map();
}

export function loadMentionReferenceCounts(
  db: ScipDatabase,
  inactiveBarrelPaths: ReadonlySet<string>,
  symbolIds?: readonly number[],
): ReferenceCounts {
  const referencesBySymbol: ReferenceCounts = new Map();
  for (const row of mentionReferenceCountRows(db, symbolIds)) {
    if (db.isIgnored(row.relative_path)) continue;
    if (inactiveBarrelPaths.has(row.relative_path)) continue;
    recordReference(
      referencesBySymbol,
      row.symbol_id,
      row.relative_path,
      row.ref_count,
      'scip-mention',
    );
  }
  return referencesBySymbol;
}

export function loadMentionReferencedSymbolIds(
  db: ScipDatabase,
  symbolIds: readonly number[],
  inactiveBarrelPaths: ReadonlySet<string>,
): Set<number> {
  const result = new Set<number>();
  for (const row of mentionedReferenceSymbolRows(db, symbolIds)) {
    if (db.isIgnored(row.relative_path)) continue;
    if (inactiveBarrelPaths.has(row.relative_path)) continue;
    result.add(row.symbol_id);
  }
  return result;
}

export function hasAnyReference(
  referencesBySymbol: ReferenceCounts,
  symbolId: number,
): boolean {
  const refs = referencesBySymbol.get(symbolId);
  if (!refs) return false;
  for (const count of refs.values()) {
    if (count > 0) return true;
  }
  return false;
}

export function recordReference(
  referencesBySymbol: ReferenceCounts,
  symbolId: number,
  file: string,
  occurrences: number,
  _source: ReferenceEvidenceSource = 'source-fallback',
): void {
  if (occurrences <= 0) return;
  let refsForSymbol = referencesBySymbol.get(symbolId);
  if (!refsForSymbol) {
    refsForSymbol = new Map<string, number>();
    referencesBySymbol.set(symbolId, refsForSymbol);
  }
  refsForSymbol.set(file, (refsForSymbol.get(file) ?? 0) + occurrences);
}

export function recordReferenceAtLeast(
  referencesBySymbol: ReferenceCounts,
  symbolId: number,
  file: string,
  minimumOccurrences: number,
  _source: ReferenceEvidenceSource,
): void {
  if (minimumOccurrences <= 0) return;
  let refsForSymbol = referencesBySymbol.get(symbolId);
  if (!refsForSymbol) {
    refsForSymbol = new Map<string, number>();
    referencesBySymbol.set(symbolId, refsForSymbol);
  }
  refsForSymbol.set(file, Math.max(minimumOccurrences, refsForSymbol.get(file) ?? 0));
}
