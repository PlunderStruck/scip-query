import type { ScipDatabase } from '../../storage/db.js';
import { gitEvidenceProduct, type FileAddRecord, type GitHistoryMode } from '../../analysis/git-history.js';
import { sourceFrameworkApplicability } from '../../source/source-fileset.js';
import { reactComponentDuplicates } from '../frontend/react-component-duplicates.js';
import { reactHookCandidates } from '../frontend/react-hook-candidates.js';
import { similarAll } from './similar.js';
import { vueComponentDuplicates } from '../frontend/vue-component-duplicates.js';
import { vueComposableCandidates } from '../frontend/vue-composable-candidates.js';
import { isRustTraitImplMember } from '../../symbols/symbol-parser.js';

export type RecentDuplicateDomain = 'callable' | 'react-component' | 'react-hook' | 'vue-component' | 'vue-composable';

export type RecentDuplicateBasis =
  | 'callees'
  | 'source-tokens'
  | 'jsx-structure'
  | 'react-behavior'
  | 'vue-template'
  | 'vue-behavior';

export interface RecentDuplicateFinding {
  /** 'echo': recent code duplicating established code. 'twin': both sides are new. */
  kind: 'echo' | 'twin';
  domain: RecentDuplicateDomain;
  basis: RecentDuplicateBasis;
  /** Stable grouping key for repeated pairwise rows behind one review item. */
  groupKey?: string;
  /** Stable root-cause identity without the analyzer prefix. */
  rootCauseKey?: string;
  echoSymbol: string;
  echoFile: string;
  /** Commits ago the echo's file was added. */
  echoAgeCommits: number;
  establishedSymbol: string;
  establishedFile: string;
  /** Commits ago the established file was added; null = older than the window. */
  establishedAgeCommits: number | null;
  similarity: number;
  /** Domain-specific shared evidence. For callables this mirrors sharedCallees. */
  sharedEvidence: string[];
  /** Backwards-compatible callable evidence field. Empty for non-callable frontend domains. */
  sharedCallees: string[];
}

export interface RecentDuplicateRootCauseGroup {
  groupKey: string;
  rootCauseKey: string;
  kind: 'echo' | 'twin';
  domain: RecentDuplicateDomain;
  basis: RecentDuplicateBasis;
  count: number;
  maxSimilarity: number;
  findingIndexes: number[];
  echoFiles: string[];
  establishedFile?: string;
  establishedSymbol?: string;
  relatedFiles: string[];
  sharedEvidence: string[];
  recommendation: string;
}

export interface RecentDuplicatesResult {
  /** False when git history is unavailable. */
  available: boolean;
  windowCommits: number;
  findings: RecentDuplicateFinding[];
  /** Root-cause review items derived from the pairwise findings above. */
  rootCauseGroups?: RecentDuplicateRootCauseGroup[];
}

interface RecentDuplicateCandidate {
  domain: RecentDuplicateDomain;
  basis: RecentDuplicateBasis;
  symbolA: string;
  fileA: string;
  symbolB: string;
  fileB: string;
  similarity: number;
  sharedEvidence: string[];
  sharedCallees: string[];
}

type FileAddRecords = Map<string, FileAddRecord>;

interface RecentDuplicateCandidateOptions {
  limit: number;
  minSimilarity?: number;
  scanLimit?: number;
  scope?: string;
  semantic?: boolean;
  focusFiles?: ReadonlySet<string>;
}

interface FrontendDuplicatePair {
  fileA: string;
  fileB: string;
  similarity: number;
}

interface FrontendDuplicateOptions {
  limit: number;
  minSimilarity: number;
  scanLimit?: number;
  scope?: string;
  focusFiles?: ReadonlySet<string>;
}

interface FrontendDuplicateCandidateSource<TPair extends FrontendDuplicatePair> {
  domain: RecentDuplicateDomain;
  basis: RecentDuplicateBasis;
  query: (db: ScipDatabase, opts: FrontendDuplicateOptions) => TPair[];
  symbolA: (pair: TPair) => string;
  symbolB: (pair: TPair) => string;
  evidenceBuckets: (pair: TPair) => Array<[string, readonly string[]]>;
  acceptPair?: (pair: TPair) => boolean;
}

const CALLABLE_MIN_SIMILARITY = 0.7;
const FRONTEND_STRUCTURE_MIN_SIMILARITY = 0.62;
const FRONTEND_BEHAVIOR_MIN_SIMILARITY = 0.45;

/**
 * Recent re-implementations: AI agents (and humans in a hurry) write new
 * helpers that duplicate code they didn't know existed. Generic similarity
 * finds the pairs; this makes them DIRECTIONAL using git file ages — which
 * side is the established original, which is the recent echo.
 *
 * 'echo'  → the new code should probably use or extend the established code;
 *           delete the echo.
 * 'twin'  → both sides landed recently (often one agent session duplicating
 *           itself); pick one and consolidate before they diverge.
 *
 * Pairs where both sides are established are ordinary `similar` territory
 * and are skipped here.
 */
export function recentDuplicates(
  db: ScipDatabase,
  opts: {
    windowCommits?: number;
    minSimilarity?: number;
    limit?: number;
    scope?: string;
    scanLimit?: number;
    semantic?: boolean;
    historyMode?: GitHistoryMode;
  } = {},
): RecentDuplicatesResult {
  const { windowCommits = 100, limit = 30, scope, scanLimit } = opts;
  const adds = gitEvidenceProduct(db, { historyMode: opts.historyMode }).fileAddRecords();
  if (!adds) return { available: false, windowCommits, findings: [] };
  if (limit <= 0) return { available: true, windowCommits, findings: [] };
  const focusFiles = recentDuplicateFocusFiles(adds, windowCommits);
  if (focusFiles.size === 0) {
    return { available: true, windowCommits, findings: [] };
  }

  const candidates = collectRecentDuplicateCandidates(db, {
    limit,
    minSimilarity: opts.minSimilarity,
    scanLimit,
    scope,
    semantic: opts.semantic,
    focusFiles: Number.isFinite(limit) ? undefined : focusFiles,
  });

  const findings = candidates
    .map((candidate) => orientRecentDuplicate(candidate, adds, windowCommits))
    .filter((finding): finding is RecentDuplicateFinding => finding !== null);

  // Echoes first (clear directionality), then by similarity.
  findings.sort(
    (left, right) =>
      (left.kind === right.kind ? 0 : left.kind === 'echo' ? -1 : 1) ||
      right.similarity - left.similarity ||
      left.echoFile.localeCompare(right.echoFile) ||
      left.echoSymbol.localeCompare(right.echoSymbol) ||
      left.domain.localeCompare(right.domain),
  );
  const limitedFindings = findings.slice(0, limit).map(withRecentDuplicateGroupKey);
  return {
    available: true,
    windowCommits,
    findings: limitedFindings,
    rootCauseGroups: recentDuplicateRootCauseGroups(limitedFindings),
  };
}

function collectRecentDuplicateCandidates(
  db: ScipDatabase,
  opts: RecentDuplicateCandidateOptions,
): RecentDuplicateCandidate[] {
  const candidateLimit = expandedCandidateLimit(opts.limit);
  const candidates: RecentDuplicateCandidate[] = [
    ...callableDuplicateCandidates(db, {
      scope: opts.scope,
      minSimilarity: opts.minSimilarity ?? CALLABLE_MIN_SIMILARITY,
      limit: candidateLimit,
      scanLimit: opts.scanLimit,
      semantic: opts.semantic,
      focusFiles: opts.focusFiles,
    }),
  ];

  const applicability = sourceFrameworkApplicability(db, { scope: opts.scope });
  if (applicability.react) {
    candidates.push(
      ...reactComponentDuplicateCandidates(db, {
        scope: opts.scope,
        minSimilarity: opts.minSimilarity ?? FRONTEND_STRUCTURE_MIN_SIMILARITY,
        limit: candidateLimit,
        scanLimit: opts.scanLimit,
        focusFiles: opts.focusFiles,
      }),
      ...reactHookDuplicateCandidates(db, {
        scope: opts.scope,
        minSimilarity: opts.minSimilarity ?? FRONTEND_BEHAVIOR_MIN_SIMILARITY,
        limit: candidateLimit,
        scanLimit: opts.scanLimit,
        focusFiles: opts.focusFiles,
      }),
    );
  }

  if (applicability.vue) {
    candidates.push(
      ...vueComponentDuplicateCandidates(db, {
        scope: opts.scope,
        minSimilarity: opts.minSimilarity ?? FRONTEND_STRUCTURE_MIN_SIMILARITY,
        limit: candidateLimit,
        scanLimit: opts.scanLimit,
        focusFiles: opts.focusFiles,
      }),
      ...vueComposableDuplicateCandidates(db, {
        scope: opts.scope,
        minSimilarity: opts.minSimilarity ?? FRONTEND_BEHAVIOR_MIN_SIMILARITY,
        limit: candidateLimit,
        scanLimit: opts.scanLimit,
        focusFiles: opts.focusFiles,
      }),
    );
  }

  return candidates;
}

function callableDuplicateCandidates(
  db: ScipDatabase,
  opts: {
    minSimilarity: number;
    limit: number;
    scope?: string;
    scanLimit?: number;
    semantic?: boolean;
    focusFiles?: ReadonlySet<string>;
  },
): RecentDuplicateCandidate[] {
  return similarAll(db, {
    scope: opts.scope,
    minSimilarity: opts.minSimilarity,
    limit: opts.limit,
    crossFileOnly: true,
    scanLimit: opts.scanLimit,
    semantic: opts.semantic,
    focusFiles: opts.focusFiles,
  })
    .filter((pair) => !isRustTraitImplMember(pair.symbolA) && !isRustTraitImplMember(pair.symbolB))
    .map((pair) => ({
      domain: 'callable',
      basis: pair.similarityBasis ?? 'callees',
      symbolA: pair.shortNameA,
      fileA: pair.fileA,
      symbolB: pair.shortNameB,
      fileB: pair.fileB,
      similarity: pair.similarity,
      sharedEvidence: pair.sharedCallees,
      sharedCallees: pair.sharedCallees,
    }));
}

function reactComponentDuplicateCandidates(
  db: ScipDatabase,
  opts: FrontendDuplicateOptions,
): RecentDuplicateCandidate[] {
  return frontendDuplicateCandidates(db, opts, {
    query: reactComponentDuplicates,
    domain: 'react-component',
    basis: 'jsx-structure',
    symbolA: (pair) => pair.componentA,
    symbolB: (pair) => pair.componentB,
    evidenceBuckets: (pair) => [
      ['component', pair.sharedComponents],
      ['tag', pair.sharedNativeTags],
      ['prop', pair.sharedProps],
      ['event', pair.sharedEvents],
      ['binding', pair.sharedBindings],
    ],
  });
}

function frontendDuplicateCandidates<TPair extends FrontendDuplicatePair>(
  db: ScipDatabase,
  opts: FrontendDuplicateOptions,
  source: FrontendDuplicateCandidateSource<TPair>,
): RecentDuplicateCandidate[] {
  return source
    .query(db, opts)
    .filter((pair) => pair.fileA !== pair.fileB)
    .filter((pair) => source.acceptPair?.(pair) ?? true)
    .map((pair) => ({
      domain: source.domain,
      basis: source.basis,
      symbolA: source.symbolA(pair),
      fileA: pair.fileA,
      symbolB: source.symbolB(pair),
      fileB: pair.fileB,
      similarity: pair.similarity,
      sharedEvidence: evidenceFromBuckets(...source.evidenceBuckets(pair)),
      sharedCallees: [],
    }));
}

function reactHookDuplicateCandidates(db: ScipDatabase, opts: FrontendDuplicateOptions): RecentDuplicateCandidate[] {
  return frontendDuplicateCandidates(db, opts, {
    query: reactHookCandidates,
    domain: 'react-hook',
    basis: 'react-behavior',
    symbolA: (pair) => pair.componentA,
    symbolB: (pair) => pair.componentB,
    acceptPair: hasSubstantiveSharedReactBehavior,
    evidenceBuckets: (pair) => [
      ['hook', pair.sharedHooks],
      ['react-hook', pair.sharedReactHooks],
      ['effect', pair.sharedEffects],
      ['state', pair.sharedState],
      ['request', pair.sharedRequests],
      ['handler', pair.sharedHandlers],
      ['action', pair.sharedHandlerVerbs],
    ],
  });
}

const GENERIC_REACT_BEHAVIOR_HOOKS = new Set([
  'useCallback',
  'useEffect',
  'useLayoutEffect',
  'useMemo',
  'useMutation',
  'useQueries',
  'useQuery',
  'useQueryClient',
  'useReducer',
  'useRef',
  'useState',
]);

function hasSubstantiveSharedReactBehavior(pair: ReturnType<typeof reactHookCandidates>[number]): boolean {
  return (
    pair.sharedHooks.some((hook) => !GENERIC_REACT_BEHAVIOR_HOOKS.has(hook)) ||
    pair.sharedState.length > 0 ||
    pair.sharedHandlers.length > 0 ||
    pair.sharedHandlerVerbs.length >= 2
  );
}

function vueComponentDuplicateCandidates(db: ScipDatabase, opts: FrontendDuplicateOptions): RecentDuplicateCandidate[] {
  return frontendDuplicateCandidates(db, opts, {
    query: vueComponentDuplicates,
    domain: 'vue-component',
    basis: 'vue-template',
    symbolA: (pair) => fileStem(pair.fileA),
    symbolB: (pair) => fileStem(pair.fileB),
    evidenceBuckets: (pair) => [
      ['component', pair.sharedComponents],
      ['prop', pair.sharedProps],
      ['event', pair.sharedEvents],
      ['directive', pair.sharedDirectives],
      ['slot', pair.sharedSlots],
      ['identifier', pair.sharedIdentifiers],
    ],
  });
}

function vueComposableDuplicateCandidates(
  db: ScipDatabase,
  opts: FrontendDuplicateOptions,
): RecentDuplicateCandidate[] {
  return frontendDuplicateCandidates(db, opts, {
    query: vueComposableCandidates,
    domain: 'vue-composable',
    basis: 'vue-behavior',
    symbolA: (pair) => fileStem(pair.fileA),
    symbolB: (pair) => fileStem(pair.fileB),
    evidenceBuckets: (pair) => [
      ['composable', pair.sharedComposables],
      ['store', pair.sharedStores],
      ['reactivity', pair.sharedReactivity],
      ['lifecycle', pair.sharedLifecycle],
      ['request', pair.sharedRequests],
      ['function', pair.sharedFunctions],
      ['action', pair.sharedFunctionVerbs],
      ['binding', pair.sharedBindings],
      ['template-event', pair.sharedTemplateEvents],
    ],
  });
}

function recentDuplicateFocusFiles(adds: FileAddRecords, windowCommits: number): Set<string> {
  const files = new Set<string>();
  for (const [file, record] of adds) {
    if (record.commitsAgo <= windowCommits) files.add(file);
  }
  return files;
}

function orientRecentDuplicate(
  candidate: RecentDuplicateCandidate,
  adds: FileAddRecords,
  windowCommits: number,
): RecentDuplicateFinding | null {
  const ageA = adds.get(candidate.fileA)?.commitsAgo ?? null;
  const ageB = adds.get(candidate.fileB)?.commitsAgo ?? null;
  const newA = ageA !== null && ageA <= windowCommits;
  const newB = ageB !== null && ageB <= windowCommits;
  if (!newA && !newB) return null;

  if (newA && newB) {
    // Twin: orient by recency so output is stable (newer file = echo).
    const aIsEcho = (ageA ?? 0) <= (ageB ?? 0);
    return {
      kind: 'twin',
      domain: candidate.domain,
      basis: candidate.basis,
      echoSymbol: aIsEcho ? candidate.symbolA : candidate.symbolB,
      echoFile: aIsEcho ? candidate.fileA : candidate.fileB,
      echoAgeCommits: (aIsEcho ? ageA : ageB) ?? 0,
      establishedSymbol: aIsEcho ? candidate.symbolB : candidate.symbolA,
      establishedFile: aIsEcho ? candidate.fileB : candidate.fileA,
      establishedAgeCommits: aIsEcho ? ageB : ageA,
      similarity: candidate.similarity,
      sharedEvidence: candidate.sharedEvidence,
      sharedCallees: candidate.sharedCallees,
    };
  }

  return {
    kind: 'echo',
    domain: candidate.domain,
    basis: candidate.basis,
    echoSymbol: newA ? candidate.symbolA : candidate.symbolB,
    echoFile: newA ? candidate.fileA : candidate.fileB,
    echoAgeCommits: (newA ? ageA : ageB) ?? 0,
    establishedSymbol: newA ? candidate.symbolB : candidate.symbolA,
    establishedFile: newA ? candidate.fileB : candidate.fileA,
    establishedAgeCommits: newA ? ageB : ageA,
    similarity: candidate.similarity,
    sharedEvidence: candidate.sharedEvidence,
    sharedCallees: candidate.sharedCallees,
  };
}

function withRecentDuplicateGroupKey(finding: RecentDuplicateFinding): RecentDuplicateFinding {
  const rootCauseKey = recentDuplicateRootCauseKey(finding);
  return {
    ...finding,
    rootCauseKey,
    groupKey: `recent-duplicate:${rootCauseKey}`,
  };
}

function recentDuplicateRootCauseKey(finding: RecentDuplicateFinding): string {
  if (finding.kind === 'echo') {
    return ['echo', finding.domain, finding.basis, finding.establishedSymbol].join(':');
  }
  const evidence = finding.sharedEvidence.slice().sort().join('|');
  const fallback = [finding.echoSymbol, finding.establishedSymbol].sort().join('|');
  return ['twin', finding.domain, finding.basis, evidence || fallback].join(':');
}

function recentDuplicateRootCauseGroups(findings: readonly RecentDuplicateFinding[]): RecentDuplicateRootCauseGroup[] {
  const groups = new Map<
    string,
    Omit<RecentDuplicateRootCauseGroup, 'echoFiles' | 'relatedFiles' | 'sharedEvidence'> & {
      echoFiles: Set<string>;
      relatedFiles: Set<string>;
      sharedEvidence: Set<string>;
    }
  >();

  for (const [index, finding] of findings.entries()) {
    const rootCauseKey = finding.rootCauseKey ?? recentDuplicateRootCauseKey(finding);
    const groupKey = finding.groupKey ?? `recent-duplicate:${rootCauseKey}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        groupKey,
        rootCauseKey,
        kind: finding.kind,
        domain: finding.domain,
        basis: finding.basis,
        count: 0,
        maxSimilarity: finding.similarity,
        findingIndexes: [],
        echoFiles: new Set<string>(),
        establishedFile: finding.kind === 'echo' ? finding.establishedFile : undefined,
        establishedSymbol: finding.kind === 'echo' ? finding.establishedSymbol : undefined,
        relatedFiles: new Set<string>(),
        sharedEvidence: new Set<string>(),
        recommendation: recentDuplicateGroupRecommendation(finding),
      };
      groups.set(groupKey, group);
    }

    group.count += 1;
    group.maxSimilarity = Math.max(group.maxSimilarity, finding.similarity);
    group.findingIndexes.push(index);
    group.echoFiles.add(finding.echoFile);
    group.relatedFiles.add(finding.echoFile);
    group.relatedFiles.add(finding.establishedFile);
    for (const evidence of finding.sharedEvidence) group.sharedEvidence.add(evidence);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      echoFiles: [...group.echoFiles].sort(),
      relatedFiles: [...group.relatedFiles].sort(),
      sharedEvidence: [...group.sharedEvidence].sort().slice(0, 16),
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        right.maxSimilarity - left.maxSimilarity ||
        left.groupKey.localeCompare(right.groupKey),
    );
}

function recentDuplicateGroupRecommendation(finding: RecentDuplicateFinding): string {
  if (finding.kind === 'echo') {
    return 'Review the established side once, then migrate or delete every echo in this group.';
  }
  return 'Pick one owner for the new twins and consolidate the group before the copies diverge.';
}

function expandedCandidateLimit(limit: number): number {
  return Number.isFinite(limit) ? limit * 5 : Number.POSITIVE_INFINITY;
}

function evidenceFromBuckets(...buckets: Array<[string, readonly string[]]>): string[] {
  const evidence: string[] = [];
  const seen = new Set<string>();
  for (const [prefix, values] of buckets) {
    for (const value of values) {
      const entry = `${prefix}:${value}`;
      if (seen.has(entry)) continue;
      seen.add(entry);
      evidence.push(entry);
    }
  }
  return evidence;
}

function fileStem(file: string): string {
  const leaf = file.split('/').pop() ?? file;
  return leaf.replace(/\.[^.]+$/, '');
}
