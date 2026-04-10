import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch, getCalleeRowsForSymbol } from '../query-support.js';
import type { SimilarSymbolResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find functions with similar callee fingerprints using TF-IDF weighted
 * cosine similarity.
 *
 * Plain Jaccard similarity inflates scores when functions share ubiquitous
 * infrastructure imports (db, types, shortenSymbol). TF-IDF fixes this by
 * weighting each shared callee by how rare it is:
 *
 *   - A callee used by 2 functions (rare) gets high weight → strong signal
 *   - A callee used by 30 functions (common) gets low weight → noise
 *
 * This means two functions sharing `sendWelcomeEmail()` (rare) score
 * much higher than two functions sharing `db.all()` (ubiquitous), even
 * though both are "shared callees."
 */
export function similar(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { minSimilarity?: number; limit?: number } = {},
): SimilarSymbolResult[] {
  const { minSimilarity = 0.4, limit = 20 } = opts;

  const target = findCallees(db, symbolPattern);
  if (!target || target.callees.size === 0) return [];

  const candidates = getAllCalleeFingerprints(db, {
    minCallees: 3,
    excludeSymbol: target.symbol,
  });

  // Compute IDF weights across all fingerprints + target
  const allFingerprints = [target, ...candidates];
  const idfWeights = computeIdf(allFingerprints);

  const results: SimilarSymbolResult[] = [];

  for (const candidate of candidates) {
    if (candidate.callees.size < 3) continue;

    const { similarity, significantShared, trivialShared } = weightedSimilarity(
      target.callees, candidate.callees, idfWeights,
    );

    if (similarity < minSimilarity) continue;
    if (significantShared.length < 1) continue; // no real overlap

    results.push({
      symbolA: target.symbol,
      shortNameA: shortenSymbol(target.symbol),
      fileA: target.file,
      symbolB: candidate.symbol,
      shortNameB: shortenSymbol(candidate.symbol),
      fileB: candidate.file,
      similarity,
      sharedCallees: significantShared.map(shortenSymbol),
      uniqueToA: [...difference(target.callees, candidate.callees)].map(shortenSymbol),
      uniqueToB: [...difference(candidate.callees, target.callees)].map(shortenSymbol),
    });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

/**
 * Find similar symbols across the entire codebase.
 * Uses TF-IDF weighted similarity to filter out infrastructure noise.
 */
export function similarAll(
  db: ScipDatabase,
  opts: { minSimilarity?: number; limit?: number; scope?: string; minCallees?: number } = {},
): SimilarSymbolResult[] {
  const { minSimilarity = 0.5, limit = 20, scope, minCallees = 4 } = opts;

  const all = getAllCalleeFingerprints(db, { minCallees, scope });
  const idfWeights = computeIdf(all);

  const results: SimilarSymbolResult[] = [];

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;

      if (a.file === b.file) continue;

      const { similarity, significantShared } = weightedSimilarity(
        a.callees, b.callees, idfWeights,
      );

      if (similarity < minSimilarity) continue;
      if (significantShared.length < 2) continue;

      results.push({
        symbolA: a.symbol,
        shortNameA: shortenSymbol(a.symbol),
        fileA: a.file,
        symbolB: b.symbol,
        shortNameB: shortenSymbol(b.symbol),
        fileB: b.file,
        similarity,
        sharedCallees: significantShared.map(shortenSymbol),
        uniqueToA: [...difference(a.callees, b.callees)].map(shortenSymbol),
        uniqueToB: [...difference(b.callees, a.callees)].map(shortenSymbol),
      });
    }

    if (results.length > limit * 5) break;
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

// ── TF-IDF Engine ──────────────────────────────────────────

/**
 * Compute inverse document frequency for each callee.
 * IDF(callee) = log(N / df(callee)) where N is total functions
 * and df is how many functions reference that callee.
 *
 * High IDF = rare callee = strong similarity signal.
 * Low IDF = ubiquitous callee = noise.
 */
function computeIdf(fingerprints: SymbolFingerprint[]): Map<string, number> {
  const n = fingerprints.length;
  if (n === 0) return new Map();

  // Count how many functions reference each callee
  const docFreq = new Map<string, number>();
  for (const fp of fingerprints) {
    for (const callee of fp.callees) {
      docFreq.set(callee, (docFreq.get(callee) ?? 0) + 1);
    }
  }

  // Compute IDF
  const idf = new Map<string, number>();
  for (const [callee, df] of docFreq) {
    idf.set(callee, Math.log(n / df));
  }

  return idf;
}

/**
 * Compute TF-IDF weighted cosine similarity between two callee sets.
 *
 * Each callee is a dimension. Its weight is its IDF score.
 * Cosine similarity of the weighted vectors gives a similarity
 * that ignores ubiquitous callees and emphasizes rare shared ones.
 *
 * Also returns which shared callees are "significant" (above-median IDF)
 * vs "trivial" (below-median IDF, i.e., infrastructure).
 */
function weightedSimilarity(
  a: Set<string>,
  b: Set<string>,
  idf: Map<string, number>,
): { similarity: number; significantShared: string[]; trivialShared: string[] } {
  const shared = intersection(a, b);
  if (shared.size === 0) return { similarity: 0, significantShared: [], trivialShared: [] };

  // Compute weighted dot product and magnitudes
  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  const allCallees = new Set([...a, ...b]);
  for (const callee of allCallees) {
    const weight = idf.get(callee) ?? 0;
    const inA = a.has(callee) ? weight : 0;
    const inB = b.has(callee) ? weight : 0;
    dotProduct += inA * inB;
    magA += inA * inA;
    magB += inB * inB;
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  const similarity = magnitude > 0 ? dotProduct / magnitude : 0;

  // Split shared callees into significant (high IDF) and trivial (low IDF)
  const medianIdf = getMedianIdf(idf);
  const significantShared: string[] = [];
  const trivialShared: string[] = [];

  for (const callee of shared) {
    const weight = idf.get(callee) ?? 0;
    if (weight >= medianIdf) {
      significantShared.push(callee);
    } else {
      trivialShared.push(callee);
    }
  }

  // Sort significant callees by IDF descending (most distinctive first)
  significantShared.sort((x, y) => (idf.get(y) ?? 0) - (idf.get(x) ?? 0));

  return { similarity, significantShared, trivialShared };
}

function getMedianIdf(idf: Map<string, number>): number {
  const values = [...idf.values()].sort((a, b) => a - b);
  if (values.length === 0) return 0;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[mid - 1]! + values[mid]!) / 2
    : values[mid]!;
}

// ── Internal helpers ───────────────────────────────────────

interface SymbolFingerprint {
  symbol: string;
  file: string;
  callees: Set<string>;
}

function findCallees(
  db: ScipDatabase,
  symbolPattern: string,
): SymbolFingerprint | null {
  const target = findFirstSymbolMatch(db, symbolPattern);

  if (!target) return null;

  const calleeRows = getCalleeRowsForSymbol(db, target);

  return {
    symbol: target.symbol,
    file: target.relativePath,
    callees: new Set(calleeRows.map((r) => r.symbol)),
  };
}

function getAllCalleeFingerprints(
  db: ScipDatabase,
  opts: { minCallees: number; scope?: string; excludeSymbol?: string },
): SymbolFingerprint[] {
  const { minCallees, scope, excludeSymbol } = opts;
  const scopeFilter = scope ? `AND d.relative_path LIKE '%${scope}%'` : '';
  const excludeFilter = excludeSymbol ? `AND gs.symbol != '${excludeSymbol.replace(/'/g, "''")}'` : '';

  const symbols = db.all<{
    id: number;
    symbol: string;
    document_id: number;
    start_line: number;
    end_line: number;
    relative_path: string;
  }>(
    `SELECT gs.id, gs.symbol, der.document_id, der.start_line, der.end_line, d.relative_path
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE 1 = 1
      ${db.pathExclusionsFor('d')}
      ${db.symbolNoiseFor('gs')}
      AND (der.end_line - der.start_line + 1) >= 5
      ${scopeFilter}
      ${excludeFilter}
    ORDER BY d.relative_path`,
  );

  const fingerprints: SymbolFingerprint[] = [];

  for (const sym of symbols) {
    if (db.isIgnored(sym.relative_path)) continue;

    const calleeRows = getCalleeRowsForSymbol(db, {
      documentId: sym.document_id,
      startLine: sym.start_line,
      endLine: sym.end_line,
      symbolId: sym.id,
    });

    const callees = new Set(calleeRows.map((r) => r.symbol));
    if (callees.size >= minCallees) {
      fingerprints.push({ symbol: sym.symbol, file: sym.relative_path, callees });
    }
  }

  return fingerprints;
}

function intersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const item of a) {
    if (b.has(item)) result.add(item);
  }
  return result;
}

function difference<T>(a: Set<T>, b: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const item of a) {
    if (!b.has(item)) result.add(item);
  }
  return result;
}
