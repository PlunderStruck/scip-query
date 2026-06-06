import type { ScipDatabase } from '../storage/db.js';
import { findFirstSymbolMatch } from '../symbols/symbol-lookup.js';
import { getCalleeRowsForSymbol } from '../symbols/reference-graph.js';
import { getSourceText } from '../source/source-text.js';
import { computeIdf, difference, intersection, weightedCosine } from '../analysis/similarity.js';
import type { SimilarSymbolResult } from '../domain/types.js';
import { isFunctionLikeSymbol, isInRustTestModule, leafName, shortenSymbol } from '../symbols/symbol-parser.js';
import { ProjectIndex } from '../core/project-index.js';

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

  const results = compareAgainstFingerprints(db, target, minSimilarity);
  if (results.length > 0) return results.slice(0, limit);
  return similarBySourceShape(db, symbolPattern, { minSimilarity, limit });
}

function compareAgainstFingerprints(
  db: ScipDatabase,
  target: SymbolFingerprint,
  minSimilarity: number,
): SimilarSymbolResult[] {
  const candidates = getAllCalleeFingerprints(db, {
    minCallees: 3,
    excludeSymbol: target.symbol,
  });
  const idfWeights = computeIdf([target, ...candidates].map((fp) => fp.callees));

  const results: SimilarSymbolResult[] = [];
  for (const candidate of candidates) {
    if (candidate.callees.size < 3) continue;
    const result = comparePair(target, candidate, idfWeights, {
      minSimilarity,
      requireSignificantShared: 1,
      requireSharedCount: 0,
    });
    if (result) results.push(result);
  }
  results.sort((a, b) => b.similarity - a.similarity);
  return results;
}

interface ComparePairOptions {
  minSimilarity: number;
  /** Pair is dropped when significantShared.length < this AND sharedCount < requireSharedCount. */
  requireSignificantShared: number;
  requireSharedCount: number;
}

function comparePair(
  a: SymbolFingerprint,
  b: SymbolFingerprint,
  idfWeights: Map<string, number>,
  opts: ComparePairOptions,
): SimilarSymbolResult | null {
  const { similarity, significantShared } = weightedCosine(a.callees, b.callees, idfWeights);
  if (similarity < opts.minSimilarity) return null;
  const sharedCount = intersection(a.callees, b.callees).size;
  if (significantShared.length < opts.requireSignificantShared && sharedCount < opts.requireSharedCount) {
    return null;
  }

  const displayShared = significantShared.length > 0
    ? significantShared
    : [...intersection(a.callees, b.callees)];

  return {
    symbolA: a.symbol,
    shortNameA: shortenSymbol(a.symbol),
    fileA: a.file,
    symbolB: b.symbol,
    shortNameB: shortenSymbol(b.symbol),
    fileB: b.file,
    similarity,
    similarityBasis: 'callees',
    sharedCallees: displayShared.map(shortenSymbol),
    uniqueToA: [...difference(a.callees, b.callees)].map(shortenSymbol),
    uniqueToB: [...difference(b.callees, a.callees)].map(shortenSymbol),
  };
}

/**
 * Find similar symbols across the entire codebase.
 * Uses TF-IDF weighted similarity to filter out infrastructure noise.
 */
export function similarAll(
  db: ScipDatabase,
  opts: {
    minSimilarity?: number;
    limit?: number;
    scope?: string;
    minCallees?: number;
    crossFileOnly?: boolean;
    scanLimit?: number;
    semantic?: boolean;
  } = {},
): SimilarSymbolResult[] {
  const { minSimilarity = 0.5, limit = 20, scope, minCallees = 4, crossFileOnly = false, scanLimit } = opts;

  const all = getAllCalleeFingerprints(db, { minCallees, scope, scanLimit, semantic: opts.semantic !== false });
  const idfWeights = computeIdf(all.map((fp) => fp.callees));

  // Inverted index: callee → indexes of fingerprints that include it. Skipping
  // ubiquitous callees (df > sqrt(N)) keeps the candidate set tight — pairs
  // joined only by an everywhere-used callee aren't meaningful similarities.
  // Without this index we'd compare every pair (N²); with it we only compare
  // pairs that share at least one moderately-rare callee.
  const docFreq = new Map<string, number>();
  for (const fp of all) for (const c of fp.callees) docFreq.set(c, (docFreq.get(c) ?? 0) + 1);
  const ubiquityThreshold = Math.max(8, Math.ceil(Math.sqrt(all.length)));
  const calleeIndex = new Map<string, number[]>();
  for (let i = 0; i < all.length; i += 1) {
    for (const callee of all[i]!.callees) {
      if ((docFreq.get(callee) ?? 0) > ubiquityThreshold) continue;
      let bucket = calleeIndex.get(callee);
      if (!bucket) { bucket = []; calleeIndex.set(callee, bucket); }
      bucket.push(i);
    }
  }

  const results: SimilarSymbolResult[] = [];
  const seenPair = new Set<string>();

  outer: for (let i = 0; i < all.length; i += 1) {
    const a = all[i]!;
    const candidates = new Set<number>();
    for (const callee of a.callees) {
      const bucket = calleeIndex.get(callee);
      if (!bucket) continue;
      for (const j of bucket) if (j > i) candidates.add(j);
    }
    for (const j of candidates) {
      const pairKey = `${i}|${j}`;
      if (seenPair.has(pairKey)) continue;
      seenPair.add(pairKey);
      const b = all[j]!;

      if (crossFileOnly && a.file === b.file) continue;

      // Signature filter: a 1-arg helper and a 7-arg orchestrator that share
      // infrastructure callees aren't really "similar." If both sides have
      // a known param count, skip pairs that differ by more than 2 OR by
      // more than 50% (whichever is larger). Pairs without sig info pass
      // through (non-AST languages, indirect AST resolution failure).
      if (a.paramCount >= 0 && b.paramCount >= 0) {
        const diff = Math.abs(a.paramCount - b.paramCount);
        const maxAllowed = Math.max(2, Math.ceil(Math.max(a.paramCount, b.paramCount) * 0.5));
        if (diff > maxAllowed) continue;
      }

      const result = comparePair(a, b, idfWeights, {
        minSimilarity,
        requireSignificantShared: 2,
        requireSharedCount: 4,
      });
      if (!result) continue;
      results.push(result);

      if (results.length > limit * 5) break outer;
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

// ── Internal helpers ───────────────────────────────────────

interface SymbolFingerprint {
  symbol: string;
  file: string;
  callees: Set<string>;
  paramCount: number;
}

interface SourceFingerprint {
  symbol: string;
  file: string;
  tokens: Set<string>;
}

const INFRASTRUCTURE_CALLEE_FRAGMENTS = [
  'ScipDatabase#all',
  'ScipDatabase#get',
  'ScipDatabase#prepare',
  'ScipDatabase#pathExclusionsFor',
  'ScipDatabase#isIgnored',
  'ScipDatabase#symbolNoiseFor',
  'PerDbValue#get',
  'PerDbValue#has',
  ':storage:db:ScipDatabase:all',
  ':storage:db:ScipDatabase:get',
  ':storage:db:ScipDatabase:prepare',
  ':storage:db:ScipDatabase:pathExclusionsFor',
  ':storage:db:ScipDatabase:isIgnored',
  ':storage:db:ScipDatabase:symbolNoiseFor',
  ':storage:per-db-cache:PerDbValue:get',
  ':storage:per-db-cache:PerDbValue:has',
];

function findCallees(
  db: ScipDatabase,
  symbolPattern: string,
): SymbolFingerprint | null {
  const target = findFirstSymbolMatch(db, symbolPattern);
  const index = new ProjectIndex(db);

  if (!target) return null;

  const calleeRows = getCalleeRowsForSymbol(db, target);

  return {
    symbol: target.symbol,
    file: target.relativePath,
    callees: meaningfulCallees(calleeRows.map((r) => r.symbol)),
    paramCount: index.callableSignature(target)?.paramCount ?? -1,
  };
}

// scip-query: ignore-extract — this builds callee-set fingerprints for
// similarity; callable selection, signature lookup, callee filtering, and
// fingerprint shaping are one evidence pass.
function getAllCalleeFingerprints(
  db: ScipDatabase,
  opts: { minCallees: number; scope?: string; excludeSymbol?: string; scanLimit?: number; semantic?: boolean },
): SymbolFingerprint[] {
  const { minCallees, scope, excludeSymbol, scanLimit } = opts;
  const index = new ProjectIndex(db);

  const candidates = applyScanLimit(
    index.productionCallableDefinitions({
      scope,
      minLoc: 5,
      excludeSymbol,
      sortByLocDesc: typeof scanLimit === 'number' && scanLimit > 0,
    }),
    scanLimit,
  );
  const calleeMap = index.calleeMap(candidates, { semantic: opts.semantic !== false });

  return candidates
    .map((d) => ({
      symbol: d.symbol,
      file: d.relativePath,
      callees: meaningfulCallees((calleeMap.get(d.symbolId) ?? []).map((c) => c.symbol)),
      paramCount: index.callableSignature(d)?.paramCount ?? -1,
    }))
    .filter((fp) => fp.callees.size >= minCallees);
}

function applyScanLimit<T>(items: T[], scanLimit: number | undefined): T[] {
  if (typeof scanLimit !== 'number' || scanLimit <= 0 || items.length <= scanLimit) {
    return items;
  }
  return items.slice(0, scanLimit);
}

function meaningfulCallees(callees: Iterable<string>): Set<string> {
  return new Set([...callees].filter((callee) => !isInfrastructureCallee(callee)));
}

function isInfrastructureCallee(callee: string): boolean {
  return INFRASTRUCTURE_CALLEE_FRAGMENTS.some((fragment) => callee.includes(fragment));
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
      similarityBasis: 'source-tokens',
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
  const tokens = buildSourceFingerprintTokens(db, match);
  if (!tokens) return null;
  return { symbol: match.symbol, file: match.relativePath, tokens };
}

function buildSourceFingerprintTokens(
  db: ScipDatabase,
  match: { symbol: string; relativePath: string; startLine: number; endLine: number },
): Set<string> | null {
  const leaf = leafName(match.symbol);
  const snippet = definitionSnippet(db, match.relativePath, match.startLine, match.endLine, leaf);
  const tokens = sourceTokens(snippet, leaf);
  return tokens.size > 0 ? tokens : null;
}

// scip-query: ignore-extract — this builds source-token fingerprints; scoped
// definitions, file-kind filtering, snippets, and token extraction are one
// text-similarity pass.
function getAllSourceFingerprints(db: ScipDatabase): SourceFingerprint[] {
  const index = new ProjectIndex(db);
  return index.scopedDefinitions()
    .filter((definition) => definition.isFunctionLike)
    .filter((definition) => index.fileKind(definition.relativePath) !== 'test')
    .filter((definition) => !isInRustTestModule(definition.symbol))
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
