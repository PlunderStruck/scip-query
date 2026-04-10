import type { ScipDatabase } from '../db.js';
import type { SimilarSymbolResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

/**
 * Find functions with similar callee fingerprints.
 *
 * For each symbol, we build the set of symbols it references (its "callees").
 * Two symbols with high Jaccard similarity in their callee sets are likely
 * doing similar work and are candidates for consolidation into a shared helper.
 *
 * Jaccard(A, B) = |A ∩ B| / |A ∪ B|
 */
export function similar(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { minSimilarity?: number; limit?: number } = {},
): SimilarSymbolResult[] {
  const { minSimilarity = 0.4, limit = 20 } = opts;

  // Get the target symbol's callee set
  const target = findCallees(db, symbolPattern);
  if (!target || target.callees.size === 0) return [];

  // Find all other non-trivial symbols and their callee sets
  const candidates = getAllCalleeFingerprints(db, {
    minCallees: 3,
    excludeSymbol: target.symbol,
  });

  // Compute Jaccard similarity against each candidate
  const results: SimilarSymbolResult[] = [];

  for (const candidate of candidates) {
    if (candidate.callees.size < 3) continue;

    const shared = intersection(target.callees, candidate.callees);
    if (shared.size === 0) continue;

    const union = unionSize(target.callees, candidate.callees);
    const similarity = shared.size / union;

    if (similarity >= minSimilarity) {
      const uniqueA = difference(target.callees, candidate.callees);
      const uniqueB = difference(candidate.callees, target.callees);

      results.push({
        symbolA: target.symbol,
        shortNameA: shortenSymbol(target.symbol),
        fileA: target.file,
        symbolB: candidate.symbol,
        shortNameB: shortenSymbol(candidate.symbol),
        fileB: candidate.file,
        similarity,
        sharedCallees: [...shared].map(shortenSymbol),
        uniqueToA: [...uniqueA].map(shortenSymbol),
        uniqueToB: [...uniqueB].map(shortenSymbol),
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

/**
 * Find similar symbols across the entire codebase — not just against one target.
 * Reports the top N most similar pairs.
 */
export function similarAll(
  db: ScipDatabase,
  opts: { minSimilarity?: number; limit?: number; scope?: string; minCallees?: number } = {},
): SimilarSymbolResult[] {
  const { minSimilarity = 0.5, limit = 20, scope, minCallees = 4 } = opts;

  const all = getAllCalleeFingerprints(db, { minCallees, scope });
  const results: SimilarSymbolResult[] = [];

  // Pairwise comparison — O(n²) but filtered by minimum callee count
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;

      // Skip if same file (within-file similarity is less interesting)
      if (a.file === b.file) continue;

      const shared = intersection(a.callees, b.callees);
      if (shared.size < 2) continue;

      const union = unionSize(a.callees, b.callees);
      const similarity = shared.size / union;

      if (similarity >= minSimilarity) {
        results.push({
          symbolA: a.symbol,
          shortNameA: shortenSymbol(a.symbol),
          fileA: a.file,
          symbolB: b.symbol,
          shortNameB: shortenSymbol(b.symbol),
          fileB: b.file,
          similarity,
          sharedCallees: [...shared].map(shortenSymbol),
          uniqueToA: [...difference(a.callees, b.callees)].map(shortenSymbol),
          uniqueToB: [...difference(b.callees, a.callees)].map(shortenSymbol),
        });
      }
    }

    // Early termination for large codebases
    if (results.length > limit * 5) break;
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
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
  const target = db.get<{
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
    WHERE gs.symbol LIKE ?
      AND d.relative_path NOT LIKE 'node_modules/%'
      AND gs.symbol NOT LIKE '%typeLiteral%'
    LIMIT 1`,
    `%${symbolPattern}%`,
  );

  if (!target) return null;

  const calleeRows = db.all<{ symbol: string }>(
    `SELECT DISTINCT callee_gs.symbol
    FROM mentions m
    JOIN chunks c ON m.chunk_id = c.id
    JOIN global_symbols callee_gs ON m.symbol_id = callee_gs.id
    JOIN defn_enclosing_ranges callee_der ON callee_gs.id = callee_der.symbol_id
    JOIN documents callee_d ON callee_der.document_id = callee_d.id
    WHERE c.document_id = ?
      AND c.start_line >= ? AND c.end_line <= ?
      AND m.role = 0
      AND callee_gs.id != ?
      AND callee_gs.symbol NOT LIKE '%typeLiteral%'
      AND callee_d.relative_path NOT LIKE 'node_modules/%'`,
    target.document_id, target.start_line, target.end_line, target.id,
  );

  return {
    symbol: target.symbol,
    file: target.relative_path,
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

  // Get all function-level symbols with their definition ranges
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
    WHERE d.relative_path NOT LIKE 'node_modules/%'
      AND d.relative_path NOT LIKE '.git/%'
      AND gs.symbol NOT LIKE '%typeLiteral%'
      AND gs.symbol NOT LIKE '%().(%'
      AND (der.end_line - der.start_line + 1) >= 5
      ${scopeFilter}
      ${excludeFilter}
    ORDER BY d.relative_path`,
  );

  const fingerprints: SymbolFingerprint[] = [];

  for (const sym of symbols) {
    if (db.isIgnored(sym.relative_path)) continue;

    const calleeRows = db.all<{ symbol: string }>(
      `SELECT DISTINCT callee_gs.symbol
      FROM mentions m
      JOIN chunks c ON m.chunk_id = c.id
      JOIN global_symbols callee_gs ON m.symbol_id = callee_gs.id
      JOIN defn_enclosing_ranges callee_der ON callee_gs.id = callee_der.symbol_id
      JOIN documents callee_d ON callee_der.document_id = callee_d.id
      WHERE c.document_id = ?
        AND c.start_line >= ? AND c.end_line <= ?
        AND m.role = 0
        AND callee_gs.id != ?
        AND callee_gs.symbol NOT LIKE '%typeLiteral%'
        AND callee_d.relative_path NOT LIKE 'node_modules/%'`,
      sym.document_id, sym.start_line, sym.end_line, sym.id,
    );

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

function unionSize<T>(a: Set<T>, b: Set<T>): number {
  const union = new Set(a);
  for (const item of b) union.add(item);
  return union.size;
}
