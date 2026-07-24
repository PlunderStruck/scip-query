import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { getCalleeRowsForSymbol } from '../../symbols/graph/call-graph-evidence.js';
import { getSourceLines, getSourceText } from '../../source/source-text.js';
import { escapeRegex } from '../../source/regex-utils.js';
import {
  computeIdfFromDocFreq,
  difference,
  getMedianIdf,
  intersection,
  weightedCosineWithMagnitudes,
  weightedCosine,
  weightedMagnitude,
} from '../../analysis/similarity.js';
import { isFunctionLikeSymbol, leafName, shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../internal/project-index.js';
import { createPerDbValue } from '../../storage/per-db-cache.js';
import { applyScanLimit } from '../query-utils.js';
import { fileContentHash } from '../../storage/evidence-cache.js';
import { createFileEvidenceProduct, evidenceProductInvalidation } from '../../storage/evidence-products.js';
import { profileEnabled, profileSpan } from '../../instrumentation/profile.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';

export interface SimilarSymbolResult {
  symbolA: string;
  shortNameA: string;
  fileA: string;
  symbolB: string;
  shortNameB: string;
  fileB: string;
  /** Similarity score (0-1). Basis says what evidence was compared. */
  similarity: number;
  /** Evidence used for similarity: call graph callees or lexical source tokens. */
  similarityBasis?: 'callees' | 'source-tokens';
  /** Shared callees or source tokens, depending on similarityBasis. */
  sharedCallees: string[];
  /** Callees or source tokens unique to A, depending on similarityBasis. */
  uniqueToA: string[];
  /** Callees or source tokens unique to B, depending on similarityBasis. */
  uniqueToB: string[];
  evidenceClass: SimilarEvidenceClass;
  actionTier: SimilarActionTier;
  evidenceClassReasons: string[];
  recommendation: string;
}

export interface SimilarConsolidationPlan {
  symbolA: { symbol: string; shortName: string; file: string; loc: number };
  symbolB: { symbol: string; shortName: string; file: string; loc: number };
  similarity: number;
  similarityBasis: NonNullable<SimilarSymbolResult['similarityBasis']>;
  sharedEvidence: string[];
  uniqueToA: string[];
  uniqueToB: string[];
  evidenceClass: SimilarEvidenceClass;
  actionTier: SimilarActionTier;
  recommendation: string;
  consolidationStrategy: string;
}

export type SimilarEvidenceClass =
  | 'access-query-scaffolding'
  | 'domain-behavior'
  | 'framework-scaffolding'
  | 'mixed'
  | 'structural-overlap';
export type SimilarActionTier = 'direct' | 'signal';

export interface SimilarEvidenceClassification {
  evidenceClass: SimilarEvidenceClass;
  actionTier: SimilarActionTier;
  evidenceClassReasons: string[];
  recommendation: string;
}

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
  opts: {
    minSimilarity?: number;
    limit?: number;
    scanLimit?: number;
    semantic?: boolean;
    sourceCandidateMode?: SourceCandidateMode;
  } = {},
): SimilarSymbolResult[] {
  const { minSimilarity = 0.4, limit = 20 } = opts;

  const target = findCallees(db, symbolPattern, { semantic: opts.semantic !== false });
  if (!target) return [];
  if (!isFunctionLikeSymbol(target.symbol)) return [];
  if (target.callees.size === 0) {
    return similarBySourceShape(db, symbolPattern, {
      minSimilarity,
      limit,
      scanLimit: opts.scanLimit,
      candidateMode: opts.sourceCandidateMode ?? 'full',
    });
  }

  const results = compareAgainstFingerprints(db, target, minSimilarity, {
    scanLimit: opts.scanLimit,
    semantic: opts.semantic !== false,
  });
  if (results.length > 0) return results.slice(0, limit);
  return similarBySourceShape(db, symbolPattern, {
    minSimilarity,
    limit,
    scanLimit: opts.scanLimit,
    candidateMode: opts.sourceCandidateMode ?? 'full',
  });
}

export function similarConsolidationPlan(
  db: ScipDatabase,
  symbolPatternA: string,
  symbolPatternB: string,
  opts: { semantic?: boolean; scanLimit?: number } = {},
): SimilarConsolidationPlan | null {
  const matchA = findFirstSymbolMatch(db, symbolPatternA);
  const matchB = findFirstSymbolMatch(db, symbolPatternB);
  if (!matchA || !matchB) return null;

  const row = similar(db, matchA.symbol, {
    minSimilarity: 0,
    limit: Number.POSITIVE_INFINITY,
    semantic: opts.semantic,
    scanLimit: opts.scanLimit,
  }).find((candidate) => candidate.symbolB === matchB.symbol || candidate.symbolA === matchB.symbol);
  if (!row) return null;

  const locA = matchA.endLine - matchA.startLine + 1;
  const locB = matchB.endLine - matchB.startLine + 1;
  return {
    symbolA: { symbol: matchA.symbol, shortName: shortenSymbol(matchA.symbol), file: matchA.relativePath, loc: locA },
    symbolB: { symbol: matchB.symbol, shortName: shortenSymbol(matchB.symbol), file: matchB.relativePath, loc: locB },
    similarity: row.similarity,
    similarityBasis: row.similarityBasis ?? 'callees',
    sharedEvidence: row.sharedCallees,
    uniqueToA: row.uniqueToA,
    uniqueToB: row.uniqueToB,
    evidenceClass: row.evidenceClass,
    actionTier: row.actionTier,
    recommendation: row.recommendation,
    consolidationStrategy: consolidationStrategyForSimilarRow(row),
  };
}

function consolidationStrategyForSimilarRow(row: SimilarSymbolResult): string {
  const evidenceNoun = row.similarityBasis === 'source-tokens' ? 'source-token' : 'tracked callee';
  if (row.sharedCallees.length === 0) {
    return `No shared ${evidenceNoun} evidence survived similar's weighting. Inspect the source before attempting consolidation.`;
  }
  if (row.uniqueToA.length === 0 && row.uniqueToB.length === 0) {
    return `The functions have identical ${evidenceNoun} evidence under similar's weighting. Verify signatures, guards, and return values before consolidating.`;
  }
  if (row.uniqueToA.length === 0) {
    return `A's ${evidenceNoun} evidence is a subset of B's. B may subsume part of A's structure, but verify signatures, guards, and non-call logic first.`;
  }
  if (row.uniqueToB.length === 0) {
    return `B's ${evidenceNoun} evidence is a subset of A's. A may subsume part of B's structure, but verify signatures, guards, and non-call logic first.`;
  }
  if (row.uniqueToA.length <= 2 && row.uniqueToB.length <= 2) {
    return `Create a shared helper around the ${row.sharedCallees.length} shared ${evidenceNoun}(s). Pass the ${row.uniqueToA.length + row.uniqueToB.length} divergent point(s) as parameters or callbacks.`;
  }
  return `Extract the ${row.sharedCallees.length} shared ${evidenceNoun}(s) into a common helper. Keep each function's unique logic outside that helper (${row.uniqueToA.length} item(s) in A, ${row.uniqueToB.length} in B).`;
}

function compareAgainstFingerprints(
  db: ScipDatabase,
  target: SymbolFingerprint,
  minSimilarity: number,
  opts: { scanLimit?: number; semantic: boolean },
): SimilarSymbolResult[] {
  const index = similarityFingerprintProduct(db).calleeIndex({
    minCallees: 3,
    scanLimit: opts.scanLimit,
    semantic: opts.semantic,
  });
  // `target` comes from an ad hoc single-symbol lookup (findCallees), not the
  // corpus `buildCalleeFingerprints` already trimmed — trim it against the
  // same same-file-sibling-saturation rule so a direct `similar <symbol>`
  // lookup can't be fooled by generic same-file helpers either.
  const trimmedTarget = trimTargetSameFileSiblingSaturatedCallees(target, index.corpus);
  const candidates = candidateFingerprintsForTarget(trimmedTarget, index);
  const idfWeights = targetSpecificIdfWeights(trimmedTarget, index);
  const medianIdf = getMedianIdf(idfWeights);
  const targetMagnitude = weightedMagnitude(trimmedTarget.callees, idfWeights);

  const results: SimilarSymbolResult[] = [];
  for (const candidate of candidates) {
    if (candidate.callees.size < 3) continue;
    const candidateMagnitude = weightedMagnitude(candidate.callees, idfWeights);
    const result = comparePair(trimmedTarget, candidate, idfWeights, {
      minSimilarity,
      requireSignificantShared: 1,
      requireSharedCount: 0,
      medianIdf,
      magnitudeA: targetMagnitude,
      magnitudeB: candidateMagnitude,
    });
    if (result) results.push(result);
  }
  results.sort((a, b) => b.similarity - a.similarity);
  return results;
}

export function targetSpecificIdfWeights(
  target: SymbolFingerprint,
  index: Pick<CalleeFingerprintIndex, 'corpus' | 'docFreq'>,
): Map<string, number> {
  const docFreq = new Map(index.docFreq);
  for (const callee of target.callees) {
    docFreq.set(callee, (docFreq.get(callee) ?? 0) + 1);
  }
  return computeIdfFromDocFreq(docFreq, index.corpus.length + 1);
}

interface ComparePairOptions {
  minSimilarity: number;
  /** Pair is dropped when significantShared.length < this AND sharedCount < requireSharedCount. */
  requireSignificantShared: number;
  requireSharedCount: number;
  medianIdf?: number;
  magnitudeA?: number;
  magnitudeB?: number;
}

interface PairCosine {
  similarity: number;
  significantShared: string[];
  trivialShared: string[];
}

// Exported for direct pure-pipeline testing (trim -> index -> compare)
// without needing a database fixture.
export function comparePair(
  a: SymbolFingerprint,
  b: SymbolFingerprint,
  idfWeights: ReadonlyMap<string, number>,
  opts: ComparePairOptions,
): SimilarSymbolResult | null {
  const cosine = pairCosine(a, b, idfWeights, opts);
  if (!cosinePasses(cosine, opts)) return null;
  const { similarity, significantShared, trivialShared } = cosine;

  const displayShared = significantShared.length > 0 ? significantShared : trivialShared;
  const classification = classifySimilarityEvidence(displayShared, 'callees');

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
    ...classification,
  };
}

function pairPassesSimilarity(
  a: SymbolFingerprint,
  b: SymbolFingerprint,
  idfWeights: ReadonlyMap<string, number>,
  opts: ComparePairOptions,
): boolean {
  const magnitudeA = opts.magnitudeA ?? weightedMagnitude(a.callees, idfWeights);
  const magnitudeB = opts.magnitudeB ?? weightedMagnitude(b.callees, idfWeights);
  let dotProduct = 0;
  let significantShared = 0;
  let sharedCount = 0;
  const median = opts.medianIdf ?? getMedianIdf(idfWeights);

  for (const callee of a.callees) {
    if (!b.callees.has(callee)) continue;
    const weight = idfWeights.get(callee) ?? 0;
    dotProduct += weight * weight;
    sharedCount += 1;
    if (weight >= median) significantShared += 1;
  }
  if (sharedCount === 0) return false;

  const magnitude = magnitudeA * magnitudeB;
  const similarity = magnitude > 0 ? dotProduct / magnitude : 0;
  if (similarity < opts.minSimilarity) return false;
  return significantShared >= opts.requireSignificantShared || sharedCount >= opts.requireSharedCount;
}

function pairCosine(
  a: SymbolFingerprint,
  b: SymbolFingerprint,
  idfWeights: ReadonlyMap<string, number>,
  opts: ComparePairOptions,
): PairCosine {
  return opts.magnitudeA === undefined || opts.magnitudeB === undefined
    ? weightedCosine(a.callees, b.callees, idfWeights, {
        medianIdf: opts.medianIdf,
      })
    : weightedCosineWithMagnitudes(a.callees, b.callees, idfWeights, {
        medianIdf: opts.medianIdf,
        magnitudeA: opts.magnitudeA,
        magnitudeB: opts.magnitudeB,
      });
}

function cosinePasses(cosine: PairCosine, opts: ComparePairOptions): boolean {
  if (cosine.similarity < opts.minSimilarity) return false;
  const sharedCount = cosine.significantShared.length + cosine.trivialShared.length;
  return cosine.significantShared.length >= opts.requireSignificantShared || sharedCount >= opts.requireSharedCount;
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
    focusFiles?: ReadonlySet<string>;
  } = {},
): SimilarSymbolResult[] {
  const { minSimilarity = 0.5, limit = 20, scope, minCallees = 4, crossFileOnly = false, scanLimit } = opts;
  const semantic = opts.semantic !== false;
  const profiling = profileEnabled();
  let corpusSize = 0;
  let candidateSets = 0;
  let candidatePairs = 0;
  let comparedPairs = 0;
  let crossFileSkips = 0;
  let signatureSkips = 0;
  let insertedResults = 0;

  return profileSpan(
    'similar.all',
    () => {
      const fingerprints = similarityFingerprintProduct(db);
      const index = fingerprints.calleeIndex({
        minCallees,
        scope,
        scanLimit,
        semantic,
      });
      const all = index.corpus;
      corpusSize = all.length;
      const focusFiles = opts.focusFiles;

      const topResults: RankedSimilarResult[] = [];
      let resultOrder = 0;

      profileSpan(
        'similar.all.pair-scan',
        () => {
          for (let i = 0; i < all.length; i += 1) {
            const a = all[i]!;
            const aFocused = focusFiles?.has(a.file) ?? false;
            const magnitudeA = index.weightedMagnitudes[i]!;
            const candidates = new Set<number>();
            for (const callee of a.callees) {
              const bucket = index.candidateIndexesByCallee.get(callee);
              if (!bucket) continue;
              for (const j of bucket) {
                if (j <= i) continue;
                if (focusFiles && !aFocused && !focusFiles.has(all[j]!.file)) continue;
                candidates.add(j);
              }
            }
            if (profiling) {
              candidatePairs += candidates.size;
              if (candidates.size > 0) candidateSets += 1;
            }

            for (const j of candidates) {
              const b = all[j]!;

              if (crossFileOnly && a.file === b.file) {
                if (profiling) crossFileSkips += 1;
                continue;
              }

              if (signaturePairShouldSkip(a, b)) {
                if (profiling) signatureSkips += 1;
                continue;
              }

              if (profiling) comparedPairs += 1;
              const result = comparePair(a, b, index.idfWeights, {
                minSimilarity,
                requireSignificantShared: 2,
                requireSharedCount: 4,
                medianIdf: index.medianIdf,
                magnitudeA,
                magnitudeB: index.weightedMagnitudes[j]!,
              });
              if (!result) continue;
              insertTopSimilarResult(topResults, result, limit, resultOrder);
              if (profiling) insertedResults += 1;
              resultOrder += 1;
            }
          }
        },
        () => ({
          corpusSize,
          candidateSets,
          candidatePairs,
          comparedPairs,
          crossFileSkips,
          signatureSkips,
          insertedResults,
          topResults: topResults.length,
        }),
      );

      return profileSpan(
        'similar.all.sort-project',
        () => {
          topResults.sort((a, b) => b.result.similarity - a.result.similarity || a.order - b.order);
          return topResults.map((entry) => entry.result);
        },
        () => ({ topResults: topResults.length }),
      );
    },
    () => ({
      minSimilarity,
      limit,
      scope,
      minCallees,
      crossFileOnly,
      scanLimit,
      semantic,
      corpusSize,
      candidateSets,
      candidatePairs,
      comparedPairs,
      crossFileSkips,
      signatureSkips,
      insertedResults,
    }),
  );
}

// scip-query: ignore-similar - the count-only path mirrors similarAll without retaining ranked result objects.
export function similarAllCount(
  db: ScipDatabase,
  opts: {
    minSimilarity?: number;
    scope?: string;
    minCallees?: number;
    crossFileOnly?: boolean;
    scanLimit?: number;
    semantic?: boolean;
    focusFiles?: ReadonlySet<string>;
  } = {},
): number {
  const { minSimilarity = 0.5, scope, minCallees = 4, crossFileOnly = false, scanLimit } = opts;
  const semantic = opts.semantic !== false;
  const profiling = profileEnabled();
  let corpusSize = 0;
  let candidateSets = 0;
  let candidatePairs = 0;
  let comparedPairs = 0;
  let crossFileSkips = 0;
  let signatureSkips = 0;
  let insertedResults = 0;

  return profileSpan(
    'similar.all-count',
    () => {
      const fingerprints = similarityFingerprintProduct(db);
      const index = fingerprints.calleeIndex({
        minCallees,
        scope,
        scanLimit,
        semantic,
      });
      const all = index.corpus;
      corpusSize = all.length;
      const focusFiles = opts.focusFiles;

      profileSpan(
        'similar.all-count.pair-scan',
        () => {
          for (let i = 0; i < all.length; i += 1) {
            const a = all[i]!;
            const aFocused = focusFiles?.has(a.file) ?? false;
            const magnitudeA = index.weightedMagnitudes[i]!;
            const candidates = new Set<number>();
            for (const callee of a.callees) {
              const bucket = index.candidateIndexesByCallee.get(callee);
              if (!bucket) continue;
              for (const j of bucket) {
                if (j <= i) continue;
                if (focusFiles && !aFocused && !focusFiles.has(all[j]!.file)) continue;
                candidates.add(j);
              }
            }
            if (profiling) {
              candidatePairs += candidates.size;
              if (candidates.size > 0) candidateSets += 1;
            }

            for (const j of candidates) {
              const b = all[j]!;

              if (crossFileOnly && a.file === b.file) {
                if (profiling) crossFileSkips += 1;
                continue;
              }
              if (signaturePairShouldSkip(a, b)) {
                if (profiling) signatureSkips += 1;
                continue;
              }

              if (profiling) comparedPairs += 1;
              if (
                !pairPassesSimilarity(a, b, index.idfWeights, {
                  minSimilarity,
                  requireSignificantShared: 2,
                  requireSharedCount: 4,
                  medianIdf: index.medianIdf,
                  magnitudeA,
                  magnitudeB: index.weightedMagnitudes[j]!,
                })
              ) {
                continue;
              }
              insertedResults += 1;
            }
          }
        },
        () => ({
          corpusSize,
          candidateSets,
          candidatePairs,
          comparedPairs,
          crossFileSkips,
          signatureSkips,
          insertedResults,
        }),
      );

      return insertedResults;
    },
    () => ({
      minSimilarity,
      scope,
      minCallees,
      crossFileOnly,
      scanLimit,
      semantic,
      corpusSize,
      candidateSets,
      candidatePairs,
      comparedPairs,
      crossFileSkips,
      signatureSkips,
      insertedResults,
    }),
  );
}

// ── Internal helpers ───────────────────────────────────────

export interface SymbolFingerprint {
  symbol: string;
  file: string;
  callees: Set<string>;
  paramCount: number;
}

export type SourceCandidateMode = 'full' | 'target-pruned';

export interface CalleeFingerprintCorpusOptions {
  minCallees: number;
  scope?: string;
  excludeSymbol?: string;
  scanLimit?: number;
  semantic?: boolean;
}

export interface CalleeFingerprintIndexOptions {
  minCallees: number;
  scope?: string;
  scanLimit?: number;
  semantic?: boolean;
}

export interface SourceFingerprintOptions {
  scanLimit?: number;
}

export interface SourceFingerprintCandidateOptions extends SourceFingerprintOptions {
  minSimilarity: number;
  candidateMode?: SourceCandidateMode;
}

export interface SimilarityFingerprintProduct {
  calleeCorpus(opts: CalleeFingerprintCorpusOptions): SymbolFingerprint[];
  calleeIndex(opts: CalleeFingerprintIndexOptions): CalleeFingerprintIndex;
  sourceCorpus(opts?: SourceFingerprintOptions): SourceFingerprint[];
  sourceIndex(opts?: SourceFingerprintOptions): SourceFingerprintIndex;
  sourceCandidates(target: SourceFingerprint, opts: SourceFingerprintCandidateOptions): SourceFingerprint[];
}

function signaturePairShouldSkip(a: SymbolFingerprint, b: SymbolFingerprint): boolean {
  // Signature filter: a 1-arg helper and a 7-arg orchestrator that share
  // infrastructure callees aren't really "similar." If both sides have a
  // known param count, skip pairs that differ by more than 2 OR by more than
  // 50% (whichever is larger). Pairs without sig info pass through.
  if (a.paramCount < 0 || b.paramCount < 0) return false;
  const diff = Math.abs(a.paramCount - b.paramCount);
  const maxAllowed = Math.max(2, Math.ceil(Math.max(a.paramCount, b.paramCount) * 0.5));
  return diff > maxAllowed;
}

export interface CalleeFingerprintIndex {
  corpus: readonly SymbolFingerprint[];
  candidateIndexesByCallee: ReadonlyMap<string, readonly number[]>;
  docFreq: ReadonlyMap<string, number>;
  idfWeights: ReadonlyMap<string, number>;
  weightedMagnitudes: readonly number[];
  medianIdf: number;
  ubiquityThreshold: number;
}

export interface SourceFingerprint {
  symbol: string;
  file: string;
  tokens: Set<string>;
}

interface SerializedSourceFingerprintEntry {
  key: string;
  symbol: string;
  startLine: number;
  endLine: number;
  leaf: string;
  tokens: string[];
}

interface SerializedSourceFingerprintFile {
  entries: SerializedSourceFingerprintEntry[];
}

const SOURCE_FINGERPRINT_PRODUCT = createFileEvidenceProduct<Map<string, SerializedSourceFingerprintEntry>>({
  kind: 'source-fingerprints',
  invalidation: evidenceProductInvalidation('source-fingerprints'),
  serialize: serializeSourceFingerprintCache,
  deserialize: deserializeSourceFingerprintCache,
});

export interface SourceFingerprintIndex {
  corpus: readonly SourceFingerprint[];
  candidateByToken: ReadonlyMap<string, readonly SourceFingerprint[]>;
  docFreq: ReadonlyMap<string, number>;
  ubiquityThreshold: number;
}

export interface RankedSimilarResult {
  result: SimilarSymbolResult;
  order: number;
}

export function insertTopSimilarResult(
  top: RankedSimilarResult[],
  result: SimilarSymbolResult,
  limit: number,
  order: number,
): void {
  if (limit <= 0) return;
  if (top.length < limit) {
    top.push({ result, order });
    return;
  }

  let worstIndex = 0;
  for (let i = 1; i < top.length; i += 1) {
    const current = top[i]!;
    const worst = top[worstIndex]!;
    if (
      current.result.similarity < worst.result.similarity ||
      (current.result.similarity === worst.result.similarity && current.order > worst.order)
    ) {
      worstIndex = i;
    }
  }

  const worst = top[worstIndex]!;
  if (result.similarity <= worst.result.similarity) return;
  top[worstIndex] = { result, order };
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

function findCallees(db: ScipDatabase, symbolPattern: string, opts: { semantic: boolean }): SymbolFingerprint | null {
  const target = findFirstSymbolMatch(db, symbolPattern);
  if (!target) return null;
  if (!isFunctionLikeSymbol(target.symbol)) return null;

  const index = new ProjectIndex(db);
  const calleeRows = getCalleeRowsForSymbol(db, target, {
    semantic: opts.semantic,
    semanticEvidence: symbolSemanticEvidence,
  });

  return {
    symbol: target.symbol,
    file: target.relativePath,
    callees: meaningfulCallees(calleeRows.map((r) => r.symbol)),
    paramCount: index.callableSignature(target)?.paramCount ?? -1,
  };
}

// Corpus memo: building callee fingerprints walks every production callable
// (AST callsites + semantic callees) — by far the dominant cost of similar(),
// similarAll(), and incompleteMigration(). One build per (db, options) per
// process; consumers only iterate the array, never mutate it. Subscribed
// conservatively to 'definition-catalog' so any definition refinement drops
// the memo; deliberately NOT in 'source-file' — those clears release per-file
// source evidence for memory, which doesn't stale already-extracted
// fingerprints and would thrash the memo mid-scan.
const CALLEE_FINGERPRINT_CORPUS = createPerDbValue<Map<string, SymbolFingerprint[]>>('callee-fingerprint-corpus', {
  clearGroups: ['whole-project', 'definition-catalog'],
});
const CALLEE_FINGERPRINT_INDEX = createPerDbValue<Map<string, CalleeFingerprintIndex>>('callee-fingerprint-index', {
  clearGroups: ['whole-project', 'definition-catalog'],
});

export function getAllCalleeFingerprints(db: ScipDatabase, opts: CalleeFingerprintCorpusOptions): SymbolFingerprint[] {
  const { minCallees, scope, excludeSymbol, scanLimit } = opts;
  const semantic = opts.semantic !== false;
  const byOptions = CALLEE_FINGERPRINT_CORPUS.get(db, () => new Map());
  const key = `${minCallees}|${scope ?? ''}|${scanLimit ?? ''}|${semantic}`;
  let cacheHit = true;
  let corpusSize = 0;
  let excludedSymbols = 0;

  return profileSpan(
    'similar.callee-fingerprints.resolve',
    () => {
      let corpus = byOptions.get(key);
      cacheHit = corpus !== undefined;
      if (!corpus) {
        corpus = buildCalleeFingerprints(db, { minCallees, scope, scanLimit, semantic });
        byOptions.set(key, corpus);
      }
      corpusSize = corpus.length;
      // excludeSymbol stays out of the memo key: exclusion is a plain symbol skip,
      // identical whether applied during the build or as a post-filter.
      if (excludeSymbol === undefined) return corpus;
      const filtered = corpus.filter((fp) => fp.symbol !== excludeSymbol);
      excludedSymbols = corpus.length - filtered.length;
      return filtered;
    },
    () => ({
      minCallees,
      scope,
      scanLimit,
      semantic,
      cacheHit,
      corpusSize,
      excludeSymbol: excludeSymbol !== undefined,
      excludedSymbols,
    }),
  );
}

export function getCalleeFingerprintIndex(
  db: ScipDatabase,
  opts: CalleeFingerprintIndexOptions,
): CalleeFingerprintIndex {
  const { minCallees, scope, scanLimit } = opts;
  const semantic = opts.semantic !== false;
  const byOptions = CALLEE_FINGERPRINT_INDEX.get(db, () => new Map());
  const key = `${minCallees}|${scope ?? ''}|${scanLimit ?? ''}|${semantic}`;
  let cacheHit = true;
  let corpusSize = 0;
  let indexedCallees = 0;
  let candidateBuckets = 0;

  return profileSpan(
    'similar.callee-index.resolve',
    () => {
      let index = byOptions.get(key);
      cacheHit = index !== undefined;
      if (!index) {
        index = buildCalleeFingerprintIndex(
          getAllCalleeFingerprints(db, {
            minCallees,
            scope,
            scanLimit,
            semantic,
          }),
        );
        byOptions.set(key, index);
      }
      corpusSize = index.corpus.length;
      indexedCallees = index.docFreq.size;
      candidateBuckets = index.candidateIndexesByCallee.size;
      return index;
    },
    () => ({
      minCallees,
      scope,
      scanLimit,
      semantic,
      cacheHit,
      corpusSize,
      indexedCallees,
      candidateBuckets,
    }),
  );
}

export function similarityFingerprintProduct(db: ScipDatabase): SimilarityFingerprintProduct {
  return {
    calleeCorpus: (opts) => getAllCalleeFingerprints(db, opts),
    calleeIndex: (opts) => getCalleeFingerprintIndex(db, opts),
    sourceCorpus: (opts = {}) => getAllSourceFingerprints(db, opts),
    sourceIndex: (opts = {}) => getSourceFingerprintIndex(db, opts),
    sourceCandidates: (target, opts) =>
      (opts.candidateMode ?? 'full') === 'target-pruned'
        ? targetPrunedSourceCandidatesForTarget(db, target, {
            minSimilarity: opts.minSimilarity,
            scanLimit: opts.scanLimit,
          })
        : sourceCandidatesFromIndex(target, getSourceFingerprintIndex(db, { scanLimit: opts.scanLimit })),
  };
}

export function buildCalleeFingerprintIndex(corpus: readonly SymbolFingerprint[]): CalleeFingerprintIndex {
  const profiling = profileEnabled();
  let uniqueCallees = 0;
  const docFreq = profileSpan(
    'similar.callee-index.doc-frequency',
    () => {
      const frequencies = new Map<string, number>();
      for (const fp of corpus) {
        for (const callee of fp.callees) frequencies.set(callee, (frequencies.get(callee) ?? 0) + 1);
      }
      uniqueCallees = frequencies.size;
      return frequencies;
    },
    () => ({ corpusSize: corpus.length, uniqueCallees }),
  );

  const ubiquityThreshold = Math.max(8, Math.ceil(Math.sqrt(corpus.length)));
  const idfWeights = profileSpan(
    'similar.callee-index.idf-weights',
    () => computeIdfFromDocFreq(docFreq, corpus.length),
    () => ({ corpusSize: corpus.length, uniqueCallees: docFreq.size }),
  );
  const weightedMagnitudes = profileSpan(
    'similar.callee-index.weighted-magnitudes',
    () => corpus.map((fp) => weightedMagnitude(fp.callees, idfWeights)),
    () => ({ corpusSize: corpus.length }),
  );
  let candidateRefs = 0;
  let ubiquitousSkips = 0;
  let candidateBuckets = 0;
  const candidateIndexesByCallee = profileSpan(
    'similar.callee-index.candidate-buckets',
    () => {
      const buckets = new Map<string, number[]>();
      for (let index = 0; index < corpus.length; index += 1) {
        const fp = corpus[index]!;
        for (const callee of fp.callees) {
          if ((docFreq.get(callee) ?? 0) > ubiquityThreshold) {
            if (profiling) ubiquitousSkips += 1;
            continue;
          }
          let bucket = buckets.get(callee);
          if (!bucket) {
            bucket = [];
            buckets.set(callee, bucket);
          }
          bucket.push(index);
          if (profiling) candidateRefs += 1;
        }
      }
      if (profiling) candidateBuckets = buckets.size;
      return buckets;
    },
    () => ({
      corpusSize: corpus.length,
      buckets: candidateBuckets,
      candidateRefs,
      ubiquitousSkips,
      ubiquityThreshold,
    }),
  );
  const medianIdf = profileSpan(
    'similar.callee-index.median-idf',
    () => getMedianIdf(idfWeights),
    () => ({ uniqueCallees: idfWeights.size }),
  );

  return {
    corpus,
    candidateIndexesByCallee,
    docFreq,
    idfWeights,
    weightedMagnitudes,
    medianIdf,
    ubiquityThreshold,
  };
}

export function candidateFingerprintsForTarget(
  target: SymbolFingerprint,
  index: CalleeFingerprintIndex,
): SymbolFingerprint[] {
  const candidates = new Map<string, SymbolFingerprint>();
  for (const callee of target.callees) {
    for (const candidateIndex of index.candidateIndexesByCallee.get(callee) ?? []) {
      const candidate = index.corpus[candidateIndex]!;
      if (candidate.symbol === target.symbol) continue;
      candidates.set(candidate.symbol, candidate);
    }
  }

  if (candidates.size > 0) return [...candidates.values()];
  return index.corpus.filter((fp) => fp.symbol !== target.symbol);
}

// scip-query: ignore-extract — this builds callee-set fingerprints for
// similarity; callable selection, signature lookup, callee filtering, and
// fingerprint shaping are one evidence pass.
function buildCalleeFingerprints(
  db: ScipDatabase,
  opts: { minCallees: number; scope?: string; scanLimit?: number; semantic: boolean },
): SymbolFingerprint[] {
  const { minCallees, scope, scanLimit, semantic } = opts;
  const profiling = profileEnabled();
  const index = new ProjectIndex(db);

  let candidateCount = 0;
  const candidates = profileSpan(
    'similar.callee-fingerprints.candidates',
    () => {
      const rows = applyScanLimit(
        index.productionCallableDefinitions({
          scope,
          minLoc: 5,
          sortByLocDesc: typeof scanLimit === 'number' && scanLimit > 0,
        }),
        scanLimit,
      );
      candidateCount = rows.length;
      return rows;
    },
    () => ({ scope, scanLimit, candidateCount }),
  );
  let calleeEdges = 0;
  const calleeMap = profileSpan(
    'similar.callee-fingerprints.callee-map',
    () => {
      const map = index.calleeMap(candidates, { semantic });
      if (profiling) {
        for (const callees of map.values()) calleeEdges += callees.length;
      }
      return map;
    },
    () => ({ candidateCount, semantic, calleeEdges }),
  );
  let fingerprintCount = 0;
  let retainedCalleeCount = 0;
  let siblingSaturatedFingerprints = 0;

  return profileSpan(
    'similar.callee-fingerprints.shape',
    () => {
      const rawFingerprints = candidates.map((d) => ({
        symbol: d.symbol,
        file: d.relativePath,
        callees: meaningfulCallees((calleeMap.get(d.symbolId) ?? []).map((c) => c.symbol)),
        paramCount: index.callableSignature(d)?.paramCount ?? -1,
      }));
      const trimmed = trimSameFileSiblingSaturatedCallees(rawFingerprints);
      if (profiling) {
        siblingSaturatedFingerprints = trimmed.filter(
          (fp, i) => fp.callees.size !== rawFingerprints[i]!.callees.size,
        ).length;
      }
      const fingerprints = trimmed.filter((fp) => fp.callees.size >= minCallees);
      fingerprintCount = fingerprints.length;
      if (profiling) retainedCalleeCount = fingerprints.reduce((sum, fp) => sum + fp.callees.size, 0);
      return fingerprints;
    },
    () => ({ candidateCount, fingerprintCount, retainedCalleeCount, minCallees, siblingSaturatedFingerprints }),
  );
}

// A callee shared by many *same-file siblings* is a generic same-file helper
// vocabulary (e.g. a shared test-fixture builder every scenario in the file
// calls), not evidence that two specific siblings are conceptually related —
// unlike ubiquity across the whole corpus (handled by IDF weighting below),
// same-file ubiquity isn't visible to a corpus-wide document-frequency
// weight when the helper is only ever called from within that one file
// (external calibration: Vega, `similar` — fuzzMultipartRawAndSse vs.
// fuzzSecondaryApi scored 1.0 on 4 shared generic same-file helpers).
// Constraint: a callee called by >= this many distinct same-file siblings is
// dropped from every fingerprint in that file before corpus IDF weighting
// ever sees it, so it cannot contribute to any pair's similarity score
// regardless of how rare it looks globally.
export const SAME_FILE_SIBLING_SATURATION_THRESHOLD = 5;

// Exported for direct, DB-free unit testing of the trimming rule itself —
// buildCalleeFingerprintIndex takes an already-built corpus and has no
// reason to re-derive same-file sibling counts from it.
export function trimSameFileSiblingSaturatedCallees(fingerprints: readonly SymbolFingerprint[]): SymbolFingerprint[] {
  const calleeCountsByFile = new Map<string, Map<string, number>>();
  for (const fp of fingerprints) {
    let calleeCounts = calleeCountsByFile.get(fp.file);
    if (!calleeCounts) {
      calleeCounts = new Map();
      calleeCountsByFile.set(fp.file, calleeCounts);
    }
    for (const callee of fp.callees) calleeCounts.set(callee, (calleeCounts.get(callee) ?? 0) + 1);
  }

  return fingerprints.map((fp) => {
    const calleeCounts = calleeCountsByFile.get(fp.file);
    if (!calleeCounts) return fp;
    const saturated = [...fp.callees].filter(
      (callee) => (calleeCounts.get(callee) ?? 0) >= SAME_FILE_SIBLING_SATURATION_THRESHOLD,
    );
    if (saturated.length === 0) return fp;
    const trimmedCallees = new Set(fp.callees);
    for (const callee of saturated) trimmedCallees.delete(callee);
    return { ...fp, callees: trimmedCallees };
  });
}

/**
 * Same rule as `trimSameFileSiblingSaturatedCallees`, applied to a single
 * ad hoc target fingerprint (the `similar <symbol>` single-lookup path)
 * against the already-built corpus, instead of rebuilding a whole extra
 * corpus just to trim one fingerprint.
 */
function trimTargetSameFileSiblingSaturatedCallees(
  target: SymbolFingerprint,
  corpus: readonly SymbolFingerprint[],
): SymbolFingerprint {
  const calleeCounts = new Map<string, number>();
  for (const fp of corpus) {
    if (fp.file !== target.file || fp.symbol === target.symbol) continue;
    for (const callee of fp.callees) calleeCounts.set(callee, (calleeCounts.get(callee) ?? 0) + 1);
  }
  // +1 counts the target itself as one of the same-file callers of its own callees.
  const saturated = [...target.callees].filter(
    (callee) => (calleeCounts.get(callee) ?? 0) + 1 >= SAME_FILE_SIBLING_SATURATION_THRESHOLD,
  );
  if (saturated.length === 0) return target;
  const callees = new Set(target.callees);
  for (const callee of saturated) callees.delete(callee);
  return { ...target, callees };
}

export function meaningfulCallees(callees: Iterable<string>): Set<string> {
  return new Set([...callees].filter((callee) => !isInfrastructureCallee(callee)));
}

function isInfrastructureCallee(callee: string): boolean {
  return INFRASTRUCTURE_CALLEE_FRAGMENTS.some((fragment) => callee.includes(fragment));
}

function similarBySourceShape(
  db: ScipDatabase,
  symbolPattern: string,
  opts: { minSimilarity: number; limit: number; scanLimit?: number; candidateMode?: SourceCandidateMode },
): SimilarSymbolResult[] {
  const target = findSourceFingerprint(db, symbolPattern);
  if (!target || target.tokens.size < 3) {
    return [];
  }

  const minSimilarity = opts.minSimilarity >= 0.5 ? opts.minSimilarity : 0.3;
  const results: SimilarSymbolResult[] = [];
  const candidateMode = opts.candidateMode ?? 'full';
  let candidateCount = 0;
  let comparedPairs = 0;
  let sharedSkips = 0;
  let similaritySkips = 0;

  return profileSpan(
    'similar.source-shape',
    () => {
      const fingerprints = similarityFingerprintProduct(db);
      const candidates = fingerprints.sourceCandidates(target, {
        minSimilarity,
        scanLimit: opts.scanLimit,
        candidateMode,
      });
      candidateCount = candidates.length;

      for (const candidate of candidates) {
        if (candidate.symbol === target.symbol || candidate.tokens.size < 3) continue;
        comparedPairs += 1;

        const shared = intersection(target.tokens, candidate.tokens);
        if (shared.size < 2) {
          sharedSkips += 1;
          continue;
        }

        const union = new Set([...target.tokens, ...candidate.tokens]);
        const similarity = union.size > 0 ? shared.size / union.size : 0;
        if (similarity < minSimilarity) {
          similaritySkips += 1;
          continue;
        }

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
          ...classifySimilarityEvidence([...shared], 'source-tokens'),
        });
      }

      results.sort((a, b) => b.similarity - a.similarity || a.shortNameB.localeCompare(b.shortNameB));
      return results.slice(0, opts.limit);
    },
    () => ({
      symbol: target.symbol,
      file: target.file,
      targetTokens: target.tokens.size,
      candidateMode,
      candidates: candidateCount,
      comparedPairs,
      sharedSkips,
      similaritySkips,
      results: results.length,
    }),
  );
}

export function classifySimilarityEvidence(
  sharedEvidence: readonly string[],
  basis: NonNullable<SimilarSymbolResult['similarityBasis']>,
): SimilarEvidenceClassification {
  const tokens = sharedEvidence.flatMap(similarityEvidenceTokens);
  const domainTokens = sharedEvidence.flatMap((value) => domainEvidenceTokens(value, basis));
  const accessHits = matchingTokens(tokens, ACCESS_QUERY_SCAFFOLDING_TOKENS);
  const frameworkHits = matchingTokens(tokens, FRAMEWORK_SCAFFOLDING_TOKENS);
  const domainHits = matchingTokens(domainTokens, DOMAIN_BEHAVIOR_TOKENS);
  const concreteDomainTerms = [...new Set(domainTokens.filter(isConcreteDomainEvidenceToken))];
  const domainEvidenceCount = sharedEvidence.filter((value) => {
    const evidenceTokens = domainEvidenceTokens(value, basis);
    return (
      evidenceTokens.some((token) => DOMAIN_BEHAVIOR_TOKENS.has(token)) &&
      evidenceTokens.some(isConcreteDomainEvidenceToken)
    );
  }).length;
  const reasons: string[] = [];

  if (accessHits.length > 0) reasons.push(`access/query scaffolding: ${accessHits.slice(0, 5).join(', ')}`);
  if (frameworkHits.length > 0) reasons.push(`framework/generic scaffolding: ${frameworkHits.slice(0, 5).join(', ')}`);
  if (domainHits.length > 0) reasons.push(`domain behavior verbs: ${domainHits.slice(0, 5).join(', ')}`);
  if (domainHits.length > 0 && concreteDomainTerms.length > 0) {
    reasons.push(`domain-specific terms: ${concreteDomainTerms.slice(0, 5).join(', ')}`);
  }
  const genericSourceTokenOverlap =
    basis === 'source-tokens' && tokens.length > 0 && tokens.every((token) => GENERIC_SOURCE_TOKEN_EVIDENCE.has(token));
  if (genericSourceTokenOverlap) {
    reasons.push('shared source tokens are generic scaffolding');
  }

  const hasDomainBehavior = domainHits.length > 0 && concreteDomainTerms.length > 0;
  const hasScaffolding = accessHits.length + frameworkHits.length > 0;
  const strongDomainBehavior =
    basis === 'callees' &&
    hasDomainBehavior &&
    sharedEvidence.length >= 4 &&
    concreteDomainTerms.length >= 4 &&
    domainEvidenceCount >= 2;
  const evidenceClass: SimilarEvidenceClass = strongDomainBehavior
    ? 'domain-behavior'
    : hasDomainBehavior
      ? hasScaffolding
        ? 'mixed'
        : 'domain-behavior'
      : accessHits.length > 0
        ? 'access-query-scaffolding'
        : frameworkHits.length > 0 || genericSourceTokenOverlap
          ? 'framework-scaffolding'
          : 'structural-overlap';
  if (evidenceClass === 'structural-overlap' && sharedEvidence.length > 0) {
    reasons.push(`shared ${basis} overlap has no recognized domain or scaffolding category`);
  }
  const actionTier: SimilarActionTier =
    evidenceClass === 'domain-behavior' && (sharedEvidence.length >= 3 || strongDomainBehavior) ? 'direct' : 'signal';
  return {
    evidenceClass,
    actionTier,
    evidenceClassReasons: reasons,
    recommendation: similarityRecommendation(evidenceClass, actionTier),
  };
}

function similarityRecommendation(evidenceClass: SimilarEvidenceClass, actionTier: SimilarActionTier): string {
  if (actionTier === 'direct') {
    return 'Shared domain behavior looks concrete; review for an extract/reuse opportunity.';
  }
  if (evidenceClass === 'mixed') {
    return 'Shared evidence mixes domain behavior with scaffolding; review semantics before extracting anything.';
  }
  if (evidenceClass === 'access-query-scaffolding') {
    return 'Shared evidence is mostly access/query scaffolding; compare product semantics before reusing code.';
  }
  if (evidenceClass === 'structural-overlap') {
    return 'Shared structure has no domain or scaffolding classification; inspect names and behavior before reusing code.';
  }
  return 'Shared evidence is mostly framework or generic scaffolding; treat as a contextual signal.';
}

function matchingTokens(tokens: readonly string[], dictionary: ReadonlySet<string>): string[] {
  return [...new Set(tokens.filter((token) => dictionary.has(token)))];
}

function similarityEvidenceTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

function domainEvidenceTokens(value: string, basis: NonNullable<SimilarSymbolResult['similarityBasis']>): string[] {
  if (basis === 'source-tokens') return similarityEvidenceTokens(value);
  const parsedLeaf = leafName(value);
  return similarityEvidenceTokens(parsedLeaf.length > 0 ? parsedLeaf : fallbackEvidenceLeaf(value));
}

function fallbackEvidenceLeaf(value: string): string {
  const normalized = value.replace(/[()`]/g, ' ').replace(/\.[a-z][a-z0-9]+(?=\s|$)/gi, ' ');
  const segments = normalized
    .split(/[:/\\\s]+/)
    .map((segment) => segment.trim())
    .filter((segment) => /[A-Za-z]/.test(segment));
  return segments.at(-1)?.replace(/\.$/, '') ?? value;
}

function isConcreteDomainEvidenceToken(token: string): boolean {
  return (
    token.length > 3 &&
    !DOMAIN_BEHAVIOR_TOKENS.has(token) &&
    !ACCESS_QUERY_SCAFFOLDING_TOKENS.has(token) &&
    !FRAMEWORK_SCAFFOLDING_TOKENS.has(token) &&
    !GENERIC_SOURCE_TOKEN_EVIDENCE.has(token) &&
    !NON_DOMAIN_CONTEXT_TOKENS.has(token)
  );
}

const DOMAIN_BEHAVIOR_TOKENS = new Set([
  'archive',
  'assign',
  'book',
  'cancel',
  'create',
  'delete',
  'ensure',
  'export',
  'import',
  'notify',
  'persist',
  'publish',
  'restore',
  'schedule',
  'send',
  'set',
  'submit',
  'sync',
  'update',
  'upload',
  'validate',
  'write',
]);

const ACCESS_QUERY_SCAFFOLDING_TOKENS = new Set([
  'access',
  'auth',
  'authorize',
  'cache',
  'context',
  'db',
  'find',
  'get',
  'guard',
  'list',
  'permission',
  'permissions',
  'prisma',
  'query',
  'request',
  'response',
  'role',
  'route',
  'session',
  'sql',
  'where',
]);

const FRAMEWORK_SCAFFOLDING_TOKENS = new Set([
  'bytes',
  'computed',
  'crypto',
  'describe',
  'effect',
  'expect',
  'fetch',
  'filter',
  'hex',
  'hook',
  'json',
  'map',
  'mounted',
  'on',
  'promise',
  'random',
  'react',
  'reduce',
  'ref',
  'render',
  'state',
  'test',
  'token',
  'trim',
  'uuid',
  'vue',
  'watch',
]);

const GENERIC_SOURCE_TOKEN_EVIDENCE = new Set([
  'bytes',
  'crypto',
  'data',
  'false',
  'get',
  'hex',
  'id',
  'key',
  'map',
  'name',
  'num',
  'random',
  'result',
  'secret',
  'set',
  'string',
  'to',
  'token',
  'true',
  'type',
  'value',
]);

const NON_DOMAIN_CONTEXT_TOKENS = new Set([
  'best',
  'backend',
  'conflict',
  'database',
  'effect',
  'effects',
  'error',
  'errors',
  'frontend',
  'found',
  'helpers',
  'javascript',
  'module',
  'modules',
  'scip',
  'shared',
  'source',
  'typescript',
  'utils',
  'with',
  'workflow',
  'workflows',
]);

function findSourceFingerprint(db: ScipDatabase, symbolPattern: string): SourceFingerprint | null {
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

// Same memo rationale (and group membership) as CALLEE_FINGERPRINT_CORPUS:
// the lexical fallback corpus tokenizes every production callable's source.
const SOURCE_FINGERPRINT_CORPUS = createPerDbValue<Map<string, SourceFingerprint[]>>('source-fingerprint-corpus', {
  clearGroups: ['whole-project', 'definition-catalog'],
});
const SOURCE_FINGERPRINT_INDEX = createPerDbValue<Map<string, SourceFingerprintIndex>>('source-fingerprint-index', {
  clearGroups: ['whole-project', 'definition-catalog'],
});

function sourceFingerprintCacheKey(opts: { scanLimit?: number }): string {
  return `${opts.scanLimit ?? ''}`;
}

function getAllSourceFingerprints(db: ScipDatabase, opts: { scanLimit?: number } = {}): SourceFingerprint[] {
  const byOptions = SOURCE_FINGERPRINT_CORPUS.get(db, () => new Map());
  const key = sourceFingerprintCacheKey(opts);
  let corpus = byOptions.get(key);
  if (!corpus) {
    corpus = buildSourceFingerprints(db, opts);
    byOptions.set(key, corpus);
  }
  return corpus;
}

function getSourceFingerprintIndex(db: ScipDatabase, opts: { scanLimit?: number } = {}): SourceFingerprintIndex {
  const byOptions = SOURCE_FINGERPRINT_INDEX.get(db, () => new Map());
  const key = sourceFingerprintCacheKey(opts);
  let index = byOptions.get(key);
  if (!index) {
    index = buildSourceFingerprintIndex(getAllSourceFingerprints(db, opts));
    byOptions.set(key, index);
  }
  return index;
}

function buildSourceFingerprintIndex(corpus: readonly SourceFingerprint[]): SourceFingerprintIndex {
  const docFreq = new Map<string, number>();
  for (const fingerprint of corpus) {
    for (const token of fingerprint.tokens) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
  }

  const ubiquityThreshold = Math.max(8, Math.ceil(Math.sqrt(corpus.length)));
  const candidateByToken = new Map<string, SourceFingerprint[]>();
  for (const fingerprint of corpus) {
    for (const token of fingerprint.tokens) {
      if ((docFreq.get(token) ?? 0) > ubiquityThreshold) continue;
      let bucket = candidateByToken.get(token);
      if (!bucket) {
        bucket = [];
        candidateByToken.set(token, bucket);
      }
      bucket.push(fingerprint);
    }
  }

  return { corpus, candidateByToken, docFreq, ubiquityThreshold };
}

function sourceCandidatesFromIndex(target: SourceFingerprint, index: SourceFingerprintIndex): SourceFingerprint[] {
  const candidates = new Map<string, SourceFingerprint>();
  for (const token of target.tokens) {
    for (const candidate of index.candidateByToken.get(token) ?? []) {
      if (candidate.symbol === target.symbol) continue;
      candidates.set(candidate.symbol, candidate);
    }
  }

  if (candidates.size > 0) return [...candidates.values()];
  return index.corpus.filter((fingerprint) => fingerprint.symbol !== target.symbol);
}

function targetPrunedSourceCandidatesForTarget(
  db: ScipDatabase,
  target: SourceFingerprint,
  opts: { minSimilarity: number; scanLimit?: number },
): SourceFingerprint[] {
  const profiling = profileEnabled();
  const index = new ProjectIndex(db);
  const requiredSharedTokens = requiredSharedSourceTokens(target.tokens.size, opts.minSimilarity);
  let scannedFiles = 0;
  let readableFiles = 0;
  let candidateFiles = 0;
  const files = profileSpan(
    'similar.source-shape.target-files',
    () => {
      const targetTokens = [...target.tokens];
      const matches: string[] = [];
      for (const relativePath of indexedDocumentPaths(db, { includeIgnored: false })) {
        scannedFiles += 1;
        const source = getSourceText(db, relativePath);
        if (!source) continue;
        readableFiles += 1;
        if (sourceContainsAtLeastTokens(source, targetTokens, requiredSharedTokens)) matches.push(relativePath);
      }
      candidateFiles = matches.length;
      return matches;
    },
    () => ({
      symbol: target.symbol,
      targetTokens: target.tokens.size,
      requiredSharedTokens,
      scannedFiles,
      readableFiles,
      candidateFiles,
    }),
  );

  let definitionCount = 0;
  const definitions = profileSpan(
    'similar.source-shape.target-definitions',
    () => {
      const rows = applyScanLimit(
        index.productionCallableDefinitions({
          files,
          sortByLocDesc: typeof opts.scanLimit === 'number' && opts.scanLimit > 0,
        }),
        opts.scanLimit,
      );
      definitionCount = rows.length;
      return rows;
    },
    () => ({ symbol: target.symbol, candidateFiles, scanLimit: opts.scanLimit, definitionCount }),
  );

  let fingerprintCount = 0;
  const fingerprints = profileSpan(
    'similar.source-shape.target-fingerprints',
    () => {
      const rows = sourceFingerprintsForDefinitions(db, definitions);
      if (profiling) fingerprintCount = rows.length;
      return rows;
    },
    () => ({ symbol: target.symbol, definitionCount, fingerprintCount }),
  );

  return fingerprints.filter((fingerprint) => fingerprint.symbol !== target.symbol);
}

function requiredSharedSourceTokens(targetTokenCount: number, minSimilarity: number): number {
  return Math.max(2, Math.ceil(targetTokenCount * minSimilarity));
}

function sourceContainsAtLeastTokens(source: string, tokens: readonly string[], minMatches: number): boolean {
  if (tokens.length < minMatches) return false;
  const normalized = source.toLowerCase();
  let matches = 0;
  for (const token of tokens) {
    if (sourceContainsToken(normalized, token)) {
      matches += 1;
      if (matches >= minMatches) return true;
    }
  }
  return false;
}

function sourceContainsToken(normalizedSource: string, token: string): boolean {
  if (token === 'num') return /\b\d+\b/.test(normalizedSource);
  return normalizedSource.includes(token);
}

// scip-query: ignore-extract — this builds source-token fingerprints; scoped
// definitions, file-kind filtering, snippets, and token extraction are one
// text-similarity pass.
function buildSourceFingerprints(db: ScipDatabase, opts: { scanLimit?: number } = {}): SourceFingerprint[] {
  const index = new ProjectIndex(db);
  const { scanLimit } = opts;
  // The shared production gate owns candidate policy (tests, rust test
  // modules, ignored paths, suppression comments) — no local re-filtering.
  const definitions = applyScanLimit(
    index.productionCallableDefinitions({
      sortByLocDesc: typeof scanLimit === 'number' && scanLimit > 0,
    }),
    scanLimit,
  );
  return sourceFingerprintsForDefinitions(db, definitions);
}

function sourceFingerprintsForDefinitions(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
): SourceFingerprint[] {
  const definitionsByFile = new Map<string, IndexedDefinition[]>();
  for (const definition of definitions) {
    const bucket = definitionsByFile.get(definition.relativePath) ?? [];
    bucket.push(definition);
    definitionsByFile.set(definition.relativePath, bucket);
  }

  const bySymbol = new Map<string, SourceFingerprint>();
  for (const [relativePath, fileDefinitions] of definitionsByFile) {
    const source = getSourceText(db, relativePath);
    if (!source) continue;
    const contentHash = fileContentHash(db, relativePath, source);
    const cachedEntries = readSourceFingerprintCache(db, relativePath, contentHash);
    let changed = false;
    let lines: readonly string[] | null = null;

    for (const definition of fileDefinitions) {
      const key = sourceFingerprintDefinitionKey(definition);
      const cached = cachedEntries.get(key);
      let tokens = cached ? new Set(cached.tokens) : null;
      if (!tokens) {
        lines ??= getSourceLines(db, relativePath);
        tokens = sourceTokens(
          definitionSnippetFromLines(lines, definition.startLine, definition.endLine, definition.leaf),
          definition.leaf,
        );
        cachedEntries.set(key, {
          key,
          symbol: definition.symbol,
          startLine: definition.startLine,
          endLine: definition.endLine,
          leaf: definition.leaf,
          tokens: [...tokens].sort(),
        });
        changed = true;
      }
      if (tokens.size > 0) {
        bySymbol.set(definition.symbol, {
          symbol: definition.symbol,
          file: definition.relativePath,
          tokens,
        });
      }
    }

    if (changed) writeSourceFingerprintCache(db, relativePath, contentHash, cachedEntries);
  }

  return definitions.map((definition) => bySymbol.get(definition.symbol)).filter((fp): fp is SourceFingerprint => !!fp);
}

function definitionSnippet(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
  leaf: string,
): string {
  const lines = getSourceLines(db, relativePath);
  if (lines.length === 0) {
    return '';
  }

  return definitionSnippetFromLines(lines, startLine, endLine, leaf);
}

function definitionSnippetFromLines(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  leaf: string,
): string {
  if (endLine >= startLine && endLine - startLine <= 12) {
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

function sourceFingerprintDefinitionKey(definition: IndexedDefinition): string {
  return `${definition.symbol}\0${definition.startLine}\0${definition.endLine}\0${definition.leaf}`;
}

function readSourceFingerprintCache(
  db: ScipDatabase,
  relativePath: string,
  contentHash: string,
): Map<string, SerializedSourceFingerprintEntry> {
  return SOURCE_FINGERPRINT_PRODUCT.read(db, relativePath, contentHash) ?? new Map();
}

function deserializeSourceFingerprintCache(payload: string): Map<string, SerializedSourceFingerprintEntry> | null {
  try {
    const parsed = JSON.parse(payload) as SerializedSourceFingerprintFile;
    if (!Array.isArray(parsed.entries)) return null;
    const entries = new Map<string, SerializedSourceFingerprintEntry>();
    for (const entry of parsed.entries) {
      if (
        !entry ||
        typeof entry.key !== 'string' ||
        typeof entry.symbol !== 'string' ||
        typeof entry.startLine !== 'number' ||
        typeof entry.endLine !== 'number' ||
        typeof entry.leaf !== 'string' ||
        !Array.isArray(entry.tokens) ||
        !entry.tokens.every((token) => typeof token === 'string')
      ) {
        return null;
      }
      entries.set(entry.key, entry);
    }
    return entries;
  } catch {
    return null;
  }
}

function serializeSourceFingerprintCache(entries: ReadonlyMap<string, SerializedSourceFingerprintEntry>): string {
  const payload: SerializedSourceFingerprintFile = {
    entries: [...entries.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
  return JSON.stringify(payload);
}

function writeSourceFingerprintCache(
  db: ScipDatabase,
  relativePath: string,
  contentHash: string,
  entries: ReadonlyMap<string, SerializedSourceFingerprintEntry>,
): void {
  SOURCE_FINGERPRINT_PRODUCT.write(db, relativePath, contentHash, new Map(entries));
}

function sourceTokens(snippet: string, leaf: string): Set<string> {
  if (!snippet) {
    return new Set();
  }

  const stopWords = new Set([
    'public',
    'private',
    'protected',
    'final',
    'static',
    'class',
    'def',
    'fun',
    'fn',
    'function',
    'return',
    'string',
    'bool',
    'boolean',
    'void',
    'unit',
    'self',
    'this',
    'new',
    'const',
    'let',
    'var',
    'end',
    'pub',
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
