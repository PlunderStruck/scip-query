import type { ScipDatabase } from '../../storage/db.js';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { getCalleeRowsForSymbol } from '../../symbols/graph/call-graph-evidence.js';
import { getSourceLines } from '../../source/source-text.js';
import { computeIdf, difference, intersection, weightedCosine } from '../../analysis/similarity.js';
import { isFunctionLikeSymbol, leafName, shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../../core/project-index.js';
import { createPerDbValue } from '../../storage/per-db-cache.js';
import { applyScanLimit } from '../query-utils.js';

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
  opts: { minSimilarity?: number; limit?: number; scanLimit?: number; semantic?: boolean } = {},
): SimilarSymbolResult[] {
  const { minSimilarity = 0.4, limit = 20 } = opts;

  const target = findCallees(db, symbolPattern, { semantic: opts.semantic !== false });
  if (!target) return [];
  if (!isFunctionLikeSymbol(target.symbol)) return [];

  const results = compareAgainstFingerprints(db, target, minSimilarity, {
    scanLimit: opts.scanLimit,
    semantic: opts.semantic !== false,
  });
  if (results.length > 0) return results.slice(0, limit);
  return similarBySourceShape(db, symbolPattern, { minSimilarity, limit });
}

function compareAgainstFingerprints(
  db: ScipDatabase,
  target: SymbolFingerprint,
  minSimilarity: number,
  opts: { scanLimit?: number; semantic: boolean },
): SimilarSymbolResult[] {
  const index = getCalleeFingerprintIndex(db, {
    minCallees: 3,
    scanLimit: opts.scanLimit,
    semantic: opts.semantic,
  });
  const candidates = candidateFingerprintsForTarget(target, index);
  const idfWeights = computeIdf([target, ...index.corpus].map((fp) => fp.callees));

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

  const displayShared = significantShared.length > 0 ? significantShared : [...intersection(a.callees, b.callees)];
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
      if (!bucket) {
        bucket = [];
        calleeIndex.set(callee, bucket);
      }
      bucket.push(i);
    }
  }

  const topResults: RankedSimilarResult[] = [];
  let resultOrder = 0;
  const seenPair = new Set<string>();

  for (let i = 0; i < all.length; i += 1) {
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
      insertTopSimilarResult(topResults, result, limit, resultOrder);
      resultOrder += 1;
    }
  }

  topResults.sort((a, b) => b.result.similarity - a.result.similarity || a.order - b.order);
  return topResults.map((entry) => entry.result);
}

// ── Internal helpers ───────────────────────────────────────

export interface SymbolFingerprint {
  symbol: string;
  file: string;
  callees: Set<string>;
  paramCount: number;
}

export interface CalleeFingerprintIndex {
  corpus: readonly SymbolFingerprint[];
  candidateByCallee: ReadonlyMap<string, readonly SymbolFingerprint[]>;
  docFreq: ReadonlyMap<string, number>;
  ubiquityThreshold: number;
}

interface SourceFingerprint {
  symbol: string;
  file: string;
  tokens: Set<string>;
}

interface SourceFingerprintIndex {
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
  const index = new ProjectIndex(db);

  if (!target) return null;

  const calleeRows = getCalleeRowsForSymbol(db, target, { semantic: opts.semantic });

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

export function getAllCalleeFingerprints(
  db: ScipDatabase,
  opts: { minCallees: number; scope?: string; excludeSymbol?: string; scanLimit?: number; semantic?: boolean },
): SymbolFingerprint[] {
  const { minCallees, scope, excludeSymbol, scanLimit } = opts;
  const semantic = opts.semantic !== false;
  const byOptions = CALLEE_FINGERPRINT_CORPUS.get(db, () => new Map());
  const key = `${minCallees}|${scope ?? ''}|${scanLimit ?? ''}|${semantic}`;
  let corpus = byOptions.get(key);
  if (!corpus) {
    corpus = buildCalleeFingerprints(db, { minCallees, scope, scanLimit, semantic });
    byOptions.set(key, corpus);
  }
  // excludeSymbol stays out of the memo key: exclusion is a plain symbol skip,
  // identical whether applied during the build or as a post-filter.
  return excludeSymbol === undefined ? corpus : corpus.filter((fp) => fp.symbol !== excludeSymbol);
}

function getCalleeFingerprintIndex(
  db: ScipDatabase,
  opts: { minCallees: number; scope?: string; scanLimit?: number; semantic?: boolean },
): CalleeFingerprintIndex {
  const { minCallees, scope, scanLimit } = opts;
  const semantic = opts.semantic !== false;
  const byOptions = CALLEE_FINGERPRINT_INDEX.get(db, () => new Map());
  const key = `${minCallees}|${scope ?? ''}|${scanLimit ?? ''}|${semantic}`;
  let index = byOptions.get(key);
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
  return index;
}

export function buildCalleeFingerprintIndex(corpus: readonly SymbolFingerprint[]): CalleeFingerprintIndex {
  const docFreq = new Map<string, number>();
  for (const fp of corpus) for (const callee of fp.callees) docFreq.set(callee, (docFreq.get(callee) ?? 0) + 1);

  const ubiquityThreshold = Math.max(8, Math.ceil(Math.sqrt(corpus.length)));
  const candidateByCallee = new Map<string, SymbolFingerprint[]>();
  for (const fp of corpus) {
    for (const callee of fp.callees) {
      if ((docFreq.get(callee) ?? 0) > ubiquityThreshold) continue;
      let bucket = candidateByCallee.get(callee);
      if (!bucket) {
        bucket = [];
        candidateByCallee.set(callee, bucket);
      }
      bucket.push(fp);
    }
  }

  return { corpus, candidateByCallee, docFreq, ubiquityThreshold };
}

export function candidateFingerprintsForTarget(
  target: SymbolFingerprint,
  index: CalleeFingerprintIndex,
): SymbolFingerprint[] {
  const candidates = new Map<string, SymbolFingerprint>();
  for (const callee of target.callees) {
    for (const candidate of index.candidateByCallee.get(callee) ?? []) {
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
  const index = new ProjectIndex(db);

  const candidates = applyScanLimit(
    index.productionCallableDefinitions({
      scope,
      minLoc: 5,
      sortByLocDesc: typeof scanLimit === 'number' && scanLimit > 0,
    }),
    scanLimit,
  );
  const calleeMap = index.calleeMap(candidates, { semantic });

  return candidates
    .map((d) => ({
      symbol: d.symbol,
      file: d.relativePath,
      callees: meaningfulCallees((calleeMap.get(d.symbolId) ?? []).map((c) => c.symbol)),
      paramCount: index.callableSignature(d)?.paramCount ?? -1,
    }))
    .filter((fp) => fp.callees.size >= minCallees);
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
  opts: { minSimilarity: number; limit: number },
): SimilarSymbolResult[] {
  const target = findSourceFingerprint(db, symbolPattern);
  if (!target || target.tokens.size < 3) {
    return [];
  }

  const minSimilarity = opts.minSimilarity >= 0.5 ? opts.minSimilarity : 0.3;
  const results: SimilarSymbolResult[] = [];
  const candidates = sourceCandidatesForTarget(target, getSourceFingerprintIndex(db));

  for (const candidate of candidates) {
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
      ...classifySimilarityEvidence([...shared], 'source-tokens'),
    });
  }

  results.sort((a, b) => b.similarity - a.similarity || a.shortNameB.localeCompare(b.shortNameB));
  return results.slice(0, opts.limit);
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
const SOURCE_FINGERPRINT_CORPUS = createPerDbValue<SourceFingerprint[]>('source-fingerprint-corpus', {
  clearGroups: ['whole-project', 'definition-catalog'],
});
const SOURCE_FINGERPRINT_INDEX = createPerDbValue<SourceFingerprintIndex>('source-fingerprint-index', {
  clearGroups: ['whole-project', 'definition-catalog'],
});

function getAllSourceFingerprints(db: ScipDatabase): SourceFingerprint[] {
  return SOURCE_FINGERPRINT_CORPUS.get(db, () => buildSourceFingerprints(db));
}

function getSourceFingerprintIndex(db: ScipDatabase): SourceFingerprintIndex {
  return SOURCE_FINGERPRINT_INDEX.get(db, () => buildSourceFingerprintIndex(getAllSourceFingerprints(db)));
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

function sourceCandidatesForTarget(target: SourceFingerprint, index: SourceFingerprintIndex): SourceFingerprint[] {
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

// scip-query: ignore-extract — this builds source-token fingerprints; scoped
// definitions, file-kind filtering, snippets, and token extraction are one
// text-similarity pass.
function buildSourceFingerprints(db: ScipDatabase): SourceFingerprint[] {
  const index = new ProjectIndex(db);
  // The shared production gate owns candidate policy (tests, rust test
  // modules, ignored paths, suppression comments) — no local re-filtering.
  return index
    .productionCallableDefinitions()
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
  const lines = getSourceLines(db, relativePath);
  if (lines.length === 0) {
    return '';
  }

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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
