import { createHash } from 'node:crypto';
import type { EvidencePart } from './evidence.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getSourceImports } from '../../language-parsers/index.js';
import {
  behaviorConstructRange,
  behaviorSkeleton,
  type BehaviorSignal,
  type BehaviorSkeleton,
} from '../../source/facts/behavior-skeleton.js';
import { classifyFile, type FileKind } from '../../source/primitives/file-kind.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import { resolveIndexedFile } from '../internal/file-resolution.js';
import { evidence, type EvidenceOptions, type EvidenceResult } from './evidence.js';
import { SOURCE_INSPECTION_MAX_SELECTORS } from '../internal/inspection-limits.js';
import {
  readRuntimeBoundaryObservations,
  type BoundaryEvidenceStrength,
  type BoundaryResolutionState,
} from '../internal/runtime-boundary-evidence.js';
import {
  bindingClosureCharacters,
  bindingClosureForRange,
  mergeBindingClosures,
  type BindingClosure,
} from './binding-closure.js';
import { selectInspectionCandidates } from './source-inspection-selection.js';
import { searchSource } from './source-search.js';
import { enclosingSourceUnitSnippet, sourceSnippet, type SourceUnitSnippet } from './source-snippet.js';

const DEFAULT_CONTEXT = 6;
const DEFAULT_SEARCH_LIMIT = 12;
const DEFAULT_MAX_UNITS = 48;
const DEFAULT_MAX_CHARACTERS = 60_000;
const MAX_SCOPE_HINTS = 12;
const UNBOUNDED_LIMIT = Number.MAX_SAFE_INTEGER;

export type SourceInspectionUnitRole =
  | 'search'
  | 'location'
  | 'definition'
  | 'reference'
  | 'caller'
  | 'callee'
  | 'dependency'
  | 'consumer';

export type SourceInspectionView = 'source' | 'behavior';

export type { BehaviorSignal, BehaviorSkeleton };
export type { BindingClosure, BindingDefinitionEvidence } from './binding-closure.js';

export interface SourceInspectionSlice extends SourceUnitSnippet {
  reasons: string[];
  focusLines: number[];
  ownerSymbol: string | null;
  ownerShort: string | null;
}

export interface SourceInspectionSourceUnit extends SourceInspectionSlice {
  kind: 'source';
  id: string;
  roles: SourceInspectionUnitRole[];
  symbols: string[];
  omittedCharacters: number;
  behavior?: BehaviorSkeleton;
  runtimeFacts?: SourceInspectionRuntimeFact[];
  /** @deprecated Inspect omits whole ranked units rather than clipping source within a returned unit. */
  exactFollowup?: string;
}

/** A compact, source-recoverable projection of one mechanically grounded runtime operation. */
export interface SourceInspectionRuntimeFact {
  observationId: string;
  protocol: string;
  action: string;
  role: string;
  strength: BoundaryEvidenceStrength;
  resolution: BoundaryResolutionState;
  line: number;
  endLine: number;
  keyParts: Array<{ name: string; value: string; evidence: string }>;
  derivation: { kind: string; rule: string; sourceSpans: number };
}

export interface SourceInspectionPathUnit {
  kind: 'path';
  id: string;
  roles: Array<'dependency' | 'consumer'>;
  relativePath: string;
  relationship: string;
  reasons: string[];
  symbols: string[];
  exactFollowup: string;
}

/** One independently useful source excerpt or unresolved file relationship in the shared packet. */
export type SourceInspectionUnit = SourceInspectionSourceUnit | SourceInspectionPathUnit;

/** @deprecated Inspect no longer emits semantic packet continuations. */
export interface SourceInspectionContinuation {
  cursor: string;
  command: string;
  indexGeneration: string;
}

export interface SourceInspectionSearch {
  pattern: string;
  matchingLines: number;
  returnedMatches: number;
  omittedMatches: number;
  matchingFiles?: number;
  returnedFiles?: number;
  omittedFiles?: number;
  candidateUnits?: number;
  selectedUnits?: number;
  omittedUnits?: number;
  scopeHints?: SourceInspectionSearchScope[];
  omittedScopeHints?: number;
  exactFollowup?: string;
}

export interface SourceInspectionSearchScope {
  scope: string;
  matchingLines: number;
  returnedMatches: number;
  exactFollowup: string;
}

export interface SourceInspectionLocation {
  target: string;
  matched: boolean;
}

export interface SourceInspectionPacketCoverage {
  mode: 'bounded' | 'complete';
  candidateUnits: number;
  returnedUnits: number;
  omittedUnits: number;
  omittedByRole: Partial<Record<SourceInspectionUnitRole, number>>;
  exactSelectorsComplete: boolean;
  maxUnits: number;
  maxCharacters: number;
  expansionCommand?: string;
}

export interface SourceInspectionOmissionAnchor {
  relativePath: string;
  line: number;
  ownerShort: string | null;
  roles: SourceInspectionUnitRole[];
  behaviorSignals: BehaviorSignal[];
}

export interface SourceInspectionOmissionGroup {
  id: string;
  scope: string;
  roles: SourceInspectionUnitRole[];
  behaviorSignals: BehaviorSignal[];
  candidateUnits: number;
  sourceCharacters: number;
  anchors: SourceInspectionOmissionAnchor[];
  drillCommand: string;
}

export type SourceInspectionStoppingStatus = 'stop-ready' | 'relevance-check-required' | 'exact-evidence-withheld';

export interface SourceInspectionStoppingSummary {
  status: SourceInspectionStoppingStatus;
  openEvidence: number;
  guidance: string;
  drillCommands: string[];
}

export interface SourceInspectionResult {
  searches: SourceInspectionSearch[];
  evidence: EvidenceResult[];
  locations: SourceInspectionLocation[];
  /** @deprecated Prefer units, which includes every evidence role in one deduplicated packet. */
  slices: SourceInspectionSlice[];
  /** @deprecated Prefer candidateUnits. */
  candidateSlices: number;
  /** @deprecated Prefer omittedUnits. */
  omittedSlices: number;
  /** @deprecated Prefer packetCoverage.maxUnits. */
  maxSlices: number;
  maxTotalLines: number;
  units?: SourceInspectionUnit[];
  candidateUnits?: number;
  omittedUnits?: number;
  maxUnits?: number;
  maxCharacters?: number;
  returnedLines?: number;
  returnedCharacters?: number;
  returnedViewCharacters?: number;
  view?: SourceInspectionView;
  omissionGroups?: SourceInspectionOmissionGroup[];
  packetCoverage?: SourceInspectionPacketCoverage;
  stoppingSummary?: SourceInspectionStoppingSummary;
  bindingClosure?: BindingClosure;
  /** @deprecated Inspect no longer emits semantic packet continuations. */
  continuation?: SourceInspectionContinuation | null;
}

export interface SourceInspectionOptions {
  searches?: readonly string[];
  symbols?: readonly string[];
  locations?: readonly string[];
  scope?: string;
  context?: number;
  searchLimit?: number;
  maxUnits?: number;
  full?: boolean;
  view?: SourceInspectionView;
  /** @deprecated Inspect returns complete syntax units. */
  unitLines?: number;
  /** @deprecated Inspect no longer applies a packet line budget. */
  totalLines?: number;
  /** @deprecated Inspect no longer applies a packet unit budget. */
  sliceLimit?: number;
  /** Soft displayed-evidence character ceiling; a returned syntax unit is never clipped. */
  maxCharacters?: number;
  evidence?: EvidenceOptions;
  /** @deprecated Inspect no longer accepts semantic packet cursors. */
  cursor?: string;
}

interface InspectionRequest {
  searches: string[];
  symbols: string[];
  locations: string[];
  scope?: string;
  context: number;
  searchLimit: number;
  maxUnits: number;
  maxCharacters: number;
  view: SourceInspectionView;
  evidence: {
    parts?: EvidencePart[];
    referenceContext?: number;
    relatedSourceLines?: number;
    semantic?: boolean;
  };
}

interface CandidateSourceUnit extends Omit<SourceInspectionSourceUnit, 'id' | 'omittedCharacters'> {
  priority: number;
  sequence: number;
  bindingClosure?: BindingClosure;
}

interface CandidatePathUnit extends Omit<SourceInspectionPathUnit, 'id'> {
  priority: number;
  sequence: number;
}

type CandidateUnit = CandidateSourceUnit | CandidatePathUnit;

interface BuiltInspection {
  searches: SourceInspectionSearch[];
  evidence: EvidenceResult[];
  locations: SourceInspectionLocation[];
  candidates: CandidateUnit[];
}

/** Build one ranked, deduplicated semantic packet from several known source questions. */
export function inspectSource(db: ScipDatabase, opts: SourceInspectionOptions): SourceInspectionResult {
  if (opts.cursor) {
    throw new Error('Inspect no longer accepts semantic packet cursors. Run the original inspect selectors again.');
  }
  const request = normalizeRequest(opts);

  const built = buildInspection(db, request);
  const candidates = built.candidates.sort((left, right) => compareCandidates(left, right));
  if (request.view === 'behavior') narrowBehaviorConstructs(db, candidates);
  attachBindingClosures(db, candidates);
  if (request.view === 'behavior') attachBehaviorSkeletons(db, candidates);
  const { selected, omitted } = selectInspectionCandidates(
    candidates.map((candidate) => selectionCandidate(candidate, request.view)),
    request.maxUnits,
    request.maxCharacters,
    (left, right) => compareCandidates(left.candidate, right.candidate),
  );
  const selectedCandidates = selected.map((item) => item.candidate);
  const omittedCandidates = omitted.map((item) => item.candidate);
  const units = selectedCandidates.map(publicUnit);
  const bindingClosure = mergeBindingClosures(
    selectedCandidates.map((candidate) => (candidate.kind === 'source' ? candidate.bindingClosure : undefined)),
    selectedCandidates
      .filter((candidate): candidate is CandidateSourceUnit => candidate.kind === 'source')
      .map((candidate) => ({
        relativePath: candidate.relativePath,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
      })),
  );
  const returnedLines = units.reduce((total, unit) => total + (unit.kind === 'source' ? lineCount(unit.source) : 0), 0);
  const returnedCharacters = units.reduce(
    (total, unit) => total + (unit.kind === 'source' ? unit.source.length : 0),
    0,
  );
  const returnedViewCharacters = units.reduce(
    (total, unit) => total + displayedEvidenceCharacters(unit, request.view),
    0,
  );
  const slices = units
    .filter(
      (unit): unit is SourceInspectionSourceUnit =>
        unit.kind === 'source' && (unit.roles.includes('search') || unit.roles.includes('location')),
    )
    .map(sourceUnitToLegacySlice);
  const candidateSlices = candidates.filter(
    (unit) => unit.kind === 'source' && (unit.roles.includes('search') || unit.roles.includes('location')),
  ).length;
  const selectedSliceCount = units.filter(
    (unit) => unit.kind === 'source' && (unit.roles.includes('search') || unit.roles.includes('location')),
  ).length;
  const searches = built.searches.map((search) => searchSelectionCoverage(search, candidates, selectedCandidates));
  const omittedByRole = countRoles(omittedCandidates);
  const exactSelectorsComplete = omittedCandidates.every((candidate) =>
    candidate.roles.every((role) => role === 'search'),
  );
  const omittedSearchMatches = searches.reduce((total, search) => total + search.omittedMatches, 0);
  const complete = omittedCandidates.length === 0 && omittedSearchMatches === 0;
  const expansionCommand = complete ? undefined : inspectionCommand(request, true);
  const omissionGroups = omissionGroupsFor(request, omittedCandidates);
  const stoppingSummary = stoppingSummaryFor(
    complete,
    exactSelectorsComplete,
    omittedCandidates.length + omittedSearchMatches,
    omissionGroups,
    searches,
    expansionCommand,
  );

  return {
    searches,
    evidence: built.evidence,
    locations: built.locations,
    slices,
    candidateSlices,
    omittedSlices: candidateSlices - selectedSliceCount,
    maxSlices: candidateSlices,
    maxTotalLines: returnedLines,
    units,
    candidateUnits: candidates.length,
    omittedUnits: omittedCandidates.length,
    maxUnits: request.maxUnits,
    maxCharacters: request.maxCharacters,
    returnedLines,
    returnedCharacters,
    returnedViewCharacters,
    view: request.view,
    omissionGroups,
    packetCoverage: {
      mode: complete ? 'complete' : 'bounded',
      candidateUnits: candidates.length,
      returnedUnits: units.length,
      omittedUnits: omittedCandidates.length,
      omittedByRole,
      exactSelectorsComplete,
      maxUnits: request.maxUnits,
      maxCharacters: request.maxCharacters,
      ...(expansionCommand ? { expansionCommand } : {}),
    },
    stoppingSummary,
    bindingClosure,
    continuation: null,
  };
}

function stoppingSummaryFor(
  complete: boolean,
  exactSelectorsComplete: boolean,
  openEvidence: number,
  omissionGroups: readonly SourceInspectionOmissionGroup[],
  searches: readonly SourceInspectionSearch[],
  expansionCommand: string | undefined,
): SourceInspectionStoppingSummary {
  const drillCommands = unique([
    ...omissionGroups.map((group) => group.drillCommand),
    ...searches.flatMap((search) => (search.exactFollowup ? [search.exactFollowup] : [])),
    ...(expansionCommand ? [expansionCommand] : []),
  ]);
  if (complete) {
    return {
      status: 'stop-ready',
      openEvidence: 0,
      guidance:
        'All requested selectors were materialized; stop unless a named semantic blind spot can change the decision.',
      drillCommands: [],
    };
  }
  if (!exactSelectorsComplete) {
    return {
      status: 'exact-evidence-withheld',
      openEvidence,
      guidance:
        'Exact symbol or location evidence is withheld; do not make absence claims until the relevant gap is drilled.',
      drillCommands,
    };
  }
  return {
    status: 'relevance-check-required',
    openEvidence,
    guidance: 'Evidence remains withheld; drill only groups that can change the current decision, otherwise stop.',
    drillCommands,
  };
}

function normalizeRequest(opts: SourceInspectionOptions): InspectionRequest {
  const searches = uniqueNonEmpty(opts.searches);
  const symbols = uniqueNonEmpty(opts.symbols);
  const locations = uniqueNonEmpty(opts.locations);
  const selectorCount = searches.length + symbols.length + locations.length;
  if (selectorCount === 0) throw new Error('inspect requires at least one --search, --symbol, or --at selector.');
  if (selectorCount > SOURCE_INSPECTION_MAX_SELECTORS) {
    throw new RangeError(
      `inspect accepts at most ${SOURCE_INSPECTION_MAX_SELECTORS} selectors; received ${selectorCount}.`,
    );
  }
  const evidenceOptions = opts.evidence ?? {};
  if (opts.unitLines !== undefined) positive(opts.unitLines, 'unitLines');
  if (opts.totalLines !== undefined) positive(opts.totalLines, 'totalLines');
  if (opts.sliceLimit !== undefined) positive(opts.sliceLimit, 'sliceLimit');
  if (opts.maxCharacters !== undefined) positive(opts.maxCharacters, 'maxCharacters');
  if (opts.maxUnits !== undefined) positive(opts.maxUnits, 'maxUnits');
  if (opts.view !== undefined && opts.view !== 'source' && opts.view !== 'behavior') {
    throw new Error(`Unknown inspect view: ${String(opts.view)}. Use source or behavior.`);
  }
  if (
    opts.full &&
    (opts.searchLimit !== undefined || opts.maxUnits !== undefined || opts.maxCharacters !== undefined)
  ) {
    throw new Error('full inspect cannot be combined with searchLimit, maxUnits, or maxCharacters.');
  }
  const full = opts.full ?? false;
  return {
    searches,
    symbols,
    locations,
    ...(opts.scope?.trim() ? { scope: opts.scope.trim() } : {}),
    context: positiveOrZero(opts.context ?? DEFAULT_CONTEXT, 'context'),
    searchLimit: positive(opts.searchLimit ?? (full ? UNBOUNDED_LIMIT : DEFAULT_SEARCH_LIMIT), 'searchLimit'),
    maxUnits: positive(full ? UNBOUNDED_LIMIT : (opts.maxUnits ?? DEFAULT_MAX_UNITS), 'maxUnits'),
    maxCharacters: positive(full ? UNBOUNDED_LIMIT : (opts.maxCharacters ?? DEFAULT_MAX_CHARACTERS), 'maxCharacters'),
    view: opts.view ?? 'source',
    evidence: {
      ...(evidenceOptions.parts ? { parts: [...evidenceOptions.parts] } : {}),
      ...(evidenceOptions.referenceContext !== undefined
        ? { referenceContext: positiveOrZero(evidenceOptions.referenceContext, 'referenceContext') }
        : {}),
      relatedSourceLines: evidenceOptions.relatedSourceLines ?? 60,
      ...(evidenceOptions.semantic !== undefined ? { semantic: evidenceOptions.semantic } : {}),
    },
  };
}

function buildInspection(db: ScipDatabase, request: InspectionRequest): BuiltInspection {
  const candidates: CandidateUnit[] = [];
  let sequence = 0;
  const pendingSearches = request.searches.map((pattern) => {
    const result = searchSource(db, pattern, {
      scope: request.scope,
      context: 0,
      limit: request.searchLimit,
      ranking: 'structural',
    });
    return { pattern, result, matches: result.matches };
  });
  const maxSearchMatches = Math.max(0, ...pendingSearches.map((item) => item.matches.length));
  for (let matchIndex = 0; matchIndex < maxSearchMatches; matchIndex += 1) {
    for (const pending of pendingSearches) {
      const match = pending.matches[matchIndex];
      if (!match) continue;
      const unit = enclosingSourceUnitSnippet(
        db,
        match.relativePath,
        match.focusLine,
        UNBOUNDED_LIMIT,
        request.context,
      );
      if (!unit) continue;
      addSourceCandidate(
        db,
        candidates,
        unit,
        'search',
        `search:${pending.pattern}`,
        match.ownerSymbol,
        match.ownerShort,
        1,
        sequence++,
      );
    }
  }
  const searchResults = pendingSearches.map(({ pattern, result }) => {
    const exactFollowup = result.omittedMatches > 0 ? singleSearchExpansionCommand(pattern, request.scope) : undefined;
    const fileCoverage = result.fileCoverage ?? [];
    const scopeHints = searchScopeHints(pattern, fileCoverage, request.scope);
    return {
      pattern,
      matchingLines: result.matchingLines,
      returnedMatches: result.matches.length,
      omittedMatches: result.omittedMatches,
      matchingFiles: fileCoverage.length,
      returnedFiles: fileCoverage.filter((file) => file.returnedMatches > 0).length,
      omittedFiles: fileCoverage.filter((file) => file.returnedMatches === 0).length,
      candidateUnits: 0,
      selectedUnits: 0,
      omittedUnits: 0,
      scopeHints: scopeHints.slice(0, MAX_SCOPE_HINTS),
      omittedScopeHints: Math.max(0, scopeHints.length - MAX_SCOPE_HINTS),
      ...(exactFollowup ? { exactFollowup } : {}),
    };
  });

  const locationResults = request.locations.map((target) => {
    const parsed = parseLocation(target);
    const relativePath = parsed ? resolveIndexedFile(db, parsed.path) : null;
    const unit = relativePath
      ? enclosingSourceUnitSnippet(db, relativePath, parsed!.line - 1, UNBOUNDED_LIMIT, request.context)
      : null;
    if (unit) addSourceCandidate(db, candidates, unit, 'location', `at:${target}`, null, null, 0, sequence++);
    return { target, matched: unit !== null };
  });

  const evidenceResults = request.symbols.map((symbol) => evidence(db, symbol, request.evidence));
  for (const item of evidenceResults) {
    if (item.kind !== 'matched') continue;
    if (item.definition) {
      const unit = enclosingSourceUnitSnippet(
        db,
        item.definition.relativePath,
        item.definition.startLine,
        UNBOUNDED_LIMIT,
        request.context,
      );
      if (unit) {
        addSourceCandidate(
          db,
          candidates,
          unit,
          'definition',
          `definition:${item.shortName}`,
          item.symbol,
          item.shortName,
          0,
          sequence++,
        );
      }
    }
    for (const window of item.referenceWindows) {
      const owner = window.references[0];
      addSourceCandidate(
        db,
        candidates,
        {
          ...window,
          focusLine: owner?.line ?? window.startLine,
          unitType: null,
          unitStartLine: window.startLine,
          unitEndLine: window.endLine,
          omittedLines: 0,
        },
        'reference',
        `reference:${item.shortName}`,
        owner?.enclosingSymbol ?? null,
        owner?.enclosingShort ?? null,
        2,
        sequence++,
        window.references.map((reference) => reference.line),
        item.symbol,
      );
    }
    for (const related of item.callers) {
      addRelatedSymbolCandidate(db, candidates, related, 'caller', item, 3, sequence++);
    }
    for (const related of item.callees) {
      addRelatedSymbolCandidate(db, candidates, related, 'callee', item, 4, sequence++);
    }
    for (const dependency of item.dependencies) {
      addEdgeCandidate(
        db,
        candidates,
        'dependency',
        item.file,
        dependency.relativePath,
        item.symbol,
        request.context,
        5,
        sequence++,
      );
    }
    for (const consumer of item.consumers) {
      addEdgeCandidate(
        db,
        candidates,
        'consumer',
        consumer.relativePath,
        item.file,
        item.symbol,
        request.context,
        6,
        sequence++,
      );
    }
  }

  return { searches: searchResults, evidence: evidenceResults, locations: locationResults, candidates };
}

function compareCandidates(left: CandidateUnit, right: CandidateUnit): number {
  return (
    left.priority - right.priority ||
    right.roles.length - left.roles.length ||
    right.reasons.length - left.reasons.length ||
    fileKindRank(classifyFile(left.relativePath)) - fileKindRank(classifyFile(right.relativePath)) ||
    left.sequence - right.sequence
  );
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

interface SelectionCandidate {
  candidate: CandidateUnit;
  priority: number;
  sequence: number;
  relativePath: string;
  fileKind: FileKind;
  evidenceCharacters: number;
  roles: readonly SourceInspectionUnitRole[];
  reasons: readonly string[];
  symbols: readonly string[];
  behaviorSignals: readonly BehaviorSignal[];
}

function selectionCandidate(candidate: CandidateUnit, view: SourceInspectionView): SelectionCandidate {
  return {
    candidate,
    priority: candidate.priority,
    sequence: candidate.sequence,
    relativePath: candidate.relativePath,
    fileKind: classifyFile(candidate.relativePath),
    evidenceCharacters: displayedEvidenceCharacters(candidate, view),
    roles: candidate.roles,
    reasons: candidate.reasons,
    symbols: candidate.symbols,
    behaviorSignals: candidate.kind === 'source' ? (candidate.behavior?.signals ?? []) : [],
  };
}

function attachBehaviorSkeletons(db: ScipDatabase, candidates: readonly CandidateUnit[]): void {
  const sourceCandidates = candidates.filter(
    (candidate): candidate is CandidateSourceUnit => candidate.kind === 'source',
  );
  const observations = readRuntimeBoundaryObservations(db, {
    files: unique(sourceCandidates.map((candidate) => candidate.relativePath)),
  });
  for (const candidate of sourceCandidates) {
    candidate.behavior =
      behaviorSkeleton(db, candidate.relativePath, candidate.startLine, candidate.endLine, candidate.focusLines) ??
      undefined;
    const candidateObservations = observations.filter(
      (observation) =>
        observation.source.file === candidate.relativePath &&
        observation.source.startLine <= candidate.endLine &&
        observation.source.endLine >= candidate.startLine,
    );
    const runtimeFacts = candidateObservations
      .filter((observation) => !isSupersededMountedAddress(observation, candidateObservations))
      .map(
        (observation): SourceInspectionRuntimeFact => ({
          observationId: observation.id,
          protocol: observation.protocol,
          action: observation.action,
          role: observation.role,
          strength: observation.strength,
          resolution: observation.resolution,
          line: observation.source.startLine,
          endLine: observation.source.endLine,
          keyParts: observation.keyParts.map((part) => ({
            name: part.name,
            value: part.value,
            evidence: part.evidence,
          })),
          derivation: {
            kind: observation.derivation.kind,
            rule: observation.derivation.rule,
            sourceSpans: observation.derivation.sourceSpans.length,
          },
        }),
      );
    candidate.runtimeFacts = runtimeFacts.length > 0 ? runtimeFacts : undefined;
  }
}

function isSupersededMountedAddress(
  observation: ReturnType<typeof readRuntimeBoundaryObservations>[number],
  peers: readonly ReturnType<typeof readRuntimeBoundaryObservations>[number][],
): boolean {
  if (observation.strength !== 'candidate' || observation.protocol !== 'http') return false;
  const path = observation.keyParts.find((part) => part.name === 'path')?.value;
  const method = observation.keyParts.find((part) => part.name === 'method')?.value;
  if (!path) return false;
  return peers.some((peer) => {
    if (
      peer === observation ||
      peer.action !== observation.action ||
      peer.role !== observation.role ||
      peer.source.startLine !== observation.source.startLine ||
      peer.derivation.rule !== 'http.mount-prefix'
    )
      return false;
    const peerPath = peer.keyParts.find((part) => part.name === 'path')?.value;
    const peerMethod = peer.keyParts.find((part) => part.name === 'method')?.value;
    return Boolean(peerPath && peerPath !== path && peerPath.endsWith(path) && (!method || method === peerMethod));
  });
}

function narrowBehaviorConstructs(db: ScipDatabase, candidates: readonly CandidateUnit[]): void {
  for (const candidate of candidates) {
    if (candidate.kind !== 'source') continue;
    const range = behaviorConstructRange(
      db,
      candidate.relativePath,
      candidate.startLine,
      candidate.endLine,
      candidate.focusLines,
    );
    if (range.startLine === candidate.startLine && range.endLine === candidate.endLine) continue;
    candidate.startLine = range.startLine;
    candidate.endLine = range.endLine;
    candidate.source = getSourceLines(db, candidate.relativePath)
      .slice(range.startLine, range.endLine + 1)
      .join('\n');
    candidate.unitStartLine = range.startLine;
    candidate.unitEndLine = range.endLine;
    candidate.omittedLines = 0;
  }
}

function attachBindingClosures(db: ScipDatabase, candidates: readonly CandidateUnit[]): void {
  for (const candidate of candidates) {
    if (candidate.kind !== 'source') continue;
    candidate.bindingClosure = bindingClosureForRange(
      db,
      candidate.relativePath,
      candidate.startLine,
      candidate.endLine,
    );
  }
}

function omissionGroupsFor(
  request: InspectionRequest,
  omitted: readonly CandidateUnit[],
): SourceInspectionOmissionGroup[] {
  const grouped = new Map<string, CandidateUnit[]>();
  for (const candidate of omitted) {
    const scope = parentPath(candidate.relativePath);
    const roles = [...candidate.roles].sort().join(',');
    const discriminator = candidate.kind === 'path' ? candidate.relationship : '';
    const key = `${scope}|${roles}|${discriminator}`;
    const candidates = grouped.get(key) ?? [];
    candidates.push(candidate);
    grouped.set(key, candidates);
  }

  return [...grouped.entries()]
    .map(([key, candidates]) => {
      const first = candidates[0]!;
      const roles = unique(candidates.flatMap((candidate) => [...candidate.roles])).sort();
      const behaviorSignals = unique(
        candidates.flatMap((candidate) => (candidate.kind === 'source' ? (candidate.behavior?.signals ?? []) : [])),
      ).sort();
      return {
        id: `g-${createHash('sha256').update(key).digest('hex').slice(0, 8)}`,
        scope: parentPath(first.relativePath),
        roles,
        behaviorSignals,
        candidateUnits: candidates.length,
        sourceCharacters: candidates.reduce(
          (total, candidate) => total + (candidate.kind === 'source' ? candidate.source.length : 0),
          0,
        ),
        anchors: candidates.map((candidate) => ({
          relativePath: candidate.relativePath,
          line: candidate.kind === 'source' ? candidate.focusLine : 0,
          ownerShort: candidate.kind === 'source' ? candidate.ownerShort : null,
          roles: [...candidate.roles],
          behaviorSignals: candidate.kind === 'source' ? [...(candidate.behavior?.signals ?? [])] : [],
        })),
        drillCommand: omissionGroupCommand(request, candidates),
      };
    })
    .sort(
      (left, right) =>
        right.candidateUnits - left.candidateUnits ||
        right.sourceCharacters - left.sourceCharacters ||
        left.scope.localeCompare(right.scope) ||
        left.id.localeCompare(right.id),
    );
}

function omissionGroupCommand(request: InspectionRequest, candidates: readonly CandidateUnit[]): string {
  const searchPatterns = unique(
    candidates.flatMap((candidate) =>
      candidate.reasons
        .filter((reason) => reason.startsWith('search:'))
        .map((reason) => reason.slice('search:'.length)),
    ),
  );
  const scope = parentPath(candidates[0]!.relativePath);
  if (
    searchPatterns.length > 0 &&
    candidates.every((candidate) => candidate.kind === 'source' && candidate.roles.includes('search'))
  ) {
    const parts = ['scip-query inspect'];
    for (const pattern of searchPatterns) parts.push(`--search ${shellArgument(pattern)}`);
    parts.push(`--scope ${shellArgument(scope)}`, '--full');
    if (request.view === 'behavior') parts.push('--view behavior');
    return parts.join(' ');
  }

  const sourceCandidates = candidates.filter(
    (candidate): candidate is CandidateSourceUnit => candidate.kind === 'source',
  );
  if (sourceCandidates.length > 0 && sourceCandidates.length <= SOURCE_INSPECTION_MAX_SELECTORS) {
    const parts = ['scip-query inspect'];
    for (const candidate of sourceCandidates) {
      parts.push(`--at ${shellArgument(`${candidate.relativePath}:${candidate.focusLine + 1}`)}`);
    }
    if (request.view === 'behavior') parts.push('--view behavior');
    return parts.join(' ');
  }

  if (candidates.length === 1 && candidates[0]!.kind === 'path') return candidates[0]!.exactFollowup;
  return inspectionCommand(request, true);
}

function searchSelectionCoverage(
  search: SourceInspectionSearch,
  candidates: readonly CandidateUnit[],
  selected: readonly CandidateUnit[],
): SourceInspectionSearch {
  const reason = `search:${search.pattern}`;
  const candidateUnits = candidates.filter((candidate) => candidate.reasons.includes(reason)).length;
  const selectedCandidates = new Set(selected);
  const selectedUnits = candidates.filter(
    (candidate) => candidate.reasons.includes(reason) && selectedCandidates.has(candidate),
  ).length;
  return {
    ...search,
    candidateUnits,
    selectedUnits,
    omittedUnits: candidateUnits - selectedUnits,
  };
}

function countRoles(candidates: readonly CandidateUnit[]): Partial<Record<SourceInspectionUnitRole, number>> {
  const counts: Partial<Record<SourceInspectionUnitRole, number>> = {};
  for (const candidate of candidates) {
    for (const role of candidate.roles) counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
}

function searchScopeHints(
  pattern: string,
  files: readonly { relativePath: string; matchingLines: number; returnedMatches: number }[],
  requestedScope: string | undefined,
): SourceInspectionSearchScope[] {
  const scopes = new Map<string, { matchingLines: number; returnedMatches: number }>();
  for (const file of files) {
    const scope = parentPath(file.relativePath);
    const current = scopes.get(scope) ?? { matchingLines: 0, returnedMatches: 0 };
    current.matchingLines += file.matchingLines;
    current.returnedMatches += file.returnedMatches;
    scopes.set(scope, current);
  }
  return [...scopes.entries()]
    .map(([scope, coverage]) => ({
      scope,
      ...coverage,
      exactFollowup: singleSearchExpansionCommand(pattern, scope || requestedScope),
    }))
    .sort(
      (left, right) =>
        right.matchingLines - left.matchingLines ||
        right.returnedMatches - left.returnedMatches ||
        left.scope.localeCompare(right.scope),
    );
}

function parentPath(relativePath: string): string {
  const separator = relativePath.lastIndexOf('/');
  return separator < 0 ? relativePath : relativePath.slice(0, separator);
}

function singleSearchExpansionCommand(pattern: string, scope: string | undefined): string {
  return `scip-query inspect --search ${shellArgument(pattern)}${scope ? ` --scope ${shellArgument(scope)}` : ''} --full`;
}

function inspectionCommand(request: InspectionRequest, full: boolean): string {
  const parts = ['scip-query inspect'];
  for (const search of request.searches) parts.push(`--search ${shellArgument(search)}`);
  for (const symbol of request.symbols) parts.push(`--symbol ${shellArgument(symbol)}`);
  for (const location of request.locations) parts.push(`--at ${shellArgument(location)}`);
  if (request.scope) parts.push(`--scope ${shellArgument(request.scope)}`);
  if (request.context !== DEFAULT_CONTEXT) parts.push(`--context ${request.context}`);
  if (request.evidence.parts) parts.push(`--include ${shellArgument(request.evidence.parts.join(','))}`);
  if (full) parts.push('--full');
  if (request.view === 'behavior') parts.push('--view behavior');
  return parts.join(' ');
}

function addRelatedSymbolCandidate(
  db: ScipDatabase,
  candidates: CandidateUnit[],
  related: Extract<EvidenceResult, { kind: 'matched' }>['callers'][number],
  role: 'caller' | 'callee',
  target: Extract<EvidenceResult, { kind: 'matched' }>,
  priority: number,
  sequence: number,
): void {
  addSourceCandidate(
    db,
    candidates,
    {
      ...related,
      unitType: null,
      unitStartLine: related.startLine,
      unitEndLine: related.endLine + related.omittedLines,
    },
    role,
    `${role}:${target.shortName}`,
    related.symbol,
    related.shortName,
    priority,
    sequence,
    [related.focusLine],
    target.symbol,
  );
}

function addEdgeCandidate(
  db: ScipDatabase,
  candidates: CandidateUnit[],
  role: 'dependency' | 'consumer',
  importer: string,
  imported: string,
  targetSymbol: string,
  context: number,
  priority: number,
  sequence: number,
): void {
  const relationship = `${importer} -> ${imported}`;
  const parsedImports = getSourceImports(db, importer).filter((entry) => entry.sourcePath === imported);
  const lines = getSourceLines(db, importer);
  const focusLine = findImportLine(lines, parsedImports, imported);
  const snippet = focusLine === null ? null : sourceSnippet(db, importer, focusLine, Math.min(context, 4));
  if (snippet) {
    addSourceCandidate(
      db,
      candidates,
      {
        ...snippet,
        unitType: null,
        unitStartLine: snippet.startLine,
        unitEndLine: snippet.endLine,
        omittedLines: 0,
      },
      role,
      `${role}:${relationship}`,
      null,
      null,
      priority,
      sequence,
      [snippet.focusLine],
      targetSymbol,
    );
    return;
  }
  const exactFollowup = `scip-query inspect --search ${shellArgument(lastPathSegment(imported))} --scope ${shellArgument(importer)}`;
  const existing = candidates.find(
    (candidate): candidate is CandidatePathUnit =>
      candidate.kind === 'path' && candidate.relativePath === importer && candidate.relationship === relationship,
  );
  if (existing) {
    existing.roles = unique([...existing.roles, role]);
    existing.reasons = unique([...existing.reasons, `${role}:${relationship}`]);
    existing.symbols = unique([...existing.symbols, targetSymbol]);
    existing.priority = Math.min(existing.priority, priority);
    return;
  }
  candidates.push({
    kind: 'path',
    roles: [role],
    relativePath: importer,
    relationship,
    reasons: [`${role}:${relationship}`],
    symbols: [targetSymbol],
    exactFollowup,
    priority,
    sequence,
  });
}

function findImportLine(
  lines: readonly string[],
  imports: ReturnType<typeof getSourceImports>,
  importedPath: string,
): number | null {
  const names = unique(
    imports.flatMap((entry) => [entry.importedName, entry.localName ?? '']).filter((name) => name.length > 1),
  );
  const pathHint = lastPathSegment(importedPath).replace(/\.[^.]+$/u, '');
  const terms = unique([...names, pathHint]).filter(Boolean);
  const importLike = /\b(?:from|import|include|require|use)\b/u;
  const line = lines.findIndex(
    (sourceLine) => importLike.test(sourceLine) && terms.some((term) => sourceLine.includes(term)),
  );
  return line >= 0 ? line : null;
}

function addSourceCandidate(
  db: ScipDatabase,
  candidates: CandidateUnit[],
  unit: SourceUnitSnippet,
  role: Exclude<SourceInspectionUnitRole, 'dependency' | 'consumer'> | 'dependency' | 'consumer',
  reason: string,
  ownerSymbol: string | null,
  ownerShort: string | null,
  priority: number,
  sequence: number,
  focusLines: readonly number[] = [unit.focusLine],
  selectedSymbol?: string,
): void {
  const existing = candidates.find(
    (candidate): candidate is CandidateSourceUnit =>
      candidate.kind === 'source' &&
      candidate.relativePath === unit.relativePath &&
      candidate.startLine <= unit.endLine &&
      unit.startLine <= candidate.endLine,
  );
  if (existing) {
    const startLine = Math.min(existing.startLine, unit.startLine);
    const endLine = Math.max(existing.endLine, unit.endLine);
    existing.startLine = startLine;
    existing.endLine = endLine;
    existing.source = getSourceLines(db, unit.relativePath)
      .slice(startLine, endLine + 1)
      .join('\n');
    existing.focusLine = Math.min(existing.focusLine, unit.focusLine);
    existing.focusLines = uniqueNumbers([...existing.focusLines, ...focusLines]);
    existing.unitStartLine = Math.min(existing.unitStartLine, unit.unitStartLine);
    existing.unitEndLine = Math.max(existing.unitEndLine, unit.unitEndLine);
    existing.omittedLines = Math.max(existing.omittedLines, unit.omittedLines);
    existing.reasons = unique([...existing.reasons, reason]);
    existing.roles = unique([...existing.roles, role]);
    existing.symbols = unique([...existing.symbols, ...(selectedSymbol ? [selectedSymbol] : [])]);
    if (!existing.ownerSymbol && ownerSymbol) existing.ownerSymbol = ownerSymbol;
    if (!existing.ownerShort && ownerShort) existing.ownerShort = ownerShort;
    existing.priority = Math.min(existing.priority, priority);
    return;
  }
  candidates.push({
    kind: 'source',
    ...unit,
    reasons: [reason],
    focusLines: uniqueNumbers(focusLines),
    ownerSymbol,
    ownerShort,
    roles: [role],
    symbols: selectedSymbol ? [selectedSymbol] : [],
    priority,
    sequence,
  });
}

function publicUnit(candidate: CandidateUnit): SourceInspectionUnit {
  if (candidate.kind === 'path') {
    const { priority: _priority, sequence: _sequence, ...unit } = candidate;
    return { ...unit, id: unitIdentity(unit) };
  }
  const { priority: _priority, sequence: _sequence, bindingClosure: _bindingClosure, ...unit } = candidate;
  return { ...unit, id: unitIdentity(unit), omittedCharacters: 0 };
}

function sourceUnitToLegacySlice(unit: SourceInspectionSourceUnit): SourceInspectionSlice {
  const {
    kind: _kind,
    id: _id,
    roles: _roles,
    symbols: _symbols,
    omittedCharacters: _omittedCharacters,
    behavior: _behavior,
    runtimeFacts: _runtimeFacts,
    ...slice
  } = unit;
  return slice;
}

function unitIdentity(unit: Omit<SourceInspectionUnit, 'id'>): string {
  return createHash('sha256').update(JSON.stringify(unit)).digest('hex').slice(0, 16);
}

function parseLocation(target: string): { path: string; line: number } | null {
  const match = target.match(/^(.+\.\w+):(\d+)$/u);
  if (!match) return null;
  const line = Number(match[2]);
  return Number.isSafeInteger(line) && line > 0 ? { path: match[1]!, line } : null;
}

function uniqueNonEmpty(values: readonly string[] | undefined): string[] {
  return unique((values ?? []).map((value) => value.trim()).filter(Boolean));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: readonly number[]): number[] {
  return unique(values).sort((left, right) => left - right);
}

function lineCount(source: string): number {
  return source.length === 0 ? 0 : source.split('\n').length;
}

function displayedEvidenceCharacters(unit: CandidateUnit | SourceInspectionUnit, view: SourceInspectionView): number {
  if (unit.kind === 'path') return unit.relationship.length + unit.exactFollowup.length;
  const bindings = 'bindingClosure' in unit ? bindingClosureCharacters(unit.bindingClosure) : 0;
  const runtimeFacts = (unit.runtimeFacts ?? []).reduce(
    (total, fact) =>
      total +
      fact.action.length +
      fact.derivation.rule.length +
      fact.keyParts.reduce((partTotal, part) => partTotal + part.name.length + part.value.length + 4, 0) +
      24,
    0,
  );
  if (view !== 'behavior') return unit.source.length + bindings;
  if (!unit.behavior) return unit.source.length + bindings + runtimeFacts;
  return (
    unit.behavior.lines.reduce((total, line) => total + line.text.length + line.signals.join(',').length + 12, 0) +
    unit.behavior.testCases.reduce((total, name) => total + name.length + 2, 0) +
    runtimeFacts +
    bindings
  );
}

function lastPathSegment(relativePath: string): string {
  return relativePath.split('/').at(-1) ?? relativePath;
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer; received ${value}`);
  }
  return value;
}

function positiveOrZero(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer; received ${value}`);
  }
  return value;
}
