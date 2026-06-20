import type { ScipDatabase } from '../../storage/db.js';
import { mentionedReferenceSymbolRows, mentionReferenceCountRows } from '../../storage/scip-mentions.js';

export type ReferenceEvidenceSource = 'scip-mention' | 'source-fallback' | 'caller-map';

export interface ReferenceCountEvidence {
  occurrences: number;
  sources: Set<ReferenceEvidenceSource>;
}

type ReferenceCounts = Map<number, Map<string, ReferenceCountEvidence>>;

// scip-query: ignore-wrapper — dead.ts asks for an empty evidence map
// without depending on the nested Map shape.
export function emptyReferenceCounts(): ReferenceCounts {
  return new Map();
}

// scip-query: ignore-wrapper — SCIP mention-count seeding owns row filtering
// and provenance before the dead-code pipeline adds fallback evidence.
export function loadMentionReferenceCounts(
  db: ScipDatabase,
  inactiveBarrelPaths: ReadonlySet<string>,
  symbolIds?: readonly number[],
): ReferenceCounts {
  const referencesBySymbol: ReferenceCounts = new Map();
  for (const row of mentionReferenceCountRows(db, symbolIds)) {
    if (db.isIgnored(row.relative_path)) continue;
    if (inactiveBarrelPaths.has(row.relative_path)) continue;
    recordReference(referencesBySymbol, row.symbol_id, row.relative_path, row.ref_count, 'scip-mention');
  }
  return referencesBySymbol;
}

// scip-query: ignore-wrapper — the dead-code-only path needs referenced
// symbol ids while mention-storage filtering stays here.
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

// scip-query: ignore-wrapper — positive-reference semantics belong with the
// ReferenceCounts shape, not each caller's Map traversal.
export function hasAnyReference(referencesBySymbol: ReferenceCounts, symbolId: number): boolean {
  const refs = referencesBySymbol.get(symbolId);
  if (!refs) return false;
  for (const evidence of refs.values()) {
    if (evidence.occurrences > 0) return true;
  }
  return false;
}

// scip-query: ignore-wrapper — row projection reads occurrences without
// reaching into optional evidence records directly.
export function referenceOccurrences(evidence: ReferenceCountEvidence | undefined): number {
  return evidence?.occurrences ?? 0;
}

// scip-query: ignore-wrapper — all fallback collectors use one mutation
// primitive so counts and provenance stay paired.
export function recordReference(
  referencesBySymbol: ReferenceCounts,
  symbolId: number,
  file: string,
  occurrences: number,
  source: ReferenceEvidenceSource = 'source-fallback',
): void {
  if (occurrences <= 0) return;
  const evidence = ensureReferenceEvidence(referencesBySymbol, symbolId, file);
  evidence.occurrences += occurrences;
  evidence.sources.add(source);
}

// scip-query: ignore-wrapper — caller-map supplements have minimum-count
// semantics that should not be duplicated at each call site.
export function recordReferenceAtLeast(
  referencesBySymbol: ReferenceCounts,
  symbolId: number,
  file: string,
  minimumOccurrences: number,
  source: ReferenceEvidenceSource,
): void {
  if (minimumOccurrences <= 0) return;
  const evidence = ensureReferenceEvidence(referencesBySymbol, symbolId, file);
  evidence.occurrences = Math.max(minimumOccurrences, evidence.occurrences);
  evidence.sources.add(source);
}

function ensureReferenceEvidence(
  referencesBySymbol: ReferenceCounts,
  symbolId: number,
  file: string,
): ReferenceCountEvidence {
  let refsForSymbol = referencesBySymbol.get(symbolId);
  if (!refsForSymbol) {
    refsForSymbol = new Map<string, ReferenceCountEvidence>();
    referencesBySymbol.set(symbolId, refsForSymbol);
  }
  let evidence = refsForSymbol.get(file);
  if (!evidence) {
    evidence = { occurrences: 0, sources: new Set() };
    refsForSymbol.set(file, evidence);
  }
  return evidence;
}
