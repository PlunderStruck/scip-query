import type { IndexedDefinition } from '../../domain/types.js';
import { readRuntimeBoundaryGraph } from '../../analysis/runtime-boundaries/index.js';
import type { BoundaryLink, BoundaryObservation } from '../../analysis/runtime-boundaries/types.js';
import { behaviorConstructRange } from '../../source/facts/behavior-skeleton.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import { classifyFile, type FileKind } from '../../source/primitives/file-kind.js';
import { repositoryTextInventory, type RepositoryTextFile } from '../../source/primitives/repository-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { findEnclosingDefinition, getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import type { CalleeEvidenceSource, CalleeRow } from '../../symbols/graph/call-graph-evidence.js';
import { importedMemberCallTargets } from '../../symbols/graph/member-call-targets.js';
import { scipOccurrenceCallTargetsForRange } from '../../symbols/graph/scip-occurrence-call-targets.js';
import { getGlobalLeafIndex, pickAstCallCandidate, sameLanguageCandidates } from '../../symbols/leaf-symbol-index.js';
import { isModuleLikeSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../internal/project-index.js';

const DEFAULT_GROUP_LIMIT = 4;
const DEFAULT_ANALYSIS_MULTIPLIER = 3;
const MIN_ANALYZED_ROOTS = 12;
const MIN_SYMBOL_ANALYZED_ROOTS = 48;
const MAX_CALLEES_PER_NODE = 64;
const MAX_RENDERED_RELATIONS = 10;
const MAX_KEY_ANCHORS = 6;
const MAX_EFFECT_TARGETS = 24;
const MAX_EFFECT_CALLER_DEFINITIONS = 320;
const MAX_EFFECT_KEY_ANCHORS = 6;
const MAX_COMPOSITION_SOURCE_GROUPS = 12;
const MAX_COMPOSITION_DESTINATION_GROUPS = 1;
const MAX_COMPOSITION_CALL_DEPTH = 4;
const MAX_COMPOSITION_KEY_ANCHORS = 7;
const MAX_PARALLEL_PATH_GROUPS = 12;
const SOURCE_CONSTRUCT_SYMBOL_PREFIX = 'source-construct:';
const MAX_SOURCE_CANDIDATE_FILES = 96;
const MAX_PATH_SOURCE_CANDIDATE_FILES = 32;
const MAX_TERM_COVERAGE_ROOTS = 4;
const MAX_PATH_CALLABLE_ROOTS = 32;
const MAX_PATH_CALLABLES_PER_FILE = 8;
const MAX_SYSTEM_MAP_SELECTION_TERMS = 16;

const QUERY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'become',
  'becomes',
  'by',
  'can',
  'does',
  'for',
  'from',
  'how',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'then',
  'this',
  'through',
  'to',
  'what',
  'when',
  'where',
  'which',
  'with',
]);

export type AnchorDiscoveryMatchSource = 'symbol' | 'path' | 'documentation' | 'source';

export interface AnchorDiscoveryTermMatch {
  term: string;
  sources: AnchorDiscoveryMatchSource[];
  locations: Array<{ file: string; line: number }>;
}

export interface AnchorDiscoveryCandidate {
  symbol: string;
  label: string;
  leaf: string;
  file: string;
  line: number;
  endLine: number;
  kind: 'callable' | 'type' | 'symbol';
  fileKind: FileKind;
  matches: AnchorDiscoveryTermMatch[];
  focusLocations: Array<{ file: string; line: number; matchedTerms: string[] }>;
  matchedTerms: string[];
  symbolMatchedTerms: string[];
  symbolPhraseLength: number;
  identityMatchedTerms: string[];
  rarity: number;
  symbolRarity: number;
}

export interface AnchorDiscoveryRelation {
  kind: 'call' | 'runtime-boundary';
  fromSymbol: string;
  fromLabel: string;
  fromFile: string;
  toSymbol: string;
  toLabel: string;
  toFile: string;
  depth: number;
  strength: 'exact' | 'derived';
  evidence:
    | CalleeEvidenceSource
    | 'scip-occurrence-callsite'
    | 'ast-member-import-candidate'
    | `runtime-boundary:${string}`;
  callsiteLine: number | null;
  runtimeBoundaryKey?: string;
}

export interface AnchorDiscoveryGroup {
  id: string;
  kind: 'cross-boundary-flow' | 'parallel-paths' | 'connected-flow' | 'shared-callee-owners';
  roots: AnchorDiscoveryCandidate[];
  keyAnchors: AnchorDiscoveryCandidate[];
  candidateOwnerCount: number;
  omittedCandidateOwners: AnchorDiscoveryCandidate[];
  ownerRecoveryCommands: string[];
  upstreamEntries: AnchorDiscoveryUpstreamEntry[];
  matchedTerms: string[];
  relations: AnchorDiscoveryRelation[];
  relationCount: number;
  /** Number of independently named sides that carry at least one causal edge. */
  parallelConnectedSides?: number;
  /** Number of independently named sides whose matched root has an outgoing causal edge. */
  parallelOrchestrationSides?: number;
  /** Query vocabulary that occurs in the repository path on every batched side. */
  parallelSharedPathTerms?: string[];
  /** Rarest repository frequency among the shared path terms; lower is more discriminative. */
  parallelSharedPathFrequency?: number;
  /** Matched roots that initiate at least one returned causal relationship. */
  orchestrationRootCount?: number;
  omittedRelations: number;
  systemMapCommand: string;
}

export interface AnchorDiscoveryUpstreamEntry {
  name: string;
  file: string;
  line: number;
  endLine: number;
  callsiteLine: number;
}

export interface AnchorDiscoveryResult {
  query: string;
  normalizedTerms: string[];
  matchedTerms: string[];
  unmatchedTerms: string[];
  groups: AnchorDiscoveryGroup[];
  candidateRoots: AnchorDiscoveryCandidate[];
  candidateRootCount: number;
  analyzedRootCount: number;
  omittedRootCount: number;
  omittedGroupCount: number;
  scannedFiles: number;
  scannedBytes: number;
  recoveryCommand: string | null;
}

export interface AnchorDiscoveryOptions {
  scope?: string;
  limit?: number;
  full?: boolean;
  semantic?: boolean;
}

interface MutableCandidate {
  definition: IndexedDefinition;
  matches: Map<string, MutableTermMatch>;
  symbolPhraseLength: number;
}

interface MutableTermMatch {
  sources: Set<AnchorDiscoveryMatchSource>;
  locations: Map<string, { file: string; line: number }>;
}

interface RootNeighborhood {
  root: AnchorDiscoveryCandidate;
  relations: AnchorDiscoveryRelation[];
  nodeSymbols: Set<string>;
}

/**
 * Locate a small set of graph starting points from vocabulary that already
 * exists in the repository. Query words are normalized mechanically; their
 * meaning is not inferred. The highest-ranked owning definitions receive a
 * bounded two-hop call expansion so connected candidates can be selected in
 * one model-visible packet.
 */
export function discoverAnchors(
  db: ScipDatabase,
  query: string,
  options: AnchorDiscoveryOptions = {},
): AnchorDiscoveryResult {
  const normalizedTerms = normalizeAnchorQuery(query);
  if (normalizedTerms.length === 0) {
    throw new Error('Anchor discovery requires at least one non-trivial repository term.');
  }
  const limit = options.limit ?? DEFAULT_GROUP_LIMIT;
  const full = options.full === true;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`anchor group limit must be a positive safe integer; received ${limit}`);
  }

  const index = new ProjectIndex(db);
  const compilerDefinitions = index
    .scopedDefinitions(options.scope)
    .filter((definition) => !isModuleLikeSymbol(definition.symbol));
  const definitions = [...compilerDefinitions];
  const definitionBySymbol = new Map(definitions.map((definition) => [definition.symbol, definition]));
  const mutableCandidates = new Map<string, MutableCandidate>();

  for (const definition of compilerDefinitions) {
    matchDefinitionVocabulary(mutableCandidates, definition, normalizedTerms);
  }

  const inventory = repositoryTextInventory(db, { scope: options.scope });
  for (const file of inventory.files) {
    const indexedFileDefinitions = getDefinitionsForFile(db, file.relativePath);
    const fileDefinitions = indexedFileDefinitions.filter((definition) => !isModuleLikeSymbol(definition.symbol));
    if (fileDefinitions.length === 0) continue;
    const lines = searchableLines(file.text);
    for (let line = 0; line < lines.length; line += 1) {
      const lineTerms = normalizedWordSet(lines[line] ?? '');
      const matched = normalizedTerms.filter((term) => lineTerms.has(term));
      if (matched.length === 0) continue;
      const owner = findEnclosingDefinition(fileDefinitions, line);
      if (!owner || isModuleLikeSymbol(owner.symbol)) continue;
      for (const term of matched) addCandidateMatch(mutableCandidates, owner, term, 'source', file.relativePath, line);
    }
  }

  const preliminaryFrequencies = candidateTermFrequencies(mutableCandidates);
  const preliminaryRoots = [...mutableCandidates.values()]
    .map((candidate) => publicCandidate(candidate, preliminaryFrequencies))
    .sort(compareCandidates);
  const sourceCandidateFiles = selectSourceCandidateFiles(inventory.files, preliminaryRoots, normalizedTerms);
  let nextSourceConstructId = -1;
  for (const file of sourceCandidateFiles) {
    const indexedFileDefinitions = getDefinitionsForFile(db, file.relativePath);
    const fileDefinitions = indexedFileDefinitions.filter((definition) => !isModuleLikeSymbol(definition.symbol));
    const callables = getSourceFacts(db, file.relativePath)?.callables ?? [];
    const sourceDefinitions = new Map<string, IndexedDefinition>();
    const sourceDefinitionFor = (callable: (typeof callables)[number]): IndexedDefinition | null => {
      const key = `${callable.startLine}\0${callable.endLine}\0${callable.name}`;
      const existing = sourceDefinitions.get(key);
      if (existing) return existing;
      const definition = sourceCallableDefinition(
        file.relativePath,
        indexedFileDefinitions,
        callable,
        () => nextSourceConstructId--,
      );
      if (!definition) return null;
      sourceDefinitions.set(key, definition);
      definitions.push(definition);
      definitionBySymbol.set(definition.symbol, definition);
      matchDefinitionVocabulary(mutableCandidates, definition, normalizedTerms);
      return definition;
    };
    for (const callable of callables) {
      const leafTerms = normalizedWordSet(callable.name);
      if (normalizedTerms.some((term) => leafTerms.has(term))) sourceDefinitionFor(callable);
    }
    if (callables.length === 0) continue;
    const lines = searchableLines(file.text);
    for (let line = 0; line < lines.length; line += 1) {
      const lineTerms = normalizedWordSet(lines[line] ?? '');
      const matched = normalizedTerms.filter((term) => lineTerms.has(term));
      if (matched.length === 0) continue;
      const callable = smallestSourceCallable(callables, line);
      const sourceDefinition = callable ? sourceDefinitionFor(callable) : null;
      if (!sourceDefinition) continue;
      const compilerOwner = smallestEnclosingDefinition(fileDefinitions, line);
      const owner = smallestEnclosingDefinition(
        compilerOwner ? [compilerOwner, sourceDefinition] : [sourceDefinition],
        line,
      );
      if (owner?.symbol !== sourceDefinition.symbol) continue;
      for (const term of matched) {
        addCandidateMatch(mutableCandidates, sourceDefinition, term, 'source', file.relativePath, line);
      }
    }
  }

  const candidateFrequencies = candidateTermFrequencies(mutableCandidates);
  const candidateRoots = [...mutableCandidates.values()]
    .map((candidate) => publicCandidate(candidate, candidateFrequencies))
    .sort(compareCandidates);
  const analysisBudget = Math.min(
    candidateRoots.length,
    Math.max(MIN_ANALYZED_ROOTS, limit * DEFAULT_ANALYSIS_MULTIPLIER),
  );
  const analyzedRoots = full
    ? candidateRoots
    : uniqueCandidates([
        ...candidateRoots.slice(0, analysisBudget),
        ...[...candidateRoots]
          .sort(compareSymbolCandidates)
          .slice(0, Math.max(MIN_SYMBOL_ANALYZED_ROOTS, analysisBudget)),
        ...selectTermCoverageRoots(candidateRoots, normalizedTerms),
        ...selectPathCallableRoots(candidateRoots, normalizedTerms, candidateFrequencies),
      ]);
  const analyzedRootCount = analyzedRoots.length;
  const rootDefinitions = analyzedRoots
    .map((candidate) => definitionBySymbol.get(candidate.symbol))
    .filter((definition): definition is IndexedDefinition => definition?.isFunctionLike === true);
  const sourceDefinitionIndex = indexSourceConstructDefinitions(definitions);
  const neighborhoods = buildRootNeighborhoods(
    db,
    index,
    analyzedRoots,
    rootDefinitions,
    definitionBySymbol,
    sourceDefinitionIndex,
    new Set(mutableCandidates.keys()),
    options.semantic !== false,
  );
  const connectedGroups = connectedRootGroups(
    neighborhoods,
    analyzedRoots,
    mutableCandidates,
    candidateFrequencies,
    definitionBySymbol,
  );
  const parallelGroups = parallelPathGroups(connectedGroups, candidateFrequencies, normalizedTerms);
  const effectGroups = effectOwnerGroups(
    db,
    index,
    neighborhoods,
    mutableCandidates,
    candidateFrequencies,
    definitions,
    definitionBySymbol,
    options.semantic !== false,
  );
  const crossBoundaryGroups = crossBoundaryFlowGroups(
    db,
    index,
    connectedGroups,
    definitionBySymbol,
    options.semantic !== false,
  );
  const selectionTerms = selectSystemMapSelectionTerms(normalizedTerms, candidateFrequencies);
  const groups = [...crossBoundaryGroups, ...parallelGroups, ...connectedGroups, ...effectGroups]
    .map((group) => ({
      ...group,
      systemMapCommand: appendSystemMapSelectionTerms(group.systemMapCommand, selectionTerms),
    }))
    .sort(compareGroups);
  const selectedGroups = full ? groups : selectDisplayedGroups(groups, limit);
  const matchedTerms = normalizedTerms.filter((term) => candidateFrequencies.has(term));
  const unmatchedTerms = normalizedTerms.filter((term) => !candidateFrequencies.has(term));
  const omittedRootCount = Math.max(0, candidateRoots.length - analyzedRootCount);
  const omittedGroupCount = Math.max(0, groups.length - selectedGroups.length) + omittedRootCount;
  const expandedLimit = full
    ? candidateRoots.length
    : Math.min(candidateRoots.length, Math.max(limit + DEFAULT_GROUP_LIMIT, analyzedRootCount));

  return {
    query,
    normalizedTerms,
    matchedTerms,
    unmatchedTerms,
    groups: selectedGroups,
    candidateRoots,
    candidateRootCount: candidateRoots.length,
    analyzedRootCount,
    omittedRootCount,
    omittedGroupCount,
    scannedFiles: inventory.files.length,
    scannedBytes: inventory.scannedBytes,
    recoveryCommand:
      omittedGroupCount === 0
        ? null
        : `scip-query anchors ${shellArgument(query)}${
            options.scope ? ` --scope ${shellArgument(options.scope)}` : ''
          } --limit ${expandedLimit}`,
  };
}

export function normalizeAnchorQuery(query: string): string[] {
  const ordered = splitWords(query)
    .filter((word) => !QUERY_STOP_WORDS.has(word.toLocaleLowerCase()))
    .map(canonicalWord)
    .filter((word) => word.length >= 3 && !QUERY_STOP_WORDS.has(word));
  return [...new Set(ordered)];
}

function matchDefinitionVocabulary(
  candidates: Map<string, MutableCandidate>,
  definition: IndexedDefinition,
  terms: readonly string[],
): void {
  const leafTerms = normalizedWordSet(definition.leaf);
  const pathTerms = normalizedWordSet(definition.relativePath);
  const documentationTerms = normalizedWordSet(definition.documentation ?? '');
  for (const term of terms) {
    if (leafTerms.has(term)) addCandidateMatch(candidates, definition, term, 'symbol');
    if (pathTerms.has(term)) addCandidateMatch(candidates, definition, term, 'path');
    if (documentationTerms.has(term)) addCandidateMatch(candidates, definition, term, 'documentation');
  }
  const candidate = candidates.get(definition.symbol);
  if (candidate) candidate.symbolPhraseLength = longestContiguousMatch(definition.leaf, terms);
}

function addCandidateMatch(
  candidates: Map<string, MutableCandidate>,
  definition: IndexedDefinition,
  term: string,
  source: AnchorDiscoveryMatchSource,
  file?: string,
  line?: number,
): void {
  const candidate = candidates.get(definition.symbol) ?? {
    definition,
    matches: new Map<string, MutableTermMatch>(),
    symbolPhraseLength: 0,
  };
  const match = candidate.matches.get(term) ?? {
    sources: new Set<AnchorDiscoveryMatchSource>(),
    locations: new Map<string, { file: string; line: number }>(),
  };
  match.sources.add(source);
  if (file !== undefined && line !== undefined) match.locations.set(`${file}\0${line}`, { file, line });
  candidate.matches.set(term, match);
  candidates.set(definition.symbol, candidate);
}

function candidateTermFrequencies(candidates: ReadonlyMap<string, MutableCandidate>): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const candidate of candidates.values()) {
    for (const term of candidate.matches.keys()) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  return frequencies;
}

function sourceCallableDefinition(
  relativePath: string,
  indexedDefinitions: readonly IndexedDefinition[],
  callable: { name: string; startLine: number; endLine: number },
  nextSymbolId: () => number,
): IndexedDefinition | null {
  const documentId = indexedDefinitions[0]?.documentId;
  if (documentId === undefined) return null;
  const compilerDefinition = indexedDefinitions.find(
    (definition) =>
      definition.isFunctionLike &&
      definition.leaf === callable.name &&
      definition.startLine === callable.startLine &&
      definition.endLine === callable.endLine,
  );
  if (compilerDefinition) return null;
  const symbolId = nextSymbolId();
  return {
    documentId,
    symbolId,
    symbol: `${SOURCE_CONSTRUCT_SYMBOL_PREFIX}${relativePath}:${callable.startLine}:${callable.endLine}:${callable.name}`,
    relativePath,
    startLine: callable.startLine,
    startChar: 0,
    endLine: callable.endLine,
    endChar: 0,
    leaf: callable.name,
    parentTypeName: null,
    isFunctionLike: true,
    isTypeLike: false,
    kind: null,
    documentation: null,
    enclosingSymbol: null,
  } satisfies IndexedDefinition;
}

function selectSourceCandidateFiles(
  files: readonly RepositoryTextFile[],
  preliminaryRoots: readonly AnchorDiscoveryCandidate[],
  queryTerms: readonly string[],
): RepositoryTextFile[] {
  const selectedPaths = new Set(
    preliminaryRoots.slice(0, MAX_SOURCE_CANDIDATE_FILES).map((candidate) => candidate.file),
  );
  const queryTermSet = new Set(queryTerms);
  const pathCandidates = files
    .map((file) => {
      const pathTerms = normalizedWordSet(file.relativePath);
      const basename = file.relativePath.slice(file.relativePath.lastIndexOf('/') + 1).replace(/\.[^.]+$/u, '');
      const basenameTerms = normalizedWordSet(basename);
      const pathOverlap = [...pathTerms].filter((term) => queryTermSet.has(term)).length;
      const basenameOverlap = [...basenameTerms].filter((term) => queryTermSet.has(term)).length;
      return { file, score: basenameOverlap * 4 + pathOverlap };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        fileKindRank(classifyFile(left.file.relativePath)) - fileKindRank(classifyFile(right.file.relativePath)) ||
        left.file.relativePath.localeCompare(right.file.relativePath),
    )
    .slice(0, MAX_PATH_SOURCE_CANDIDATE_FILES);
  for (const candidate of pathCandidates) selectedPaths.add(candidate.file.relativePath);
  return files.filter((file) => selectedPaths.has(file.relativePath));
}

function smallestSourceCallable<T extends { startLine: number; endLine: number }>(
  callables: readonly T[],
  line: number,
): T | undefined {
  return callables
    .filter((callable) => callable.startLine <= line && callable.endLine >= line)
    .sort(
      (left, right) =>
        left.endLine - left.startLine - (right.endLine - right.startLine) || left.startLine - right.startLine,
    )[0];
}

function indexSourceConstructDefinitions(
  definitions: readonly IndexedDefinition[],
): ReadonlyMap<string, readonly IndexedDefinition[]> {
  const index = new Map<string, IndexedDefinition[]>();
  for (const definition of definitions) {
    if (!isSourceConstructDefinition(definition)) continue;
    const key = `${definition.relativePath}\0${normalizedCallableLeaf(definition.leaf)}`;
    const bucket = index.get(key) ?? [];
    bucket.push(definition);
    index.set(key, bucket);
  }
  return index;
}

function smallestEnclosingDefinition(
  definitions: readonly IndexedDefinition[],
  line: number,
): IndexedDefinition | undefined {
  return definitions
    .filter((definition) => definition.startLine <= line && definition.endLine >= line)
    .sort(
      (left, right) =>
        left.endLine - left.startLine - (right.endLine - right.startLine) ||
        Number(isSourceConstructDefinition(right)) - Number(isSourceConstructDefinition(left)) ||
        left.startLine - right.startLine ||
        left.symbol.localeCompare(right.symbol),
    )[0];
}

function isSourceConstructDefinition(definition: Pick<IndexedDefinition, 'symbol'>): boolean {
  return definition.symbol.startsWith(SOURCE_CONSTRUCT_SYMBOL_PREFIX);
}

function candidateLabel(definition: IndexedDefinition): string {
  return isSourceConstructDefinition(definition) ? definition.leaf : shortenSymbol(definition.symbol);
}

function publicCandidate(
  candidate: MutableCandidate,
  frequencies: ReadonlyMap<string, number>,
): AnchorDiscoveryCandidate {
  const definition = candidate.definition;
  const matches = [...candidate.matches.entries()]
    .map(([term, match]) => ({
      term,
      sources: [...match.sources].sort(compareMatchSources),
      locations: [...match.locations.values()].sort(compareLocations).slice(0, 3),
    }))
    .sort((left, right) => left.term.localeCompare(right.term));
  const identityMatchedTerms = matches
    .filter((match) => match.sources.some((source) => source !== 'source'))
    .map((match) => match.term);
  const symbolMatchedTerms = matches.filter((match) => match.sources.includes('symbol')).map((match) => match.term);
  const rarity = matches.reduce((score, match) => score + 1 / Math.max(1, frequencies.get(match.term) ?? 1), 0);
  const symbolRarity = matches
    .filter((match) => match.sources.includes('symbol'))
    .reduce((score, match) => score + 1 / Math.max(1, frequencies.get(match.term) ?? 1), 0);
  return {
    symbol: definition.symbol,
    label: candidateLabel(definition),
    leaf: definition.leaf,
    file: definition.relativePath,
    line: definition.startLine,
    endLine: definition.endLine,
    kind: definition.isFunctionLike ? 'callable' : definition.isTypeLike ? 'type' : 'symbol',
    fileKind: classifyFile(definition.relativePath),
    matches,
    focusLocations: selectCandidateFocusLocations(candidate, frequencies),
    matchedTerms: matches.map((match) => match.term),
    symbolMatchedTerms,
    symbolPhraseLength: candidate.symbolPhraseLength,
    identityMatchedTerms,
    rarity,
    symbolRarity,
  };
}

function buildRootNeighborhoods(
  db: ScipDatabase,
  index: ProjectIndex,
  roots: readonly AnchorDiscoveryCandidate[],
  rootDefinitions: readonly IndexedDefinition[],
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
  sourceDefinitionIndex: ReadonlyMap<string, readonly IndexedDefinition[]>,
  priorityTargetSymbols: ReadonlySet<string>,
  semantic: boolean,
): RootNeighborhood[] {
  const compilerRootDefinitions = rootDefinitions.filter((definition) => !isSourceConstructDefinition(definition));
  const directMap = index.calleeMap(compilerRootDefinitions, { additive: false, semantic });
  const directRelations = new Map<string, AnchorDiscoveryRelation[]>();
  const firstHopDefinitions = new Map<string, IndexedDefinition>();

  for (const root of roots) {
    const definition = definitionBySymbol.get(root.symbol);
    const relations = definition
      ? isSourceConstructDefinition(definition)
        ? sourceConstructCalleeRelations(db, definition, definitionBySymbol, sourceDefinitionIndex, 1)
        : calleeRelations(
            db,
            definition,
            directMap.get(definition.symbolId) ?? [],
            definitionBySymbol,
            1,
            priorityTargetSymbols,
          )
      : [];
    directRelations.set(root.symbol, relations);
    for (const relation of relations) {
      const target = definitionBySymbol.get(relation.toSymbol);
      if (
        target?.isFunctionLike &&
        (!definition || !isSourceConstructDefinition(definition) || isSourceConstructDefinition(target))
      ) {
        firstHopDefinitions.set(target.symbol, target);
      }
    }
  }

  const secondDefinitions = [...firstHopDefinitions.values()];
  const secondMap = index.calleeMap(
    secondDefinitions.filter((definition) => !isSourceConstructDefinition(definition)),
    { additive: false, semantic },
  );
  const secondRelations = new Map<string, AnchorDiscoveryRelation[]>();
  for (const definition of secondDefinitions) {
    secondRelations.set(
      definition.symbol,
      isSourceConstructDefinition(definition)
        ? sourceConstructCalleeRelations(db, definition, definitionBySymbol, sourceDefinitionIndex, 2)
        : calleeRelations(
            db,
            definition,
            secondMap.get(definition.symbolId) ?? [],
            definitionBySymbol,
            2,
            priorityTargetSymbols,
          ),
    );
  }

  return roots.map((root) => {
    const direct = directRelations.get(root.symbol) ?? [];
    const second = direct.flatMap((relation) => secondRelations.get(relation.toSymbol) ?? []);
    const relations = deduplicateRelations([...direct, ...second]);
    return {
      root,
      relations,
      nodeSymbols: new Set([root.symbol, ...relations.flatMap((relation) => [relation.fromSymbol, relation.toSymbol])]),
    };
  });
}

function calleeRelations(
  db: ScipDatabase,
  from: IndexedDefinition,
  rows: readonly CalleeRow[],
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
  depth: number,
  priorityTargetSymbols: ReadonlySet<string> = new Set(),
): AnchorDiscoveryRelation[] {
  const bestByTarget = new Map<string, CalleeRow>();
  for (const row of rows) {
    const target = definitionBySymbol.get(row.symbol);
    if (!target?.isFunctionLike || target.symbol === from.symbol) continue;
    if (row.source === 'ast-callsite' && !astCallsiteConfirmsTarget(db, from, target, row.callsiteLine)) continue;
    const existing = bestByTarget.get(target.symbol);
    if (!existing || compareCalleeRows(row, existing) < 0) bestByTarget.set(target.symbol, row);
  }
  return [...bestByTarget.entries()]
    .map(([symbol, row]) => {
      const target = definitionBySymbol.get(symbol)!;
      return {
        kind: 'call',
        fromSymbol: from.symbol,
        fromLabel: shortenSymbol(from.symbol),
        fromFile: from.relativePath,
        toSymbol: target.symbol,
        toLabel: shortenSymbol(target.symbol),
        toFile: target.relativePath,
        depth,
        strength: calleeStrength(row.source),
        evidence: row.source,
        callsiteLine: row.callsiteLine ?? firstCallsiteLine(db, from, target),
      } satisfies AnchorDiscoveryRelation;
    })
    .sort(
      (left, right) =>
        Number(priorityTargetSymbols.has(right.toSymbol)) - Number(priorityTargetSymbols.has(left.toSymbol)) ||
        compareRelations(left, right),
    )
    .slice(0, MAX_CALLEES_PER_NODE);
}

function sourceConstructCalleeRelations(
  db: ScipDatabase,
  from: IndexedDefinition,
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
  sourceDefinitionIndex: ReadonlyMap<string, readonly IndexedDefinition[]>,
  depth: number,
): AnchorDiscoveryRelation[] {
  const relations: AnchorDiscoveryRelation[] = scipOccurrenceCallTargetsForRange(
    db,
    from.relativePath,
    from.startLine,
    from.endLine,
  ).targets.flatMap((target) => {
    const definition = definitionBySymbol.get(target.definition.symbol) ?? target.definition;
    if (!definition.isFunctionLike || definition.symbol === from.symbol) return [];
    return [
      {
        kind: 'call',
        fromSymbol: from.symbol,
        fromLabel: candidateLabel(from),
        fromFile: from.relativePath,
        toSymbol: definition.symbol,
        toLabel: candidateLabel(definition),
        toFile: definition.relativePath,
        depth,
        strength: 'exact',
        evidence: 'scip-occurrence-callsite',
        callsiteLine: target.sourceLine,
      } satisfies AnchorDiscoveryRelation,
    ];
  });

  for (const memberTarget of importedMemberCallTargets(db, from.relativePath, {
    ranges: [{ startLine: from.startLine, endLine: from.endLine }],
    excludeIndexedTargets: false,
  }).targets) {
    const target = [
      ...(sourceDefinitionIndex.get(`${memberTarget.targetFile}\0${normalizedCallableLeaf(memberTarget.calleeLeaf)}`) ??
        []),
      ...getDefinitionsForFile(db, memberTarget.targetFile).filter(
        (definition) =>
          definition.isFunctionLike && normalizedCallableLeaf(definition.leaf) === memberTarget.calleeLeaf,
      ),
    ].find(
      (definition) =>
        definition.startLine === memberTarget.targetStartLine && definition.endLine === memberTarget.targetEndLine,
    );
    if (!target || target.symbol === from.symbol) continue;
    relations.push({
      kind: 'call',
      fromSymbol: from.symbol,
      fromLabel: candidateLabel(from),
      fromFile: from.relativePath,
      toSymbol: target.symbol,
      toLabel: candidateLabel(target),
      toFile: target.relativePath,
      depth,
      strength: memberTarget.strength === 'exact' ? 'exact' : 'derived',
      evidence: 'ast-member-import-candidate',
      callsiteLine: memberTarget.line,
    });
  }

  for (const site of getSourceFacts(db, from.relativePath)?.callSites ?? []) {
    if (site.line < from.startLine || site.line > from.endLine || site.memberAccess) continue;
    const targets = (
      sourceDefinitionIndex.get(`${from.relativePath}\0${normalizedCallableLeaf(site.calleeLeaf)}`) ?? []
    ).filter((definition) => definition.symbol !== from.symbol);
    if (targets.length !== 1) continue;
    const target = targets[0]!;
    relations.push({
      kind: 'call',
      fromSymbol: from.symbol,
      fromLabel: candidateLabel(from),
      fromFile: from.relativePath,
      toSymbol: target.symbol,
      toLabel: candidateLabel(target),
      toFile: target.relativePath,
      depth,
      strength: 'derived',
      evidence: 'ast-callsite',
      callsiteLine: site.line,
    });
  }
  return deduplicateRelations(relations).sort(compareRelations);
}

function firstCallsiteLine(db: ScipDatabase, from: IndexedDefinition, target: IndexedDefinition): number | null {
  const targetLeaf = normalizedCallableLeaf(target.leaf);
  return (
    getSourceFacts(db, from.relativePath)?.callSites.find(
      (callsite) =>
        callsite.line >= from.startLine &&
        callsite.line <= from.endLine &&
        normalizedCallableLeaf(callsite.calleeLeaf) === targetLeaf,
    )?.line ?? null
  );
}

function astCallsiteConfirmsTarget(
  db: ScipDatabase,
  from: IndexedDefinition,
  target: IndexedDefinition,
  callsiteLine: number | undefined,
): boolean {
  if (callsiteLine === undefined) return false;
  const targetLeaf = normalizedCallableLeaf(target.leaf);
  return (
    getSourceFacts(db, from.relativePath)?.callSites.some(
      (callsite) => callsite.line === callsiteLine && normalizedCallableLeaf(callsite.calleeLeaf) === targetLeaf,
    ) ?? false
  );
}

function normalizedCallableLeaf(value: string): string {
  return value.replace(/^#/u, '').replace(/\(\)$/u, '');
}

function connectedRootGroups(
  neighborhoods: readonly RootNeighborhood[],
  roots: readonly AnchorDiscoveryCandidate[],
  mutableCandidates: ReadonlyMap<string, MutableCandidate>,
  frequencies: ReadonlyMap<string, number>,
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
): AnchorDiscoveryGroup[] {
  const rootIndex = new Map(roots.map((root, index) => [root.symbol, index]));
  const parents = roots.map((_, index) => index);
  const find = (index: number): number => {
    let cursor = index;
    while (parents[cursor] !== cursor) cursor = parents[cursor]!;
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = cursor;
      index = next;
    }
    return cursor;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  for (const neighborhood of neighborhoods) {
    const from = rootIndex.get(neighborhood.root.symbol);
    if (from === undefined) continue;
    for (const symbol of neighborhood.nodeSymbols) {
      const to = rootIndex.get(symbol);
      if (to !== undefined) union(from, to);
    }
  }

  const rootsByComponent = new Map<number, AnchorDiscoveryCandidate[]>();
  for (let index = 0; index < roots.length; index += 1) {
    const component = find(index);
    const members = rootsByComponent.get(component) ?? [];
    members.push(roots[index]!);
    rootsByComponent.set(component, members);
  }

  return [...rootsByComponent.values()].map((componentRoots, sequence) => {
    const rootSymbols = new Set(componentRoots.map((root) => root.symbol));
    const relations = deduplicateRelations(
      neighborhoods
        .filter((neighborhood) => rootSymbols.has(neighborhood.root.symbol))
        .flatMap((item) => item.relations),
    ).sort(compareRelations);
    const candidatesBySymbol = new Map<string, AnchorDiscoveryCandidate>(
      componentRoots.map((candidate) => [candidate.symbol, candidate]),
    );
    for (const symbol of new Set(relations.flatMap((relation) => [relation.fromSymbol, relation.toSymbol]))) {
      const candidate = mutableCandidates.get(symbol);
      if (candidate) {
        candidatesBySymbol.set(symbol, publicCandidate(candidate, frequencies));
      } else {
        const definition = definitionBySymbol.get(symbol);
        if (definition) candidatesBySymbol.set(symbol, publicUnmatchedCandidate(definition));
      }
    }
    const keyAnchors = selectKeyAnchors(componentRoots, relations, candidatesBySymbol);
    const orchestrationRootCount = componentRoots.filter((root) =>
      relations.some((relation) => relation.fromSymbol === root.symbol),
    ).length;
    const matchedTerms = [...new Set(componentRoots.flatMap((root) => root.matchedTerms))].sort();
    const renderedRelations = selectRenderedRelations(relations, keyAnchors, rootSymbols, candidatesBySymbol);
    return {
      id: `anchor-set:${sequence + 1}:${stableLocation(componentRoots[0]!)}`,
      kind: 'connected-flow',
      roots: [...componentRoots].sort(compareCandidates),
      keyAnchors,
      candidateOwnerCount: keyAnchors.length,
      omittedCandidateOwners: [],
      ownerRecoveryCommands: [],
      upstreamEntries: [],
      matchedTerms,
      relations: renderedRelations,
      relationCount: relations.length,
      orchestrationRootCount,
      omittedRelations: Math.max(0, relations.length - MAX_RENDERED_RELATIONS),
      systemMapCommand: systemMapCommand(keyAnchors, relations, matchedTerms),
    };
  });
}

/**
 * Bundle disconnected implementations only when the query itself names
 * distinct repository paths and those paths share indexed vocabulary. This
 * gives comparison tasks one batched map without inventing a causal edge
 * between the implementations.
 */
function parallelPathGroups(
  groups: readonly AnchorDiscoveryGroup[],
  frequencies: ReadonlyMap<string, number>,
  orderedTerms: readonly string[],
): AnchorDiscoveryGroup[] {
  const termOrder = new Map(orderedTerms.map((term, index) => [term, index]));
  const candidates: Array<{
    group: AnchorDiscoveryGroup;
    sharedOrder: number;
    sharedFrequency: number;
    connectedSides: number;
    orchestrationSides: number;
  }> = [];
  for (let leftIndex = 0; leftIndex < groups.length; leftIndex += 1) {
    const left = groups[leftIndex]!;
    const leftPathTerms = groupPathTerms(left);
    if (leftPathTerms.size === 0) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex += 1) {
      const right = groups[rightIndex]!;
      const rightPathTerms = groupPathTerms(right);
      const shared = [...leftPathTerms].filter((term) => rightPathTerms.has(term));
      if (shared.length === 0) continue;
      if (![...leftPathTerms].some((term) => !rightPathTerms.has(term))) continue;
      if (![...rightPathTerms].some((term) => !leftPathTerms.has(term))) continue;

      const keyAnchors = balancedParallelAnchors(left.keyAnchors, right.keyAnchors);
      if (keyAnchors.length < 2) continue;
      const relations = deduplicateRelations([...left.relations, ...right.relations]).sort(compareRelations);
      const renderedRelations = relations.slice(0, MAX_RENDERED_RELATIONS);
      const roots = uniqueCandidates([...left.roots, ...right.roots]).sort(compareCandidates);
      const matchedTerms = [...new Set([...left.matchedTerms, ...right.matchedTerms])].sort();
      const sharedPathTerms = shared.sort(
        (leftTerm, rightTerm) =>
          (termOrder.get(leftTerm) ?? Number.MAX_SAFE_INTEGER) -
            (termOrder.get(rightTerm) ?? Number.MAX_SAFE_INTEGER) || leftTerm.localeCompare(rightTerm),
      );
      const connectedSides = Number(left.relationCount > 0) + Number(right.relationCount > 0);
      const orchestrationSides =
        Number((left.orchestrationRootCount ?? 0) > 0) + Number((right.orchestrationRootCount ?? 0) > 0);
      const sharedFrequency = Math.min(
        ...sharedPathTerms.map((term) => frequencies.get(term) ?? Number.MAX_SAFE_INTEGER),
      );
      candidates.push({
        sharedOrder: Math.min(...sharedPathTerms.map((term) => termOrder.get(term) ?? Number.MAX_SAFE_INTEGER)),
        sharedFrequency,
        connectedSides,
        orchestrationSides,
        group: {
          id: `parallel-paths:${stableLocation(left.roots[0]!)}:${stableLocation(right.roots[0]!)}`,
          kind: 'parallel-paths',
          roots,
          keyAnchors,
          candidateOwnerCount: keyAnchors.length,
          omittedCandidateOwners: [],
          ownerRecoveryCommands: [],
          upstreamEntries: [...left.upstreamEntries, ...right.upstreamEntries],
          matchedTerms,
          relations: renderedRelations,
          relationCount: relations.length,
          parallelConnectedSides: connectedSides,
          parallelOrchestrationSides: orchestrationSides,
          parallelSharedPathTerms: sharedPathTerms,
          parallelSharedPathFrequency: sharedFrequency,
          orchestrationRootCount: (left.orchestrationRootCount ?? 0) + (right.orchestrationRootCount ?? 0),
          omittedRelations: Math.max(0, relations.length - renderedRelations.length),
          systemMapCommand: systemMapCommand(keyAnchors, relations, matchedTerms),
        },
      });
    }
  }
  return candidates
    .sort(
      (left, right) =>
        left.sharedFrequency - right.sharedFrequency ||
        right.orchestrationSides - left.orchestrationSides ||
        right.connectedSides - left.connectedSides ||
        left.sharedOrder - right.sharedOrder ||
        right.group.matchedTerms.length - left.group.matchedTerms.length ||
        compareGroups(left.group, right.group),
    )
    .slice(0, MAX_PARALLEL_PATH_GROUPS)
    .map((candidate) => candidate.group);
}

function groupPathTerms(group: AnchorDiscoveryGroup): Set<string> {
  return new Set(
    group.roots.flatMap((root) =>
      root.matches.filter((match) => match.sources.includes('path')).map((match) => match.term),
    ),
  );
}

function balancedParallelAnchors(
  left: readonly AnchorDiscoveryCandidate[],
  right: readonly AnchorDiscoveryCandidate[],
): AnchorDiscoveryCandidate[] {
  const selected: AnchorDiscoveryCandidate[] = [];
  for (let index = 0; selected.length < MAX_KEY_ANCHORS && (index < left.length || index < right.length); index += 1) {
    for (const candidate of [left[index], right[index]]) {
      if (!candidate || selected.some((item) => item.symbol === candidate.symbol)) continue;
      selected.push(candidate);
      if (selected.length >= MAX_KEY_ANCHORS) break;
    }
  }
  return selected;
}

interface BoundaryContinuation {
  entryDefinitions: IndexedDefinition[];
  relations: AnchorDiscoveryRelation[];
  reachedSymbols: Set<string>;
}

/**
 * Compose otherwise separate lexical/call groups only when the persisted
 * runtime graph proves a producer-to-consumer crossing and bounded call
 * evidence from that consumer reaches another group. This is selection-time
 * composition: the English query supplies vocabulary, while repository facts
 * alone decide whether two candidate sets may be presented as one flow.
 */
function crossBoundaryFlowGroups(
  db: ScipDatabase,
  index: ProjectIndex,
  groups: readonly AnchorDiscoveryGroup[],
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
  semantic: boolean,
): AnchorDiscoveryGroup[] {
  const graph = readRuntimeBoundaryGraph(db);
  if (!graph || graph.links.length === 0 || groups.length < 2) return [];
  const observations = new Map(graph.observations.map((observation) => [observation.id, observation]));
  const continuationCache = new Map<string, BoundaryContinuation>();
  const composedByIdentity = new Map<string, AnchorDiscoveryGroup>();
  const sourceGroups = [...groups].sort(compareGroups).slice(0, MAX_COMPOSITION_SOURCE_GROUPS);
  const links = graph.links
    .filter((link): link is BoundaryLink & { strength: 'exact' | 'derived' } => link.strength !== 'candidate')
    .sort(
      (left, right) =>
        relationStrengthRank(right.strength) - relationStrengthRank(left.strength) ||
        right.matchedKeyParts.length - left.matchedKeyParts.length ||
        left.id.localeCompare(right.id),
    );

  for (const sourceGroup of sourceGroups) {
    for (const link of links) {
      const from = observations.get(link.from);
      const to = observations.get(link.to);
      if (!from || !to || !groupOwnsObservation(sourceGroup, from, definitionBySymbol)) continue;
      const producerCandidate = observationCandidate(sourceGroup, from, definitionBySymbol);
      if (!producerCandidate) continue;
      const continuation =
        continuationCache.get(to.id) ??
        boundaryContinuation(db, index, to, definitionBySymbol, semantic, MAX_COMPOSITION_CALL_DEPTH);
      continuationCache.set(to.id, continuation);
      if (continuation.reachedSymbols.size === 0) continue;

      const destinationGroups = groups
        .filter(
          (candidate) =>
            candidate.id !== sourceGroup.id &&
            groupAnchorSymbols(candidate).some((symbol) => continuation.reachedSymbols.has(symbol)) &&
            candidateIdentityOverlap(producerCandidate, candidate) >= 2,
        )
        .sort(
          (left, right) =>
            candidateIdentityOverlap(producerCandidate, right) - candidateIdentityOverlap(producerCandidate, left) ||
            compareGroups(left, right),
        )
        .slice(0, MAX_COMPOSITION_DESTINATION_GROUPS);
      if (destinationGroups.length === 0) continue;
      const identity = [sourceGroup.id, from.id, ...destinationGroups.map((group) => group.id).sort()].join('\0');
      if (composedByIdentity.has(identity)) continue;

      const destinationSymbols = new Set(destinationGroups.flatMap(groupEvidenceSymbols));
      const continuationPath = shortestRelationPathToAny(
        boundaryObservationSymbol(to),
        destinationSymbols,
        continuation.relations,
      );
      if (continuationPath.length === 0) continue;
      const runtimeRelation = boundaryLinkRelation(from, to, link.joinRule, link.matchedKeyParts, link.strength);
      const allRelations = deduplicateRelations([
        runtimeRelation,
        ...continuation.relations,
        ...sourceGroup.relations,
        ...destinationGroups.flatMap((group) => group.relations),
      ]);
      const renderedRelations = selectCompositeRelations(
        [runtimeRelation, ...continuationPath],
        allRelations,
        sourceGroup,
        destinationGroups,
      );
      const roots = uniqueCandidates([producerCandidate, ...destinationGroups.flatMap((group) => group.roots)]).sort(
        compareCandidates,
      );
      const keyAnchors = uniqueCandidates([
        producerCandidate,
        ...destinationGroups.flatMap((group) => group.keyAnchors),
      ]).slice(0, MAX_COMPOSITION_KEY_ANCHORS);
      const matchedTerms = [
        ...new Set([...producerCandidate.matchedTerms, ...destinationGroups.flatMap((group) => group.matchedTerms)]),
      ].sort();
      const upstreamEntries = upstreamProducerEntries(db, index, producerCandidate, definitionBySymbol, semantic);
      if (roots.length === 0 || keyAnchors.length < 2) continue;
      composedByIdentity.set(identity, {
        id: `cross-boundary-set:${stableLocation(producerCandidate)}:${composedByIdentity.size + 1}`,
        kind: 'cross-boundary-flow',
        roots,
        keyAnchors,
        candidateOwnerCount: keyAnchors.length,
        omittedCandidateOwners: [],
        ownerRecoveryCommands: [],
        upstreamEntries,
        matchedTerms,
        relations: renderedRelations,
        relationCount: allRelations.length,
        omittedRelations: Math.max(0, allRelations.length - renderedRelations.length),
        systemMapCommand: systemMapCommand(keyAnchors, allRelations, matchedTerms),
      });
    }
  }
  const bestBySourceGroup = new Map<string, AnchorDiscoveryGroup>();
  for (const [identity, group] of composedByIdentity) {
    const sourceGroupId = identity.slice(0, identity.indexOf('\0'));
    const existing = bestBySourceGroup.get(sourceGroupId);
    if (!existing || compareGroups(group, existing) < 0) bestBySourceGroup.set(sourceGroupId, group);
  }
  return [...bestBySourceGroup.values()];
}

function groupOwnsObservation(
  group: AnchorDiscoveryGroup,
  observation: BoundaryObservation,
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
): boolean {
  const symbols = new Set(groupEvidenceSymbols(group));
  if (observation.owner.symbol && symbols.has(observation.owner.symbol)) return true;
  return [...symbols]
    .map((symbol) => definitionBySymbol.get(symbol))
    .some(
      (definition) =>
        definition?.relativePath === observation.source.file &&
        definition.startLine <= observation.source.startLine &&
        definition.endLine >= observation.source.endLine,
    );
}

function observationCandidate(
  group: AnchorDiscoveryGroup,
  observation: BoundaryObservation,
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
): AnchorDiscoveryCandidate | null {
  const candidates = uniqueCandidates([...group.roots, ...group.keyAnchors]);
  if (observation.owner.symbol) {
    const exact = candidates.find((candidate) => candidate.symbol === observation.owner.symbol);
    if (exact) return exact;
  }
  return (
    candidates.find((candidate) => {
      const definition = definitionBySymbol.get(candidate.symbol);
      return (
        definition?.relativePath === observation.source.file &&
        definition.startLine <= observation.source.startLine &&
        definition.endLine >= observation.source.endLine
      );
    }) ?? null
  );
}

function groupEvidenceSymbols(group: AnchorDiscoveryGroup): string[] {
  return [
    ...new Set([
      ...group.roots.map((root) => root.symbol),
      ...group.keyAnchors.map((anchor) => anchor.symbol),
      ...group.relations.flatMap((relation) => [relation.fromSymbol, relation.toSymbol]),
    ]),
  ];
}

function groupAnchorSymbols(group: AnchorDiscoveryGroup): string[] {
  return [...new Set([...group.roots, ...group.keyAnchors].map((candidate) => candidate.symbol))];
}

function candidateIdentityOverlap(left: AnchorDiscoveryCandidate, right: AnchorDiscoveryGroup): number {
  const leftTerms = normalizedWordSet(left.leaf);
  const rightIdentities = [...right.roots, ...right.keyAnchors].map((candidate) => normalizedWordSet(candidate.leaf));
  let maximum = 0;
  for (const rightTerms of rightIdentities) {
    let overlap = 0;
    for (const term of leftTerms) {
      if (rightTerms.has(term)) overlap += 1;
    }
    maximum = Math.max(maximum, overlap);
  }
  return maximum;
}

function upstreamProducerEntries(
  db: ScipDatabase,
  index: ProjectIndex,
  producer: AnchorDiscoveryCandidate,
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
  semantic: boolean,
): AnchorDiscoveryUpstreamEntry[] {
  const definition = definitionBySymbol.get(producer.symbol);
  if (!definition?.isFunctionLike) return [];
  const callerFiles = index.callerFileMap([definition], { semantic, sourceFallback: true }).get(definition.symbolId);
  if (!callerFiles) return [];
  const producerTerms = normalizedWordSet(producer.leaf);
  return [...callerFiles]
    .filter((file) => file !== producer.file && classifyFile(file) !== 'test')
    .flatMap((file) => {
      const facts = getSourceFacts(db, file);
      return (facts?.callSites ?? [])
        .filter((site) => normalizedCallableLeaf(site.calleeLeaf) === normalizedCallableLeaf(producer.leaf))
        .flatMap((site) => {
          const owner = (facts?.callables ?? [])
            .filter((callable) => callable.startLine <= site.line && callable.endLine >= site.line)
            .sort(
              (left, right) =>
                left.endLine - left.startLine - (right.endLine - right.startLine) || left.startLine - right.startLine,
            )[0];
          if (!owner) return [];
          const overlap = [...normalizedWordSet(owner.name)].filter((term) => producerTerms.has(term)).length;
          return overlap >= 2
            ? [
                {
                  name: owner.name,
                  file,
                  line: owner.startLine,
                  endLine: owner.endLine,
                  callsiteLine: site.line,
                  overlap,
                },
              ]
            : [];
        });
    })
    .sort(
      (left, right) => right.overlap - left.overlap || left.file.localeCompare(right.file) || left.line - right.line,
    )
    .slice(0, 1)
    .map(({ name, file, line, endLine, callsiteLine }) => ({ name, file, line, endLine, callsiteLine }));
}

function boundaryContinuation(
  db: ScipDatabase,
  index: ProjectIndex,
  observation: BoundaryObservation,
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
  semantic: boolean,
  maxDepth: number,
): BoundaryContinuation {
  const entries = boundaryEntryDefinitions(db, observation, definitionBySymbol);
  const relations: AnchorDiscoveryRelation[] = entries.map(({ definition, evidence, line }) => ({
    kind: 'call',
    fromSymbol: boundaryObservationSymbol(observation),
    fromLabel: boundaryObservationLabel(observation),
    fromFile: observation.source.file,
    toSymbol: definition.symbol,
    toLabel: shortenSymbol(definition.symbol),
    toFile: definition.relativePath,
    depth: 1,
    strength: evidence === 'scip-occurrence-callsite' ? 'exact' : 'derived',
    evidence,
    callsiteLine: line,
  }));
  const sourceConstructEntries = boundarySourceConstructEntries(db, observation);
  relations.push(...sourceConstructEntries.relations);
  const entryDefinitions = uniqueDefinitions([
    ...entries.map((entry) => entry.definition),
    ...sourceConstructEntries.definitions,
  ]);
  let frontier = entryDefinitions;
  const visited = new Set(frontier.map((definition) => definition.symbol));
  for (let depth = 2; depth <= maxDepth + 1 && frontier.length > 0; depth += 1) {
    const calleeMap = index.calleeMap(frontier, { additive: false, semantic });
    const next = new Map<string, IndexedDefinition>();
    for (const definition of frontier) {
      const outgoing = calleeRelations(
        db,
        definition,
        calleeMap.get(definition.symbolId) ?? [],
        definitionBySymbol,
        depth,
      );
      relations.push(...outgoing);
      for (const relation of outgoing) {
        const target = definitionBySymbol.get(relation.toSymbol);
        if (target?.isFunctionLike && !visited.has(target.symbol)) next.set(target.symbol, target);
      }
    }
    frontier = [...next.values()];
    for (const definition of frontier) visited.add(definition.symbol);
  }
  return {
    entryDefinitions,
    relations: deduplicateRelations(relations),
    reachedSymbols: new Set([
      ...entryDefinitions.map((definition) => definition.symbol),
      ...relations.flatMap((relation) => [relation.fromSymbol, relation.toSymbol]),
    ]),
  };
}

function boundaryEntryDefinitions(
  db: ScipDatabase,
  observation: BoundaryObservation,
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
): Array<{
  definition: IndexedDefinition;
  evidence: 'ast-callsite' | 'scip-occurrence-callsite';
  line: number;
}> {
  const owner = observation.owner.symbol ? definitionBySymbol.get(observation.owner.symbol) : undefined;
  if (owner?.isFunctionLike && !isModuleLikeSymbol(owner.symbol)) {
    return [{ definition: owner, evidence: 'scip-occurrence-callsite', line: observation.source.startLine }];
  }

  const sourceLines = getSourceLines(db, observation.source.file);
  const construct = behaviorConstructRange(db, observation.source.file, 0, Math.max(0, sourceLines.length - 1), [
    observation.source.startLine,
  ]);

  const exact = scipOccurrenceCallTargetsForRange(
    db,
    observation.source.file,
    construct.startLine,
    construct.endLine,
  ).targets.map((target) => ({
    definition: target.definition,
    evidence: 'scip-occurrence-callsite' as const,
    line: target.sourceLine,
  }));

  const facts = getSourceFacts(db, observation.source.file);
  const leafIndex = getGlobalLeafIndex(db);
  const derived = (facts?.callSites ?? []).flatMap((site) => {
    if (site.line < construct.startLine || site.line > construct.endLine) return [];
    const candidates = sameLanguageCandidates(observation.source.file, leafIndex.get(site.calleeLeaf) ?? []);
    const selected = pickAstCallCandidate(
      db,
      observation.source.file,
      candidates,
      site.memberAccess,
      site.calleeQualifier,
    );
    const definition = selected ? definitionBySymbol.get(selected.symbol) : undefined;
    return definition?.isFunctionLike ? [{ definition, evidence: 'ast-callsite' as const, line: site.line }] : [];
  });
  return uniqueBoundaryEntries([...exact, ...derived]);
}

function boundarySourceConstructEntries(
  db: ScipDatabase,
  observation: BoundaryObservation,
): { definitions: IndexedDefinition[]; relations: AnchorDiscoveryRelation[] } {
  const sourceLines = getSourceLines(db, observation.source.file);
  const observationConstruct = behaviorConstructRange(
    db,
    observation.source.file,
    0,
    Math.max(0, sourceLines.length - 1),
    [observation.source.startLine],
  );
  const memberTargets = importedMemberCallTargets(db, observation.source.file, {
    ranges: [observationConstruct],
    excludeIndexedTargets: false,
  }).targets;
  const definitions: IndexedDefinition[] = [];
  const relations: AnchorDiscoveryRelation[] = [];
  for (const target of memberTargets) {
    const constructSymbol = `source-construct:${target.targetFile}:${target.targetStartLine}:${target.targetEndLine}:${target.calleeLeaf}`;
    relations.push({
      kind: 'call',
      fromSymbol: boundaryObservationSymbol(observation),
      fromLabel: boundaryObservationLabel(observation),
      fromFile: observation.source.file,
      toSymbol: constructSymbol,
      toLabel: target.calleeLeaf,
      toFile: target.targetFile,
      depth: 1,
      strength: 'derived',
      evidence: 'ast-member-import-candidate',
      callsiteLine: target.line,
    });
    const exactTargets = scipOccurrenceCallTargetsForRange(
      db,
      target.targetFile,
      target.targetStartLine,
      target.targetEndLine,
    ).targets;
    for (const exact of exactTargets) {
      definitions.push(exact.definition);
      relations.push({
        kind: 'call',
        fromSymbol: constructSymbol,
        fromLabel: target.calleeLeaf,
        fromFile: target.targetFile,
        toSymbol: exact.definition.symbol,
        toLabel: shortenSymbol(exact.definition.symbol),
        toFile: exact.definition.relativePath,
        depth: 2,
        strength: 'exact',
        evidence: 'scip-occurrence-callsite',
        callsiteLine: exact.sourceLine,
      });
    }
  }
  return { definitions: uniqueDefinitions(definitions), relations: deduplicateRelations(relations) };
}

function uniqueBoundaryEntries<T extends { definition: IndexedDefinition }>(entries: readonly T[]): T[] {
  return [...new Map(entries.map((entry) => [entry.definition.symbol, entry])).values()];
}

function uniqueDefinitions(definitions: readonly IndexedDefinition[]): IndexedDefinition[] {
  return [...new Map(definitions.map((definition) => [definition.symbol, definition])).values()];
}

function boundaryObservationSymbol(observation: BoundaryObservation): string {
  return observation.owner.symbol ?? observation.id;
}

function boundaryObservationLabel(observation: BoundaryObservation): string {
  return observation.owner.name ?? `${observation.source.file}:${observation.source.startLine + 1}`;
}

function boundaryLinkRelation(
  from: BoundaryObservation,
  to: BoundaryObservation,
  joinRule: string,
  keyParts: readonly { name: string; value: string }[],
  strength: 'exact' | 'derived',
): AnchorDiscoveryRelation {
  return {
    kind: 'runtime-boundary',
    fromSymbol: boundaryObservationSymbol(from),
    fromLabel: boundaryObservationLabel(from),
    fromFile: from.source.file,
    toSymbol: boundaryObservationSymbol(to),
    toLabel: boundaryObservationLabel(to),
    toFile: to.source.file,
    depth: 1,
    strength,
    evidence: `runtime-boundary:${joinRule}`,
    callsiteLine: from.source.startLine,
    runtimeBoundaryKey: keyParts.map((part) => `${part.name}=${part.value}`).join(' '),
  };
}

function shortestRelationPathToAny(
  fromSymbol: string,
  toSymbols: ReadonlySet<string>,
  relations: readonly AnchorDiscoveryRelation[],
): AnchorDiscoveryRelation[] {
  const outgoing = new Map<string, AnchorDiscoveryRelation[]>();
  for (const relation of relations) {
    const bucket = outgoing.get(relation.fromSymbol) ?? [];
    bucket.push(relation);
    outgoing.set(relation.fromSymbol, bucket);
  }
  const queue: Array<{ symbol: string; path: AnchorDiscoveryRelation[] }> = [{ symbol: fromSymbol, path: [] }];
  const visited = new Set([fromSymbol]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.path.length > 0 && toSymbols.has(current.symbol)) return current.path;
    for (const relation of (outgoing.get(current.symbol) ?? []).sort(compareRelations)) {
      if (visited.has(relation.toSymbol)) continue;
      visited.add(relation.toSymbol);
      queue.push({ symbol: relation.toSymbol, path: [...current.path, relation] });
    }
  }
  return [];
}

function selectCompositeRelations(
  requiredPath: readonly AnchorDiscoveryRelation[],
  relations: readonly AnchorDiscoveryRelation[],
  source: AnchorDiscoveryGroup,
  destinations: readonly AnchorDiscoveryGroup[],
): AnchorDiscoveryRelation[] {
  const selected = deduplicateRelations(requiredPath);
  const relevantSymbols = new Set(
    [source, ...destinations].flatMap((group) => [
      ...groupEvidenceSymbols(group),
      ...group.keyAnchors.map((a) => a.symbol),
    ]),
  );
  for (const relation of relations) {
    if (selected.length >= MAX_RENDERED_RELATIONS) break;
    if (!relevantSymbols.has(relation.fromSymbol) && !relevantSymbols.has(relation.toSymbol)) continue;
    if (
      selected.some(
        (existing) => existing.fromSymbol === relation.fromSymbol && existing.toSymbol === relation.toSymbol,
      )
    )
      continue;
    selected.push(relation);
  }
  return selected.slice(0, MAX_RENDERED_RELATIONS);
}

/**
 * Reverse the already-established call evidence around the best lexical
 * owners. A connected-flow group answers "what happens after this owner?";
 * a shared-callee-owner surface answers the complementary question "which
 * callable owners converge on the same callees?". The CLI does not assert
 * that those callees are effects; it exposes mechanically related sibling
 * owners so an exhaustive operation question is not reduced to one forward
 * path.
 */
function effectOwnerGroups(
  db: ScipDatabase,
  index: ProjectIndex,
  neighborhoods: readonly RootNeighborhood[],
  mutableCandidates: ReadonlyMap<string, MutableCandidate>,
  frequencies: ReadonlyMap<string, number>,
  definitions: readonly IndexedDefinition[],
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
  semantic: boolean,
): AnchorDiscoveryGroup[] {
  const directByRoot = neighborhoods
    // Reverse owner recovery requires compiler identity for the caller. A
    // parser-delimited local construct has exact source ownership but no
    // stable symbol that callerFileMap can reverse; its forward relations are
    // already preserved in connected-flow groups.
    .filter((neighborhood) => !neighborhood.root.symbol.startsWith(SOURCE_CONSTRUCT_SYMBOL_PREFIX))
    .map((neighborhood) => ({
      root: neighborhood.root,
      relations: neighborhood.relations.filter(
        (relation) => relation.depth === 1 && relation.fromSymbol === neighborhood.root.symbol,
      ),
    }));
  const components = denseRootComponents(directByRoot);

  return components.flatMap((component, sequence) => {
    const componentRootSymbols = new Set(component.map((item) => item.root.symbol));
    const directTargetCounts = new Map<string, number>();
    for (const item of component) {
      for (const target of new Set(item.relations.map((relation) => relation.toSymbol))) {
        directTargetCounts.set(target, (directTargetCounts.get(target) ?? 0) + 1);
      }
    }
    const effectDefinitions = [...directTargetCounts]
      .filter(([, callerCount]) => callerCount >= 2)
      .sort(
        ([leftSymbol, leftCount], [rightSymbol, rightCount]) =>
          rightCount - leftCount ||
          compareEffectTargets(leftSymbol, rightSymbol, mutableCandidates, frequencies, definitionBySymbol),
      )
      .map(([symbol]) => definitionBySymbol.get(symbol))
      .filter((definition): definition is IndexedDefinition => definition?.isFunctionLike === true)
      .slice(0, MAX_EFFECT_TARGETS);
    if (effectDefinitions.length === 0) return [];

    const callerFilesByEffect = index.callerFileMap(effectDefinitions, {
      semantic,
      sourceFallback: true,
    });
    const candidateCallerFiles = new Set<string>();
    for (const effect of effectDefinitions) {
      candidateCallerFiles.add(effect.relativePath);
      for (const file of callerFilesByEffect.get(effect.symbolId) ?? []) candidateCallerFiles.add(file);
    }
    const candidateCallers = definitions
      .filter((definition) => definition.isFunctionLike && candidateCallerFiles.has(definition.relativePath))
      .sort(compareCallerDefinitions)
      .slice(0, MAX_EFFECT_CALLER_DEFINITIONS);
    const calleeMap = index.calleeMap(candidateCallers, { additive: false, semantic });
    const effectSymbols = new Set(effectDefinitions.map((definition) => definition.symbol));
    const candidateRelations = deduplicateRelations(
      candidateCallers.flatMap((caller) =>
        calleeRelations(db, caller, calleeMap.get(caller.symbolId) ?? [], definitionBySymbol, 1, effectSymbols).filter(
          (relation) => effectSymbols.has(relation.toSymbol),
        ),
      ),
    );
    const targetsByCaller = new Map<string, Set<string>>();
    for (const relation of candidateRelations) {
      const targets = targetsByCaller.get(relation.fromSymbol) ?? new Set<string>();
      targets.add(relation.toSymbol);
      targetsByCaller.set(relation.fromSymbol, targets);
    }
    const ownerSymbols = new Set(
      [...targetsByCaller]
        .filter(([symbol, targets]) => targets.size >= 2 || componentRootSymbols.has(symbol))
        .map(([symbol]) => symbol),
    );
    const componentRelations = candidateRelations.filter((relation) => ownerSymbols.has(relation.fromSymbol));
    if (ownerSymbols.size < 2 || componentRelations.length === 0) return [];

    const targetSymbols = new Set(componentRelations.map((relation) => relation.toSymbol));
    const roots = [...targetSymbols]
      .map((symbol) => candidateForSymbol(symbol, mutableCandidates, frequencies, definitionBySymbol))
      .filter((candidate): candidate is AnchorDiscoveryCandidate => candidate !== null)
      .sort(compareCandidates);
    const callerCandidates = [...ownerSymbols]
      .map((symbol) => candidateForSymbol(symbol, mutableCandidates, frequencies, definitionBySymbol))
      .filter((candidate): candidate is AnchorDiscoveryCandidate => candidate !== null);
    const rankedOwners = rankEffectOwnerAnchors(callerCandidates, componentRelations);
    const keyAnchors = rankedOwners.slice(0, MAX_EFFECT_KEY_ANCHORS);
    const omittedCandidateOwners = rankedOwners.slice(MAX_EFFECT_KEY_ANCHORS);
    if (roots.length === 0 || keyAnchors.length === 0) return [];
    const matchedTerms = [
      ...new Set([
        ...roots.flatMap((root) => root.matchedTerms),
        ...component.flatMap((item) => item.root.matchedTerms),
      ]),
    ].sort();
    const renderedRelations = selectEffectRelations(componentRelations, keyAnchors);
    return [
      {
        id: `effect-owner-set:${sequence + 1}:${stableLocation(roots[0]!)}`,
        kind: 'shared-callee-owners' as const,
        roots,
        keyAnchors,
        candidateOwnerCount: rankedOwners.length,
        omittedCandidateOwners,
        ownerRecoveryCommands: chunkedSystemMapCommands(omittedCandidateOwners, MAX_EFFECT_KEY_ANCHORS),
        upstreamEntries: [],
        matchedTerms,
        relations: renderedRelations,
        relationCount: componentRelations.length,
        omittedRelations: Math.max(0, componentRelations.length - renderedRelations.length),
        systemMapCommand: systemMapCommand(keyAnchors, componentRelations, matchedTerms),
      },
    ];
  });
}

function denseRootComponents(
  roots: ReadonlyArray<{ root: AnchorDiscoveryCandidate; relations: AnchorDiscoveryRelation[] }>,
): Array<Array<{ root: AnchorDiscoveryCandidate; relations: AnchorDiscoveryRelation[] }>> {
  const parents = roots.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!;
      index = parents[index]!;
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const targets = roots.map((item) => new Set(item.relations.map((relation) => relation.toSymbol)));
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      let shared = 0;
      for (const target of targets[left] ?? []) {
        if ((targets[right] ?? new Set<string>()).has(target)) shared += 1;
        if (shared >= 2) break;
      }
      if (shared >= 2) union(left, right);
    }
  }
  const components = new Map<number, Array<{ root: AnchorDiscoveryCandidate; relations: AnchorDiscoveryRelation[] }>>();
  for (let index = 0; index < roots.length; index += 1) {
    const component = find(index);
    const members = components.get(component) ?? [];
    members.push(roots[index]!);
    components.set(component, members);
  }
  return [...components.values()].filter((component) => component.length >= 2);
}

function compareEffectTargets(
  leftSymbol: string,
  rightSymbol: string,
  mutableCandidates: ReadonlyMap<string, MutableCandidate>,
  frequencies: ReadonlyMap<string, number>,
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
): number {
  const left = candidateForSymbol(leftSymbol, mutableCandidates, frequencies, definitionBySymbol);
  const right = candidateForSymbol(rightSymbol, mutableCandidates, frequencies, definitionBySymbol);
  if (!left) return right ? 1 : leftSymbol.localeCompare(rightSymbol);
  if (!right) return -1;
  return compareCandidates(left, right);
}

function compareCallerDefinitions(left: IndexedDefinition, right: IndexedDefinition): number {
  return (
    fileKindRank(classifyFile(left.relativePath)) - fileKindRank(classifyFile(right.relativePath)) ||
    left.relativePath.localeCompare(right.relativePath) ||
    left.startLine - right.startLine
  );
}

function candidateForSymbol(
  symbol: string,
  mutableCandidates: ReadonlyMap<string, MutableCandidate>,
  frequencies: ReadonlyMap<string, number>,
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
): AnchorDiscoveryCandidate | null {
  const matched = mutableCandidates.get(symbol);
  if (matched) return publicCandidate(matched, frequencies);
  const definition = definitionBySymbol.get(symbol);
  return definition ? publicUnmatchedCandidate(definition) : null;
}

function rankEffectOwnerAnchors(
  callers: readonly AnchorDiscoveryCandidate[],
  relations: readonly AnchorDiscoveryRelation[],
): AnchorDiscoveryCandidate[] {
  const callersByTarget = new Map<string, Set<string>>();
  for (const relation of relations) {
    const targetCallers = callersByTarget.get(relation.toSymbol) ?? new Set<string>();
    targetCallers.add(relation.fromSymbol);
    callersByTarget.set(relation.toSymbol, targetCallers);
  }
  const callerScores = new Map<string, number>();
  for (const relation of relations) {
    const convergence = callersByTarget.get(relation.toSymbol)?.size ?? 1;
    callerScores.set(relation.fromSymbol, (callerScores.get(relation.fromSymbol) ?? 0) + convergence * convergence);
  }
  return [...callers].sort(
    (left, right) =>
      Number(left.leaf.startsWith('#')) - Number(right.leaf.startsWith('#')) ||
      right.identityMatchedTerms.length - left.identityMatchedTerms.length ||
      (callerScores.get(right.symbol) ?? 0) - (callerScores.get(left.symbol) ?? 0) ||
      compareCandidates(left, right),
  );
}

function selectEffectRelations(
  relations: readonly AnchorDiscoveryRelation[],
  keyAnchors: readonly AnchorDiscoveryCandidate[],
): AnchorDiscoveryRelation[] {
  const keyRank = new Map(keyAnchors.map((anchor, index) => [anchor.symbol, index]));
  const byOwner = keyAnchors.map((anchor) =>
    relations.filter((relation) => relation.fromSymbol === anchor.symbol).sort(compareRelations),
  );
  const selected: AnchorDiscoveryRelation[] = [];
  let round = 0;
  while (selected.length < MAX_RENDERED_RELATIONS && byOwner.some((ownerRelations) => round < ownerRelations.length)) {
    for (const ownerRelations of byOwner) {
      const relation = ownerRelations[round];
      if (relation) selected.push(relation);
      if (selected.length >= MAX_RENDERED_RELATIONS) break;
    }
    round += 1;
  }
  return selected.sort(
    (left, right) => keyRank.get(left.fromSymbol)! - keyRank.get(right.fromSymbol)! || compareRelations(left, right),
  );
}

function selectRenderedRelations(
  relations: readonly AnchorDiscoveryRelation[],
  keyAnchors: readonly AnchorDiscoveryCandidate[],
  rootSymbols: ReadonlySet<string>,
  candidatesBySymbol: ReadonlyMap<string, AnchorDiscoveryCandidate>,
): AnchorDiscoveryRelation[] {
  const keyRank = new Map(keyAnchors.map((anchor, index) => [anchor.symbol, index]));
  const outgoingCounts = new Map<string, number>();
  for (const relation of relations) {
    outgoingCounts.set(relation.fromSymbol, (outgoingCounts.get(relation.fromSymbol) ?? 0) + 1);
  }
  const selected = [...relations]
    .sort((left, right) => {
      const priority = (relation: AnchorDiscoveryRelation): number => {
        let score = 0;
        if (keyRank.has(relation.fromSymbol)) score += 100;
        if (rootSymbols.has(relation.toSymbol)) score += 60;
        score += Math.min(40, (outgoingCounts.get(relation.toSymbol) ?? 0) * 8);
        if ((candidatesBySymbol.get(relation.toSymbol)?.matchedTerms.length ?? 0) > 0) score += 25;
        if (relation.fromFile !== relation.toFile) score += 15;
        if (relation.strength === 'exact') score += 5;
        return score;
      };
      return priority(right) - priority(left) || compareRelations(left, right);
    })
    .slice(0, MAX_RENDERED_RELATIONS);
  return selected.sort(
    (left, right) =>
      (keyRank.get(left.fromSymbol) ?? MAX_KEY_ANCHORS) - (keyRank.get(right.fromSymbol) ?? MAX_KEY_ANCHORS) ||
      left.depth - right.depth ||
      (left.callsiteLine ?? Number.MAX_SAFE_INTEGER) - (right.callsiteLine ?? Number.MAX_SAFE_INTEGER) ||
      compareRelations(left, right),
  );
}

function publicUnmatchedCandidate(definition: IndexedDefinition): AnchorDiscoveryCandidate {
  return {
    symbol: definition.symbol,
    label: candidateLabel(definition),
    leaf: definition.leaf,
    file: definition.relativePath,
    line: definition.startLine,
    endLine: definition.endLine,
    kind: definition.isFunctionLike ? 'callable' : definition.isTypeLike ? 'type' : 'symbol',
    fileKind: classifyFile(definition.relativePath),
    matches: [],
    focusLocations: [],
    matchedTerms: [],
    symbolMatchedTerms: [],
    symbolPhraseLength: 0,
    identityMatchedTerms: [],
    rarity: 0,
    symbolRarity: 0,
  };
}

function selectKeyAnchors(
  roots: readonly AnchorDiscoveryCandidate[],
  relations: readonly AnchorDiscoveryRelation[],
  candidatesBySymbol: ReadonlyMap<string, AnchorDiscoveryCandidate>,
): AnchorDiscoveryCandidate[] {
  const rankedRoots = [...roots].sort(compareCandidates);
  const selected: AnchorDiscoveryCandidate[] = [];
  const outgoingCounts = new Map<string, number>();
  for (const relation of relations) {
    outgoingCounts.set(relation.fromSymbol, (outgoingCounts.get(relation.fromSymbol) ?? 0) + 1);
  }
  const coveredTerms = new Set<string>();
  const coveredSymbolTerms = new Set<string>();
  const add = (candidate: AnchorDiscoveryCandidate | undefined): void => {
    if (!candidate || selected.some((item) => item.symbol === candidate.symbol)) return;
    selected.push(candidate);
    for (const term of candidate.matchedTerms) coveredTerms.add(term);
    for (const term of candidate.symbolMatchedTerms) coveredSymbolTerms.add(term);
  };
  const orchestratingRoots = rankedRoots.filter(
    (root) => root.symbolPhraseLength >= 2 && (outgoingCounts.get(root.symbol) ?? 0) >= 2,
  );
  while (selected.length < Math.min(2, MAX_KEY_ANCHORS)) {
    const root = orchestratingRoots
      .filter((candidate) => !selected.some((item) => item.symbol === candidate.symbol))
      .sort(
        (left, right) =>
          right.symbolMatchedTerms.filter((term) => !coveredSymbolTerms.has(term)).length -
            left.symbolMatchedTerms.filter((term) => !coveredSymbolTerms.has(term)).length ||
          right.symbolPhraseLength - left.symbolPhraseLength ||
          (outgoingCounts.get(right.symbol) ?? 0) - (outgoingCounts.get(left.symbol) ?? 0) ||
          compareSymbolCandidates(left, right),
      )[0];
    if (!root) break;
    if (selected.length > 0 && root.symbolMatchedTerms.every((term) => coveredSymbolTerms.has(term))) break;
    add(root);
  }
  add(rankedRoots[0]);

  if (selected.length >= 2) {
    const bridgePath = shortestUndirectedRelationPath(
      selected[0]!.symbol,
      selected[1]!.symbol,
      relations,
      candidatesBySymbol,
    );
    for (const symbol of bridgePath?.slice(1, -1) ?? []) {
      if (selected.length >= MAX_KEY_ANCHORS) break;
      add(candidatesBySymbol.get(symbol));
    }

    // Preserve one query-matched sibling from an orchestration step already on
    // the bridge. A shortest path necessarily chooses only one branch, but the
    // adjacent branch can be the durable write or emitted effect that makes the
    // handoff complete. Keep this bounded and identity-driven: no behavior or
    // English intent is inferred here.
    if (selected.length < MAX_KEY_ANCHORS) {
      const selectedSymbols = new Set(selected.map((candidate) => candidate.symbol));
      const cohortParents = new Set(
        relations
          .filter(
            (relation) =>
              relation.depth === 1 &&
              selectedSymbols.has(relation.fromSymbol) &&
              selectedSymbols.has(relation.toSymbol),
          )
          .map((relation) => relation.fromSymbol),
      );
      const sibling = relations
        .filter(
          (relation) =>
            relation.depth === 1 && cohortParents.has(relation.fromSymbol) && !selectedSymbols.has(relation.toSymbol),
        )
        .map((relation) => ({ relation, candidate: candidatesBySymbol.get(relation.toSymbol) }))
        .filter(
          (item): item is { relation: AnchorDiscoveryRelation; candidate: AnchorDiscoveryCandidate } =>
            item.candidate !== undefined &&
            item.candidate.symbolPhraseLength >= 2 &&
            item.candidate.symbolMatchedTerms.length >= 2,
        )
        .sort(
          (left, right) =>
            (outgoingCounts.get(left.relation.fromSymbol) ?? 0) -
              (outgoingCounts.get(right.relation.fromSymbol) ?? 0) ||
            compareSymbolCandidates(left.candidate, right.candidate),
        )[0]?.candidate;
      add(sibling);
    }
  } else {
    while (selected.length < Math.min(3, MAX_KEY_ANCHORS)) {
      const candidate = rankedRoots
        .filter((root) => !selected.some((item) => item.symbol === root.symbol))
        .sort(
          (left, right) =>
            right.matchedTerms.filter((term) => !coveredTerms.has(term)).length -
              left.matchedTerms.filter((term) => !coveredTerms.has(term)).length || compareCandidates(left, right),
        )[0];
      if (!candidate || candidate.matchedTerms.every((term) => coveredTerms.has(term))) break;
      add(candidate);
    }
  }

  while (selected.length >= 2 && selected.length < MAX_KEY_ANCHORS) {
    const selectedSymbols = new Set(selected.map((candidate) => candidate.symbol));
    const graphJunction = [...candidatesBySymbol.values()]
      .filter(
        (candidate) =>
          !selectedSymbols.has(candidate.symbol) &&
          (outgoingCounts.get(candidate.symbol) ?? 0) > 0 &&
          relations.some(
            (relation) => selectedSymbols.has(relation.fromSymbol) && relation.toSymbol === candidate.symbol,
          ),
      )
      .sort(
        (left, right) =>
          right.identityMatchedTerms.length - left.identityMatchedTerms.length ||
          right.symbolMatchedTerms.length - left.symbolMatchedTerms.length ||
          right.matchedTerms.length - left.matchedTerms.length ||
          (outgoingCounts.get(right.symbol) ?? 0) - (outgoingCounts.get(left.symbol) ?? 0) ||
          compareCandidates(left, right),
      )[0];
    if (!graphJunction) break;
    add(graphJunction);
  }

  if (selected.length < 2) {
    const primary = selected[0];
    const upstreamRoot = primary
      ? rankedRoots
          .filter((root) => root.symbol !== primary.symbol)
          .map((root) => ({
            root,
            path: shortestRelationPath(root.symbol, primary.symbol, relations),
          }))
          .filter((item): item is { root: AnchorDiscoveryCandidate; path: string[] } => item.path !== null)
          .sort(
            (left, right) =>
              Number(right.root.file !== primary.file) - Number(left.root.file !== primary.file) ||
              left.path.length - right.path.length ||
              compareCandidates(left.root, right.root),
          )[0]?.root
      : undefined;
    add(upstreamRoot);
  }

  return selected;
}

function shortestUndirectedRelationPath(
  fromSymbol: string,
  toSymbol: string,
  relations: readonly AnchorDiscoveryRelation[],
  candidatesBySymbol: ReadonlyMap<string, AnchorDiscoveryCandidate>,
): string[] | null {
  const adjacent = new Map<string, Set<string>>();
  for (const relation of relations) {
    const from = adjacent.get(relation.fromSymbol) ?? new Set<string>();
    from.add(relation.toSymbol);
    adjacent.set(relation.fromSymbol, from);
    const to = adjacent.get(relation.toSymbol) ?? new Set<string>();
    to.add(relation.fromSymbol);
    adjacent.set(relation.toSymbol, to);
  }
  const queue: Array<{ path: string[]; cost: number }> = [{ path: [fromSymbol], cost: 0 }];
  const bestCost = new Map([[fromSymbol, 0]]);
  while (queue.length > 0) {
    queue.sort((left, right) => left.cost - right.cost || left.path.length - right.path.length);
    const { path, cost } = queue.shift()!;
    const current = path.at(-1)!;
    if (current === toSymbol) return path;
    for (const next of adjacent.get(current) ?? []) {
      const candidate = candidatesBySymbol.get(next);
      const nodeCost =
        next === toSymbol
          ? 1
          : !candidate || candidate.matchedTerms.length === 0
            ? 9
            : candidate.symbolPhraseLength >= 2
              ? 1
              : candidate.identityMatchedTerms.length >= 2
                ? 2
                : 4;
      const nextCost = cost + nodeCost;
      if (nextCost >= (bestCost.get(next) ?? Number.POSITIVE_INFINITY)) continue;
      bestCost.set(next, nextCost);
      queue.push({ path: [...path, next], cost: nextCost });
    }
  }
  return null;
}

function shortestRelationPath(
  fromSymbol: string,
  toSymbol: string,
  relations: readonly AnchorDiscoveryRelation[],
): string[] | null {
  const outgoing = new Map<string, string[]>();
  for (const relation of relations) {
    const targets = outgoing.get(relation.fromSymbol) ?? [];
    targets.push(relation.toSymbol);
    outgoing.set(relation.fromSymbol, targets);
  }
  const queue: string[][] = [[fromSymbol]];
  const visited = new Set([fromSymbol]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path.at(-1)!;
    if (current === toSymbol) return path;
    for (const next of outgoing.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

function compareCandidates(left: AnchorDiscoveryCandidate, right: AnchorDiscoveryCandidate): number {
  return (
    right.identityMatchedTerms.length - left.identityMatchedTerms.length ||
    right.matchedTerms.length - left.matchedTerms.length ||
    right.rarity - left.rarity ||
    candidateKindRank(left.kind) - candidateKindRank(right.kind) ||
    fileKindRank(left.fileKind) - fileKindRank(right.fileKind) ||
    left.file.localeCompare(right.file) ||
    left.line - right.line
  );
}

function compareSymbolCandidates(left: AnchorDiscoveryCandidate, right: AnchorDiscoveryCandidate): number {
  return (
    right.symbolPhraseLength - left.symbolPhraseLength ||
    right.symbolMatchedTerms.length - left.symbolMatchedTerms.length ||
    candidateKindRank(left.kind) - candidateKindRank(right.kind) ||
    right.symbolRarity - left.symbolRarity ||
    compareCandidates(left, right)
  );
}

function selectTermCoverageRoots(
  candidates: readonly AnchorDiscoveryCandidate[],
  terms: readonly string[],
): AnchorDiscoveryCandidate[] {
  return terms.flatMap((term) => {
    const ranked = candidates
      .filter((candidate) => candidate.matchedTerms.includes(term))
      .sort((left, right) => compareTermCandidates(left, right, term));
    const selected: AnchorDiscoveryCandidate[] = [];
    const selectedFiles = new Set<string>();
    for (const candidate of ranked) {
      if (selectedFiles.has(candidate.file)) continue;
      selected.push(candidate);
      selectedFiles.add(candidate.file);
      if (selected.length >= MAX_TERM_COVERAGE_ROOTS) return selected;
    }
    for (const candidate of ranked) {
      if (selected.some((item) => item.symbol === candidate.symbol)) continue;
      selected.push(candidate);
      if (selected.length >= MAX_TERM_COVERAGE_ROOTS) break;
    }
    return selected;
  });
}

/**
 * A query term that names a source filename identifies a concrete repository
 * region even when the callable names use different vocabulary. Reserve a
 * bounded set of production callables from the best-matching files so graph
 * expansion can discover their behavior instead of stopping at constants or
 * documentation whose names happen to repeat more query words.
 */
function selectPathCallableRoots(
  candidates: readonly AnchorDiscoveryCandidate[],
  terms: readonly string[],
  frequencies: ReadonlyMap<string, number>,
): AnchorDiscoveryCandidate[] {
  const termSet = new Set(terms);
  const byFile = new Map<string, AnchorDiscoveryCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.kind !== 'callable') continue;
    const basename = candidate.file.slice(candidate.file.lastIndexOf('/') + 1).replace(/\.[^.]+$/u, '');
    if (![...normalizedWordSet(basename)].some((term) => termSet.has(term))) continue;
    const fileCandidates = byFile.get(candidate.file) ?? [];
    fileCandidates.push(candidate);
    byFile.set(candidate.file, fileCandidates);
  }

  return [...byFile.entries()]
    .map(([file, fileCandidates]) => {
      const basename = file.slice(file.lastIndexOf('/') + 1).replace(/\.[^.]+$/u, '');
      const sharedTerms = [...normalizedWordSet(basename)].filter((term) => termSet.has(term));
      return {
        file,
        fileCandidates,
        sharedFrequency: Math.min(...sharedTerms.map((term) => frequencies.get(term) ?? Number.MAX_SAFE_INTEGER)),
      };
    })
    .sort(
      (left, right) =>
        fileKindRank(left.fileCandidates[0]!.fileKind) - fileKindRank(right.fileCandidates[0]!.fileKind) ||
        left.sharedFrequency - right.sharedFrequency ||
        left.file.localeCompare(right.file),
    )
    .flatMap(({ fileCandidates }) => [...fileCandidates].sort(compareCandidates).slice(0, MAX_PATH_CALLABLES_PER_FILE))
    .slice(0, MAX_PATH_CALLABLE_ROOTS);
}

function compareTermCandidates(left: AnchorDiscoveryCandidate, right: AnchorDiscoveryCandidate, term: string): number {
  return (
    candidateTermSourceRank(left, term) - candidateTermSourceRank(right, term) ||
    fileKindRank(left.fileKind) - fileKindRank(right.fileKind) ||
    right.symbolPhraseLength - left.symbolPhraseLength ||
    candidateKindRank(left.kind) - candidateKindRank(right.kind) ||
    compareCandidates(left, right)
  );
}

function candidateTermSourceRank(candidate: AnchorDiscoveryCandidate, term: string): number {
  const sources = candidate.matches.find((match) => match.term === term)?.sources ?? [];
  return Math.min(...sources.map(matchSourceRank), Number.MAX_SAFE_INTEGER);
}

function uniqueCandidates(candidates: readonly AnchorDiscoveryCandidate[]): AnchorDiscoveryCandidate[] {
  return [...new Map(candidates.map((candidate) => [candidate.symbol, candidate])).values()];
}

function selectSystemMapSelectionTerms(terms: readonly string[], frequencies: ReadonlyMap<string, number>): string[] {
  const order = new Map(terms.map((term, index) => [term, index]));
  return terms
    .filter((term) => frequencies.has(term))
    .sort(
      (left, right) =>
        (frequencies.get(left) ?? Number.MAX_SAFE_INTEGER) - (frequencies.get(right) ?? Number.MAX_SAFE_INTEGER) ||
        (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER) ||
        left.localeCompare(right),
    )
    .slice(0, MAX_SYSTEM_MAP_SELECTION_TERMS);
}

function appendSystemMapSelectionTerms(command: string, terms: readonly string[]): string {
  if (terms.length === 0) return command;
  return `${command} ${terms.map((term) => `--selection-term ${shellArgument(term)}`).join(' ')}`;
}

function compareGroups(left: AnchorDiscoveryGroup, right: AnchorDiscoveryGroup): number {
  const leftSymbolTerms = new Set(left.roots.flatMap((root) => root.symbolMatchedTerms));
  const rightSymbolTerms = new Set(right.roots.flatMap((root) => root.symbolMatchedTerms));
  return (
    groupKindRank(left.kind) - groupKindRank(right.kind) ||
    groupFileKindRank(left) - groupFileKindRank(right) ||
    groupConnectivityRank(left) - groupConnectivityRank(right) ||
    (left.kind === 'parallel-paths' && right.kind === 'parallel-paths'
      ? (left.parallelSharedPathFrequency ?? Number.MAX_SAFE_INTEGER) -
          (right.parallelSharedPathFrequency ?? Number.MAX_SAFE_INTEGER) ||
        (right.parallelOrchestrationSides ?? 0) - (left.parallelOrchestrationSides ?? 0) ||
        (right.parallelSharedPathTerms?.length ?? 0) - (left.parallelSharedPathTerms?.length ?? 0)
      : 0) ||
    right.matchedTerms.length - left.matchedTerms.length ||
    Math.max(...right.roots.map((root) => root.symbolPhraseLength)) -
      Math.max(...left.roots.map((root) => root.symbolPhraseLength)) ||
    rightSymbolTerms.size - leftSymbolTerms.size ||
    compareCandidates(left.roots[0]!, right.roots[0]!) ||
    right.roots.length - left.roots.length ||
    left.relationCount - right.relationCount ||
    left.id.localeCompare(right.id)
  );
}

function groupFileKindRank(group: AnchorDiscoveryGroup): number {
  return Math.min(...group.roots.map((root) => fileKindRank(root.fileKind)));
}

function groupConnectivityRank(group: AnchorDiscoveryGroup): number {
  if (group.kind === 'parallel-paths') return 2 - (group.parallelConnectedSides ?? 0);
  if (group.kind !== 'connected-flow') return 0;
  return group.relationCount > 0 ? 0 : 1;
}

/**
 * Keep a graph-related sibling-owner surface beside a highly ranked forward
 * flow. Global ranking otherwise places every connected-flow before every
 * shared-callee-owners group, which can hide the complementary reverse view
 * outside the default result limit even when both describe the same symbols.
 *
 * This selection is repository-evidence driven: a sibling surface is promoted
 * only when its anchors or relations overlap a forward group that already made
 * the ranked shortlist. The query's English phrasing does not choose the kind.
 */
function selectDisplayedGroups(rankedGroups: readonly AnchorDiscoveryGroup[], limit: number): AnchorDiscoveryGroup[] {
  const selected = rankedGroups.slice(0, limit);
  if (limit < 2 || selected.some((group) => group.kind === 'shared-callee-owners')) return selected;

  const sharedGroups = rankedGroups.filter((group) => group.kind === 'shared-callee-owners');
  for (const flow of selected) {
    if (flow.kind === 'shared-callee-owners' || flow.kind === 'parallel-paths') continue;
    const flowSymbols = new Set(groupEvidenceSymbols(flow));
    const companion = sharedGroups
      .map((group) => ({ group, overlap: groupEvidenceOverlap(group, flowSymbols) }))
      .filter(({ overlap }) => overlap > 0)
      .sort(
        ({ group: left, overlap: leftOverlap }, { group: right, overlap: rightOverlap }) =>
          rightOverlap - leftOverlap || compareGroups(left, right),
      )[0]?.group;
    if (!companion) continue;

    let replacement = selected.length - 1;
    while (replacement >= 0 && selected[replacement] === flow) replacement -= 1;
    if (replacement < 0) return selected;
    selected[replacement] = companion;
    return [...selected].sort(compareGroups);
  }
  return selected;
}

function groupEvidenceOverlap(group: AnchorDiscoveryGroup, symbols: ReadonlySet<string>): number {
  return groupEvidenceSymbols(group).filter((symbol) => symbols.has(symbol)).length;
}

function groupKindRank(kind: AnchorDiscoveryGroup['kind']): number {
  switch (kind) {
    case 'cross-boundary-flow':
      return 0;
    case 'parallel-paths':
    case 'connected-flow':
      return 1;
    case 'shared-callee-owners':
      return 2;
  }
}

function compareRelations(left: AnchorDiscoveryRelation, right: AnchorDiscoveryRelation): number {
  return (
    left.depth - right.depth ||
    relationStrengthRank(right.strength) - relationStrengthRank(left.strength) ||
    left.fromLabel.localeCompare(right.fromLabel) ||
    left.toLabel.localeCompare(right.toLabel) ||
    (left.callsiteLine ?? Number.MAX_SAFE_INTEGER) - (right.callsiteLine ?? Number.MAX_SAFE_INTEGER)
  );
}

function compareCalleeRows(left: CalleeRow, right: CalleeRow): number {
  return (
    relationStrengthRank(calleeStrength(right.source)) - relationStrengthRank(calleeStrength(left.source)) ||
    (left.callsiteLine ?? Number.MAX_SAFE_INTEGER) - (right.callsiteLine ?? Number.MAX_SAFE_INTEGER) ||
    left.symbol.localeCompare(right.symbol)
  );
}

function deduplicateRelations(relations: readonly AnchorDiscoveryRelation[]): AnchorDiscoveryRelation[] {
  const byIdentity = new Map<string, AnchorDiscoveryRelation>();
  for (const relation of relations) {
    const key = `${relation.fromSymbol}\0${relation.toSymbol}`;
    const existing = byIdentity.get(key);
    if (!existing || compareRelations(relation, existing) < 0) byIdentity.set(key, relation);
  }
  return [...byIdentity.values()];
}

function splitWords(value: string): string[] {
  return (
    value
      .replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2')
      .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, '$1 $2')
      .match(/[\p{L}\d]+/gu) ?? []
  );
}

function longestContiguousMatch(value: string, orderedTerms: readonly string[]): number {
  const words = splitWords(value).map(canonicalWord);
  let longest = 0;
  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    for (let termIndex = 0; termIndex < orderedTerms.length; termIndex += 1) {
      let length = 0;
      while (
        wordIndex + length < words.length &&
        termIndex + length < orderedTerms.length &&
        words[wordIndex + length] === orderedTerms[termIndex + length]
      ) {
        length += 1;
      }
      longest = Math.max(longest, length);
    }
  }
  return longest;
}

function normalizedWordSet(value: string): Set<string> {
  return new Set(
    splitWords(value)
      .map(canonicalWord)
      .filter((word) => word.length >= 3),
  );
}

function canonicalWord(value: string): string {
  const word = value.toLocaleLowerCase();
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('ied')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('ed')) return undoubleFinalConsonant(word.slice(0, -2));
  if (word.length > 5 && word.endsWith('ing')) return undoubleFinalConsonant(word.slice(0, -3));
  if (word.length > 4 && word.endsWith('ers')) return word.slice(0, -1);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function undoubleFinalConsonant(value: string): string {
  if (value.length < 2) return value;
  const last = value.at(-1)!;
  const before = value.at(-2)!;
  return last === before && !'aeiou'.includes(last) ? value.slice(0, -1) : value;
}

function searchableLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

function compareMatchSources(left: AnchorDiscoveryMatchSource, right: AnchorDiscoveryMatchSource): number {
  return matchSourceRank(left) - matchSourceRank(right);
}

function matchSourceRank(source: AnchorDiscoveryMatchSource): number {
  switch (source) {
    case 'symbol':
      return 0;
    case 'path':
      return 1;
    case 'documentation':
      return 2;
    case 'source':
      return 3;
  }
}

function candidateKindRank(kind: AnchorDiscoveryCandidate['kind']): number {
  return kind === 'callable' ? 0 : kind === 'type' ? 1 : 2;
}

function fileKindRank(kind: FileKind): number {
  switch (kind) {
    case 'entry':
    case 'source':
    case 'worker':
      return 0;
    case 'barrel':
      return 1;
    case 'test':
      return 2;
  }
}

function calleeStrength(source: CalleeEvidenceSource): 'exact' | 'derived' {
  return source === 'semantic-callee' || source === 'scip-chunk' ? 'exact' : 'derived';
}

function relationStrengthRank(strength: AnchorDiscoveryRelation['strength']): number {
  return strength === 'exact' ? 2 : 1;
}

function compareLocations(left: { file: string; line: number }, right: { file: string; line: number }): number {
  return left.file.localeCompare(right.file) || left.line - right.line;
}

function stableLocation(candidate: AnchorDiscoveryCandidate): string {
  return `${candidate.file}:${candidate.line + 1}`;
}

function systemMapCommand(
  anchors: readonly AnchorDiscoveryCandidate[],
  relations: readonly AnchorDiscoveryRelation[] = [],
  matchedTerms: readonly string[] = [],
): string {
  const symbolParts = anchors.map(
    (anchor) => `--symbol ${shellArgument(`${anchor.file}:${anchor.line + 1}-${anchor.endLine + 1}`)}`,
  );
  const anchorSymbols = new Set(anchors.map((anchor) => anchor.symbol));
  const focusParts = anchors.flatMap((anchor) =>
    anchor.endLine - anchor.line >= 200
      ? mapFocusLocations(anchor, relations, matchedTerms, anchorSymbols).map(
          (location) => `--focus-at ${shellArgument(`${location.file}:${location.line + 1}`)}`,
        )
      : [],
  );
  // Anchor discovery groups are built from call and runtime-boundary evidence.
  // Keep the first abstraction on those causal relations instead of admitting
  // generic imports and references that can dwarf the paths which justified
  // the anchors. Other relation families remain explicitly recoverable.
  return `scip-query system-map ${[
    ...symbolParts,
    ...focusParts,
    '--relation call',
    '--relation runtime-boundary',
  ].join(' ')}`;
}

function mapFocusLocations(
  anchor: AnchorDiscoveryCandidate,
  relations: readonly AnchorDiscoveryRelation[],
  matchedTerms: readonly string[],
  anchorSymbols: ReadonlySet<string>,
): Array<{ file: string; line: number }> {
  const queryTerms = new Set(matchedTerms);
  const relationLocations = relations
    .filter(
      (relation) =>
        relation.fromSymbol === anchor.symbol &&
        relation.callsiteLine !== null &&
        relation.callsiteLine >= anchor.line &&
        relation.callsiteLine <= anchor.endLine,
    )
    .map((relation) => ({
      file: anchor.file,
      line: relation.callsiteLine!,
      connectsAnchor: anchorSymbols.has(relation.toSymbol),
      overlap: new Set(
        splitWords(relationLeaf(relation.toLabel))
          .map(canonicalWord)
          .filter((term) => queryTerms.has(term)),
      ).size,
      strength: relation.strength,
    }))
    .filter((location) => location.overlap > 0)
    .sort(
      (left, right) =>
        Number(right.connectsAnchor) - Number(left.connectsAnchor) ||
        right.overlap - left.overlap ||
        left.line - right.line ||
        relationStrengthRank(right.strength) - relationStrengthRank(left.strength),
    );
  const connectorLocations = relationLocations.filter((location) => location.connectsAnchor);
  const candidates = [
    ...(connectorLocations.length > 0 ? connectorLocations : relationLocations),
    ...(connectorLocations.length > 0
      ? []
      : anchor.focusLocations.map((location) => ({
          ...location,
          connectsAnchor: false,
          overlap: 0,
          strength: 'derived' as const,
        }))),
  ];
  const selected: Array<{ file: string; line: number }> = [];
  for (const location of candidates) {
    if (selected.some((existing) => existing.file === location.file && Math.abs(existing.line - location.line) < 8)) {
      continue;
    }
    selected.push({ file: location.file, line: location.line });
    if (selected.length >= 3) break;
  }
  return selected;
}

function relationLeaf(label: string): string {
  return label.slice(Math.max(label.lastIndexOf(':'), label.lastIndexOf('.')) + 1);
}

function selectCandidateFocusLocations(
  candidate: MutableCandidate,
  frequencies: ReadonlyMap<string, number>,
): Array<{ file: string; line: number; matchedTerms: string[] }> {
  const byLocation = new Map<string, { file: string; line: number; matchedTerms: Set<string> }>();
  for (const [term, match] of candidate.matches) {
    for (const location of match.locations.values()) {
      if (
        location.file !== candidate.definition.relativePath ||
        location.line < candidate.definition.startLine ||
        location.line > candidate.definition.endLine
      )
        continue;
      const key = `${location.file}\0${location.line}`;
      const existing = byLocation.get(key) ?? { ...location, matchedTerms: new Set<string>() };
      existing.matchedTerms.add(term);
      byLocation.set(key, existing);
    }
  }
  const ranked = [...byLocation.values()].sort(
    (left, right) =>
      right.matchedTerms.size - left.matchedTerms.size ||
      [...right.matchedTerms].reduce((score, term) => score + 1 / Math.max(1, frequencies.get(term) ?? 1), 0) -
        [...left.matchedTerms].reduce((score, term) => score + 1 / Math.max(1, frequencies.get(term) ?? 1), 0) ||
      compareLocations(left, right),
  );
  const selected: typeof ranked = [];
  for (const location of ranked) {
    if (selected.some((existing) => existing.file === location.file && Math.abs(existing.line - location.line) < 8)) {
      continue;
    }
    selected.push(location);
    if (selected.length >= 3) break;
  }
  return selected.map((location) => ({
    file: location.file,
    line: location.line,
    matchedTerms: [...location.matchedTerms].sort(),
  }));
}

function chunkedSystemMapCommands(anchors: readonly AnchorDiscoveryCandidate[], chunkSize: number): string[] {
  const commands: string[] = [];
  for (let index = 0; index < anchors.length; index += chunkSize) {
    commands.push(systemMapCommand(anchors.slice(index, index + chunkSize)));
  }
  return commands;
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
