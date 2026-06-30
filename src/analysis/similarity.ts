/**
 * Similarity-math kernel — set operations and TF-IDF / cosine / Jaccard
 * primitives used by the `similar*` queries.
 *
 * Honest scope: only similar.ts uses TF-IDF + weighted cosine. similar-
 * files.ts uses Jaccard inline. similar-chains.ts uses edit distance over
 * sequences (different algorithm), and similar-signatures.ts does exact
 * matching on normalized strings (no similarity math).
 * incomplete-migration.ts uses containment + IDF significance.
 *
 * What this module owns: the math primitives the first two share. It is
 * stateless — callers own corpus caching.
 */

// scip-query: ignore-wrapper — multi-call-site math primitive; the module's
// documented job is owning these, single consumer FILE notwithstanding.
/** Set intersection. */
export function intersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const item of a) {
    if (b.has(item)) out.add(item);
  }
  return out;
}

// scip-query: ignore-wrapper — same: named primitive with multiple call sites.
/** Set difference: items in a not in b. */
export function difference<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const item of a) {
    if (!b.has(item)) out.add(item);
  }
  return out;
}

/** Plain Jaccard: |A∩B| / |A∪B|. Returns 0 for two empty sets. */
export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Containment: |A∩B| / |A| — how much of A lives inside B. Asymmetric on
 * purpose: a site that inlines a helper's logic plus its own surrounding
 * logic contains the helper fully even though cosine/Jaccard would be
 * diluted by the site's unique features. Returns 0 for an empty A.
 */
export function containment<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / a.size;
}

// scip-query: ignore-wrapper — similarity hot paths reuse precomputed doc
// frequencies; keep the IDF formula named and testable.
export function computeIdfFromDocFreq<T>(docFreq: ReadonlyMap<T, number>, documentCount: number): Map<T, number> {
  if (documentCount <= 0) return new Map();

  const idf = new Map<T, number>();
  for (const [feature, df] of docFreq) {
    if (df > 0) idf.set(feature, Math.log(documentCount / df));
  }
  return idf;
}

/** Median IDF weight in the index. Used as the trivial/significant split. */
// scip-query: ignore-wrapper — this names the significant/trivial split policy
// used by similarity output and avoids burying it inside candidate scoring.
export function getMedianIdf<T>(idf: ReadonlyMap<T, number>): number {
  const values = [...idf.values()].sort((a, b) => a - b);
  if (values.length === 0) return 0;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[mid - 1]! + values[mid]!) / 2 : values[mid]!;
}

export interface WeightedCosineResult<T> {
  similarity: number;
  /** Shared features whose IDF weight is at or above the corpus median. */
  significantShared: T[];
  /** Shared features below the median — infrastructure-style ubiquitous deps. */
  trivialShared: T[];
}

/**
 * Length of one IDF-weighted feature vector. Callers that compare one item to
 * many others can compute this once per item and reuse it for exact cosine
 * scoring.
 */
// scip-query: ignore-wrapper — callers cache this vector length in hot loops;
// keep the reusable weighted-cosine primitive explicit.
export function weightedMagnitude<T>(features: Set<T>, idf: ReadonlyMap<T, number>): number {
  let squared = 0;
  for (const feature of features) {
    const weight = idf.get(feature) ?? 0;
    squared += weight * weight;
  }
  return Math.sqrt(squared);
}

/**
 * IDF-weighted cosine similarity between two feature sets.
 *
 * Each feature is a dimension; its weight is its IDF. Cosine of the two
 * weighted vectors gives a score that ignores ubiquitous features and
 * emphasizes rare shared ones.
 *
 * Also splits the shared features into "significant" (≥ median IDF) and
 * "trivial" (< median IDF), so callers can show which shared features
 * actually distinguish the pair.
 */
export function weightedCosine<T>(
  a: Set<T>,
  b: Set<T>,
  idf: ReadonlyMap<T, number>,
  opts: { medianIdf?: number } = {},
): WeightedCosineResult<T> {
  let dotProduct = 0;
  let magA = 0;
  let magB = 0;
  const median = opts.medianIdf ?? getMedianIdf(idf);
  const significantShared: T[] = [];
  const trivialShared: T[] = [];

  for (const feature of a) {
    const weight = idf.get(feature) ?? 0;
    magA += weight * weight;
    if (b.has(feature)) {
      dotProduct += weight * weight;
      if (weight >= median) significantShared.push(feature);
      else trivialShared.push(feature);
    }
  }
  if (significantShared.length === 0 && trivialShared.length === 0) {
    return { similarity: 0, significantShared: [], trivialShared: [] };
  }
  for (const feature of b) {
    const weight = idf.get(feature) ?? 0;
    magB += weight * weight;
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  const similarity = magnitude > 0 ? dotProduct / magnitude : 0;

  significantShared.sort((x, y) => (idf.get(y) ?? 0) - (idf.get(x) ?? 0));

  return { similarity, significantShared, trivialShared };
}

/**
 * IDF-weighted cosine similarity when the vector lengths are already known.
 * This preserves `weightedCosine` semantics while avoiding repeated magnitude
 * work in pairwise scans.
 */
export function weightedCosineWithMagnitudes<T>(
  a: Set<T>,
  b: Set<T>,
  idf: ReadonlyMap<T, number>,
  opts: { medianIdf?: number; magnitudeA: number; magnitudeB: number },
): WeightedCosineResult<T> {
  let dotProduct = 0;
  const median = opts.medianIdf ?? getMedianIdf(idf);
  const significantShared: T[] = [];
  const trivialShared: T[] = [];

  for (const feature of a) {
    if (!b.has(feature)) continue;
    const weight = idf.get(feature) ?? 0;
    dotProduct += weight * weight;
    if (weight >= median) significantShared.push(feature);
    else trivialShared.push(feature);
  }
  if (significantShared.length === 0 && trivialShared.length === 0) {
    return { similarity: 0, significantShared: [], trivialShared: [] };
  }

  const magnitude = opts.magnitudeA * opts.magnitudeB;
  const similarity = magnitude > 0 ? dotProduct / magnitude : 0;

  significantShared.sort((x, y) => (idf.get(y) ?? 0) - (idf.get(x) ?? 0));

  return { similarity, significantShared, trivialShared };
}
