import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch, getAllDefinitions, getCalleeRowsForSymbol } from '../query-support.js';
import { getSourceText } from '../source-analysis.js';
import type { SimilarSymbolResult } from '../types.js';
import { isFunctionLikeSymbol, leafName, shortenSymbol } from '../symbol-parser.js';

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
  if (!target) return [];
  if (!isFunctionLikeSymbol(target.symbol)) return [];

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

    const { similarity, significantShared } = weightedSimilarity(
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
  if (results.length > 0) {
    return results.slice(0, limit);
  }

  return similarBySourceShape(db, symbolPattern, { minSimilarity, limit });
}

/**
 * Find similar symbols across the entire codebase.
 * Uses TF-IDF weighted similarity to filter out infrastructure noise.
 */
export function similarAll(
  db: ScipDatabase,
  opts: { minSimilarity?: number; limit?: number; scope?: string; minCallees?: number; crossFileOnly?: boolean } = {},
): SimilarSymbolResult[] {
  const { minSimilarity = 0.5, limit = 20, scope, minCallees = 4, crossFileOnly = false } = opts;

  const all = getAllCalleeFingerprints(db, { minCallees, scope });
  const idfWeights = computeIdf(all);

  const results: SimilarSymbolResult[] = [];

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;

      if (crossFileOnly && a.file === b.file) continue;

      const { similarity, significantShared } = weightedSimilarity(
        a.callees, b.callees, idfWeights,
      );

      if (similarity < minSimilarity) continue;

      // Require at least some meaningful overlap. If TF-IDF classifies all
      // shared callees as trivial but raw overlap is substantial (>= 4 shared),
      // still include the pair — many shared "common" callees is itself a signal.
      const sharedCount = intersection(a.callees, b.callees).size;
      if (significantShared.length < 2 && sharedCount < 4) continue;

      // Use significant callees if available, otherwise fall back to all shared
      const displayShared = significantShared.length > 0
        ? significantShared
        : [...intersection(a.callees, b.callees)];

      results.push({
        symbolA: a.symbol,
        shortNameA: shortenSymbol(a.symbol),
        fileA: a.file,
        symbolB: b.symbol,
        shortNameB: shortenSymbol(b.symbol),
        fileB: b.file,
        similarity,
        sharedCallees: displayShared.map(shortenSymbol),
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

interface SourceFingerprint {
  symbol: string;
  file: string;
  tokens: Set<string>;
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
  const fingerprints: SymbolFingerprint[] = [];

  for (const definition of getAllDefinitions(db, { scope })) {
    if (db.isIgnored(definition.relativePath)) continue;
    if (!definition.isFunctionLike) continue;
    if (excludeSymbol && definition.symbol === excludeSymbol) continue;
    // Minimum LOC guard matches the previous SQL filter. Keeps small helpers
    // out of the fingerprint set — their callee sets are too thin for TF-IDF
    // similarity to be meaningful.
    if ((definition.endLine - definition.startLine + 1) < 5) continue;

    const callees = new Set(
      getCalleeRowsForSymbol(db, definition).map((row) => row.symbol),
    );
    if (callees.size < minCallees) continue;

    fingerprints.push({
      symbol: definition.symbol,
      file: definition.relativePath,
      callees,
    });
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

function similarBySourceShape(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { minSimilarity: number; limit: number },
): SimilarSymbolResult[] {
  const target = findSourceFingerprint(db, symbolPattern);
  if (!target || target.tokens.size < 3) {
    return [];
  }

  const minSimilarity = opts.minSimilarity >= 0.5 ? opts.minSimilarity : 0.3;
  const results: SimilarSymbolResult[] = [];

  for (const candidate of getAllSourceFingerprints(db)) {
    if (candidate.symbol === target.symbol || candidate.tokens.size < 3) continue;

    const shared = intersection(target.tokens, candidate.tokens);
    if (shared.size < 2) continue;

    const union = new Set([...target.tokens, ...candidate.tokens]);
    const similarity = union.size > 0 ? shared.size / union.size : 0;
    if (similarity < minSimilarity) continue;

    results.push({
      symbolA: target.symbol,
      shortNameA: shortenSymbol(target.symbol),
      fileA: target.file,
      symbolB: candidate.symbol,
      shortNameB: shortenSymbol(candidate.symbol),
      fileB: candidate.file,
      similarity,
      sharedCallees: [...shared].sort(),
      uniqueToA: [...difference(target.tokens, candidate.tokens)].sort(),
      uniqueToB: [...difference(candidate.tokens, target.tokens)].sort(),
    });
  }

  results.sort((a, b) => b.similarity - a.similarity || a.shortNameB.localeCompare(b.shortNameB));
  return results.slice(0, opts.limit);
}

function findSourceFingerprint(
  db: ScipDatabase,
  symbolPattern: string,
): SourceFingerprint | null {
  const match = findFirstSymbolMatch(db, symbolPattern);
  if (!match || !isFunctionLikeSymbol(match.symbol)) {
    return null;
  }

  const snippet = definitionSnippet(db, match.relativePath, match.startLine, match.endLine, leafName(match.symbol));
  const tokens = sourceTokens(snippet, leafName(match.symbol));
  if (tokens.size === 0) {
    return null;
  }

  return {
    symbol: match.symbol,
    file: match.relativePath,
    tokens,
  };
}

function getAllSourceFingerprints(db: ScipDatabase): SourceFingerprint[] {
  return getAllDefinitions(db)
    .filter((definition) => definition.isFunctionLike)
    .map((definition) => ({
      symbol: definition.symbol,
      file: definition.relativePath,
      tokens: sourceTokens(
        definitionSnippet(db, definition.relativePath, definition.startLine, definition.endLine, definition.leaf),
        definition.leaf,
      ),
    }))
    .filter((fingerprint) => fingerprint.tokens.size > 0);
}

function definitionSnippet(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
  leaf: string,
): string {
  const source = getSourceText(db, relativePath);
  if (!source) {
    return '';
  }

  const lines = source.split('\n');
  if (endLine >= startLine && (endLine - startLine) <= 12) {
    return lines.slice(startLine, endLine + 1).join('\n');
  }

  const markerPatterns = [
    new RegExp(`\\bdef\\s+${escapeRegex(leaf)}\\b`),
    new RegExp(`\\bfun\\s+${escapeRegex(leaf)}\\b`),
    new RegExp(`\\bfn\\s+${escapeRegex(leaf)}\\b`),
    new RegExp(`\\bfunction\\s+${escapeRegex(leaf)}\\b`),
    new RegExp(`\\b${escapeRegex(leaf)}\\s*\\(`),
  ];
  const definitionStart = lines.findIndex((line) => markerPatterns.some((pattern) => pattern.test(line)));
  if (definitionStart >= 0) {
    let definitionEnd = definitionStart;
    for (let index = definitionStart + 1; index < lines.length && index <= definitionStart + 8; index++) {
      const line = lines[index] ?? '';
      if (index > definitionStart && looksLikeDefinitionBoundary(line)) {
        break;
      }
      definitionEnd = index;
      if (line.trim() === '' && index > definitionStart + 1) {
        break;
      }
    }
    return lines.slice(definitionStart, definitionEnd + 1).join('\n');
  }

  return lines.slice(startLine, Math.min(lines.length, startLine + 8)).join('\n');
}

function sourceTokens(
  snippet: string,
  leaf: string,
): Set<string> {
  if (!snippet) {
    return new Set();
  }

  const stopWords = new Set([
    'public', 'private', 'protected', 'final', 'static', 'class', 'def', 'fun', 'fn', 'function',
    'return', 'string', 'bool', 'boolean', 'void', 'unit', 'self', 'this', 'new', 'const', 'let', 'var',
    'end', 'pub',
  ]);
  const normalizedLeafParts = splitIdentifier(leaf);
  const normalized = snippet
    .replace(/["'`]/g, ' ')
    .replace(/\b\d+\b/g, ' NUM ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9_]+/g, ' ')
    .replace(/_/g, ' ')
    .toLowerCase();

  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
    .filter((token) => !stopWords.has(token))
    .filter((token) => !normalizedLeafParts.has(token));

  return new Set(tokens);
}

function splitIdentifier(value: string): Set<string> {
  return new Set(
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9_]+|_/)
      .map((part) => part.toLowerCase())
      .filter((part) => part.length > 1),
  );
}

function looksLikeDefinitionBoundary(line: string): boolean {
  return /^\s*(?:def|fun|fn|function|class|trait|module|object|enum|interface|public|private|protected)\b/.test(line);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
