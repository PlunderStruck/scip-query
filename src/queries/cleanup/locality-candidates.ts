import { posix } from 'node:path';

import { ProjectIndex } from '../internal/project-index.js';
import type { IndexedDefinition } from '../../domain/types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { resolveSymbol } from '../../symbols/symbol-lookup.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { consumerEvidenceProduct, consumerFileMapFromEvidence } from '../internal/consumer-evidence.js';
import { normalizeRelativePath as normalizePath } from '../../domain/path-normalization.js';

export type LocalityActionTier = 'signal';

export type LocalityConsumerCoverage = 'symbol-observations' | 'file-level' | 'none';

export type LocalityDestinationConfidence = 'candidate' | 'withheld';

export type LocalityRecommendedTier =
  | 'same-file'
  | 'sibling-folder'
  | 'feature-local-shared'
  | 'app-level-shared'
  | 'package-level-shared'
  | 'repository-level-review'
  | 'no-observed-consumers';

export interface LocalityDirectoryAncestor {
  path: string;
  depth: number;
  markers: string[];
}

export interface LocalitySourceUnit {
  kind: 'symbol' | 'file';
  file: string;
  shortName: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
}

export interface LocalityCandidate {
  actionTier: LocalityActionTier;
  sourceUnit: LocalitySourceUnit;
  candidatePath: string;
  currentDirectory: string;
  directoryAncestry: LocalityDirectoryAncestor[];
  consumerFiles: string[];
  consumerCoverage: LocalityConsumerCoverage;
  nearestCommonDirectory: string | null;
  boundaryMarkers: string[];
  recommendedTier: LocalityRecommendedTier;
  suggestedHome: string | null;
  destinationConfidence: LocalityDestinationConfidence;
  whyNoSuggestedHome: string | null;
  counterevidence: string[];
  reasons: string[];
  recommendation: string;
}

export interface LocalityCandidatesOptions {
  target?: string;
  scope?: string;
  limit?: number;
  minConsumers?: number;
  scanLimit?: number;
  semantic?: boolean;
  architecturalBoundarySegments?: readonly string[];
}

interface SourceUnitWithDefinition {
  unit: LocalitySourceUnit;
  definition?: IndexedDefinition;
}

interface DestinationAssessment {
  suggestedHome: string | null;
  confidence: LocalityDestinationConfidence;
  whyNoSuggestedHome: string | null;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_MIN_CONSUMERS = 1;

const BOUNDARY_SEGMENTS = new Map<string, string>([
  ['app', 'app'],
  ['apps', 'app'],
  ['component', 'component'],
  ['components', 'component'],
  ['composable', 'composable'],
  ['composables', 'composable'],
  ['contract', 'contract'],
  ['contracts', 'contract'],
  ['domain', 'domain'],
  ['domains', 'domain'],
  ['feature', 'feature'],
  ['features', 'feature'],
  ['hook', 'hook'],
  ['hooks', 'hook'],
  ['lib', 'library'],
  ['module', 'module'],
  ['modules', 'module'],
  ['package', 'package'],
  ['packages', 'package'],
  ['page', 'page'],
  ['pages', 'page'],
  ['route', 'route'],
  ['routes', 'route'],
  ['screen', 'screen'],
  ['screens', 'screen'],
  ['service', 'service'],
  ['services', 'service'],
  ['shared', 'shared'],
  ['src', 'source-root'],
  ['store', 'state'],
  ['stores', 'state'],
  ['test', 'test'],
  ['tests', 'test'],
  ['util', 'utility'],
  ['utils', 'utility'],
  ['view', 'view'],
  ['views', 'view'],
]);

const SHARED_HOME_SEGMENTS = new Set([
  'components',
  'contracts',
  'hooks',
  'lib',
  'services',
  'shared',
  'stores',
  'utils',
]);

const DEFAULT_ARCHITECTURAL_BOUNDARY_SEGMENTS = new Set([
  'access',
  'api',
  'auth',
  'config',
  'db',
  'effect',
  'errors',
  'hooks',
  'lib',
  'middleware',
  'permissions',
  'routes',
  'schemas',
  'servicetasks',
  'services',
  'startup',
  'store',
  'stores',
  'test-utils',
  'repository',
  'repositories',
  'tests',
  'types',
  'ui',
  'utils',
  'workflow',
  'workflows',
]);

// scip-query: ignore-extract — reviewed E3 feature-local pipeline; the helper cluster has no separate owner or consumer.
export function localityCandidates(db: ScipDatabase, options: LocalityCandidatesOptions = {}): LocalityCandidate[] {
  const limit = positiveInteger(options.limit, DEFAULT_LIMIT);
  const minConsumers = positiveInteger(options.minConsumers, DEFAULT_MIN_CONSUMERS);
  const index = new ProjectIndex(db);
  const graph = index.fileDependencyGraph();
  const indexedDirectories = directorySetForIndexedFiles(indexedDocumentPaths(db, { includeIgnored: false }));
  const architecturalBoundarySegments = architecturalBoundarySegmentsFor(
    db.config.locality?.architecturalBoundarySegments,
    options.architecturalBoundarySegments,
  );

  const sourceUnits = options.target
    ? resolveTargetSourceUnits(db, index, options.target)
    : scanFileSourceUnits(db, options.scope, options.scanLimit);

  const candidates = sourceUnits
    .map((source) =>
      buildLocalityCandidate(db, index, graph, source, options, indexedDirectories, architecturalBoundarySegments),
    )
    .filter((candidate) => candidate.consumerFiles.length >= minConsumers || options.target)
    .sort(compareLocalityCandidates);

  return candidates.slice(0, limit);
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function resolveTargetSourceUnits(db: ScipDatabase, index: ProjectIndex, target: string): SourceUnitWithDefinition[] {
  const filePath = resolveIndexedFilePath(db, target);
  if (filePath) {
    return [fileSourceUnit(filePath)];
  }

  const resolution = resolveSymbol(db, target);
  if (resolution.candidates.length > 0) throw new Error(`Ambiguous symbol: ${target}. Use an exact symbol.`);
  const match = resolution.match;
  if (!match) {
    return [];
  }

  const definition = index.definitionsForFile(match.relativePath).find((entry) => entry.symbolId === match.symbolId);
  if (!definition) {
    return [
      {
        unit: {
          kind: 'symbol',
          file: match.relativePath,
          shortName: shortenSymbol(match.symbol),
          symbol: match.symbol,
          startLine: match.startLine,
          endLine: match.endLine,
        },
      },
    ];
  }

  return [definitionSourceUnit(definition)];
}

function scanFileSourceUnits(
  db: ScipDatabase,
  scope: string | undefined,
  scanLimit: number | undefined,
): SourceUnitWithDefinition[] {
  const docs = indexedDocumentPaths(db, {
    scope,
    includeIgnored: false,
  });
  const limit = positiveInteger(scanLimit, docs.length);

  return docs.slice(0, limit).map((path) => fileSourceUnit(path));
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ownership evidence, counterevidence, and ranking form one candidate.
function buildLocalityCandidate(
  db: ScipDatabase,
  index: ProjectIndex,
  graph: Map<string, Set<string>>,
  source: SourceUnitWithDefinition,
  options: LocalityCandidatesOptions,
  indexedDirectories: Set<string>,
  architecturalBoundarySegments: ReadonlySet<string>,
): LocalityCandidate {
  const consumerFiles = source.definition
    ? symbolConsumerFiles(db, index, source.definition, options.semantic)
    : fileConsumerFiles(graph, source.unit.file);
  const consumerCoverage = source.definition
    ? consumerFiles.length > 0
      ? 'symbol-observations'
      : 'none'
    : consumerFiles.length > 0
      ? 'file-level'
      : 'none';
  const candidatePath = source.unit.file;
  const currentDirectory = normalizeDirectory(posix.dirname(candidatePath));
  const nearestCommonDirectory = commonDirectoryForFiles(consumerFiles);
  const directoryAncestry = directoryAncestryFor(currentDirectory);
  const boundaryMarkers = unique([
    ...boundaryMarkersForPath(currentDirectory),
    ...(nearestCommonDirectory ? boundaryMarkersForPath(nearestCommonDirectory) : []),
  ]);
  const tier = recommendedTier(source.unit, currentDirectory, nearestCommonDirectory, consumerFiles);
  const destination = destinationAssessmentFor(
    tier,
    source.unit,
    currentDirectory,
    nearestCommonDirectory,
    consumerFiles,
    indexedDirectories,
    architecturalBoundarySegments,
  );
  const counterevidence = counterevidenceFor(
    source.unit,
    consumerCoverage,
    nearestCommonDirectory,
    consumerFiles,
    currentDirectory,
    destination.whyNoSuggestedHome,
  );
  const reasons = reasonsFor(
    source.unit,
    currentDirectory,
    nearestCommonDirectory,
    consumerFiles,
    destination.suggestedHome,
    destination.whyNoSuggestedHome,
  );

  return {
    actionTier: 'signal',
    sourceUnit: source.unit,
    candidatePath,
    currentDirectory,
    directoryAncestry,
    consumerFiles,
    consumerCoverage,
    nearestCommonDirectory,
    boundaryMarkers,
    recommendedTier: tier,
    suggestedHome: destination.suggestedHome,
    destinationConfidence: destination.confidence,
    whyNoSuggestedHome: destination.whyNoSuggestedHome,
    counterevidence,
    reasons,
    recommendation: localityRecommendationFor(tier, destination.suggestedHome, consumerCoverage),
  };
}

function symbolConsumerFiles(
  db: ScipDatabase,
  index: ProjectIndex,
  definition: IndexedDefinition,
  semantic: boolean | undefined,
): string[] {
  const consumers = consumerFileMapFromEvidence(
    consumerEvidenceProduct(db, index).forDefinitions([definition], {
      semantic: semantic !== false,
      sourceFallback: true,
    }),
  );
  return sortedUnique(consumers.get(definition.symbolId) ?? []);
}

function fileConsumerFiles(graph: Map<string, Set<string>>, targetFile: string): string[] {
  const consumers: string[] = [];
  for (const [fromFile, toFiles] of graph.entries()) {
    if (fromFile !== targetFile && toFiles.has(targetFile)) {
      consumers.push(fromFile);
    }
  }
  return sortedUnique(consumers);
}

function resolveIndexedFilePath(db: ScipDatabase, target: string): string | null {
  const normalizedTarget = normalizePath(target);
  const docs = indexedDocumentPaths(db, {
    includeIgnored: false,
  });
  const exact = docs.find((path) => path === normalizedTarget);
  if (exact) {
    return exact;
  }
  const suffixes = docs.filter((path) => path.endsWith(`/${normalizedTarget}`));
  return suffixes.length === 1 ? suffixes[0]! : null;
}

function definitionSourceUnit(definition: IndexedDefinition): SourceUnitWithDefinition {
  return {
    definition,
    unit: {
      kind: 'symbol',
      file: definition.relativePath,
      shortName: shortenSymbol(definition.symbol),
      symbol: definition.symbol,
      startLine: definition.startLine,
      endLine: definition.endLine,
    },
  };
}

function fileSourceUnit(file: string): SourceUnitWithDefinition {
  return {
    unit: {
      kind: 'file',
      file,
      shortName: posix.basename(file),
    },
  };
}

function directoryAncestryFor(directory: string): LocalityDirectoryAncestor[] {
  if (directory === '.') {
    return [{ path: '.', depth: 0, markers: [] }];
  }

  const ancestry: LocalityDirectoryAncestor[] = [];
  const segments = directory.split('/').filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const path = segments.slice(0, index + 1).join('/');
    ancestry.push({
      path,
      depth: index,
      markers: markerLabelsForPath(path),
    });
  }
  return ancestry;
}

function boundaryMarkersForPath(path: string): string[] {
  if (path === '.') {
    return [];
  }

  return markerEntriesForPath(path).map(({ marker, prefix }) => `${marker}: ${prefix}`);
}

function markerLabelsForPath(path: string): string[] {
  return unique(markerEntriesForPath(path).map(({ marker }) => marker));
}

function markerEntriesForPath(path: string): Array<{ marker: string; prefix: string }> {
  const segments = path.split('/').filter(Boolean);
  const markers: Array<{ marker: string; prefix: string }> = [];
  for (let index = 0; index < segments.length; index += 1) {
    const marker = BOUNDARY_SEGMENTS.get(segments[index]);
    if (marker) {
      markers.push({
        marker,
        prefix: segments.slice(0, index + 1).join('/'),
      });
    }
  }
  return markers;
}

function commonDirectoryForFiles(files: string[]): string | null {
  if (files.length === 0) {
    return null;
  }
  const directories = files.map((file) => normalizeDirectory(posix.dirname(file)));
  let common = directories[0].split('/').filter(Boolean);

  for (const directory of directories.slice(1)) {
    const segments = directory.split('/').filter(Boolean);
    const next: string[] = [];
    const max = Math.min(common.length, segments.length);
    for (let index = 0; index < max; index += 1) {
      if (common[index] !== segments[index]) {
        break;
      }
      next.push(common[index]);
    }
    common = next;
  }

  return common.length === 0 ? '.' : common.join('/');
}

function recommendedTier(
  sourceUnit: LocalitySourceUnit,
  currentDirectory: string,
  nearestCommonDirectory: string | null,
  consumerFiles: string[],
): LocalityRecommendedTier {
  if (!nearestCommonDirectory) {
    return 'no-observed-consumers';
  }
  if (sourceUnit.kind === 'symbol' && consumerFiles.length === 1) {
    return consumerFiles[0] === sourceUnit.file ? 'same-file' : 'sibling-folder';
  }
  if (nearestCommonDirectory === '.' || nearestCommonDirectory === 'src') {
    return 'repository-level-review';
  }
  if (hasMarker(nearestCommonDirectory, 'package')) {
    return 'package-level-shared';
  }
  if (hasMarker(nearestCommonDirectory, 'app')) {
    return 'app-level-shared';
  }
  if (
    hasAnyMarker(nearestCommonDirectory, ['feature', 'domain', 'module']) ||
    hasAnyMarker(currentDirectory, ['feature', 'domain', 'module'])
  ) {
    return 'feature-local-shared';
  }
  return 'sibling-folder';
}

function destinationAssessmentFor(
  tier: LocalityRecommendedTier,
  sourceUnit: LocalitySourceUnit,
  currentDirectory: string,
  nearestCommonDirectory: string | null,
  consumerFiles: string[],
  indexedDirectories: Set<string>,
  architecturalBoundarySegments: ReadonlySet<string>,
): DestinationAssessment {
  const unsupportedReason = unsupportedDestinationReason(tier, nearestCommonDirectory);
  if (unsupportedReason) return withheldDestination(unsupportedReason);

  const sourceRoot = sourceRootFor(sourceUnit.file);
  const directDestination = directDestinationFor(
    tier,
    currentDirectory,
    sourceRoot,
    consumerFiles,
    architecturalBoundarySegments,
  );
  if (directDestination) return directDestination;

  const owner = nearestCommonDirectory!;
  if (normalizeDirectory(currentDirectory) === normalizeDirectory(owner)) {
    return withheldDestination(`${currentDirectory} is already the nearest common directory for its consumers.`);
  }

  const sharedOwnerDestination = sharedOwnerDestinationFor(
    owner,
    currentDirectory,
    sourceRoot,
    architecturalBoundarySegments,
  );
  if (sharedOwnerDestination) return sharedOwnerDestination;

  return proposedSharedHomeDestinationFor(
    owner,
    currentDirectory,
    sourceRoot,
    indexedDirectories,
    architecturalBoundarySegments,
  );
}

function unsupportedDestinationReason(
  tier: LocalityRecommendedTier,
  nearestCommonDirectory: string | null,
): string | null {
  if (!nearestCommonDirectory) {
    return 'No shared consumer directory was observed in the current evidence.';
  }
  if (tier === 'no-observed-consumers' || tier === 'repository-level-review') {
    return 'The inferred owner is too broad or unsupported for an suggested destination.';
  }
  return null;
}

function directDestinationFor(
  tier: LocalityRecommendedTier,
  currentDirectory: string,
  sourceRoot: string,
  consumerFiles: string[],
  architecturalBoundarySegments: ReadonlySet<string>,
): DestinationAssessment | null {
  if (tier === 'same-file') {
    const home = consumerFiles[0] ?? null;
    return home ? candidateDestination(home) : withheldDestination('No same-file consumer path was available.');
  }
  if (tier === 'sibling-folder' && consumerFiles.length === 1) {
    const destination = normalizeDirectory(posix.dirname(consumerFiles[0]));
    const boundaryReason = boundaryDestinationReason(
      currentDirectory,
      sourceRoot,
      destination,
      architecturalBoundarySegments,
    );
    if (boundaryReason) return withheldDestination(boundaryReason);
    return candidateDestination(destination);
  }
  return null;
}

function sharedOwnerDestinationFor(
  owner: string,
  currentDirectory: string,
  sourceRoot: string,
  architecturalBoundarySegments: ReadonlySet<string>,
): DestinationAssessment | null {
  if (!endsWithSharedHomeSegment(owner)) return null;
  return candidateDestinationWithinBoundary(
    owner,
    currentDirectory,
    sourceRoot,
    architecturalBoundarySegments,
    `Nearest shared owner ${owner} is outside source root ${sourceRoot}.`,
  );
}

function proposedSharedHomeDestinationFor(
  owner: string,
  currentDirectory: string,
  sourceRoot: string,
  indexedDirectories: Set<string>,
  architecturalBoundarySegments: ReadonlySet<string>,
): DestinationAssessment {
  if (owner === '.') {
    return withheldDestination('The nearest common directory is the repository root.');
  }
  const proposedHome = `${owner}/shared`;
  const destination = candidateDestinationWithinBoundary(
    proposedHome,
    currentDirectory,
    sourceRoot,
    architecturalBoundarySegments,
    `Proposed home ${proposedHome} is outside source root ${sourceRoot}.`,
  );
  if (destination.confidence === 'withheld') return destination;
  if (!indexedDirectories.has(proposedHome)) {
    return withheldDestination(`${proposedHome} does not exist in the indexed project.`);
  }

  return destination;
}

function candidateDestinationWithinBoundary(
  destination: string,
  currentDirectory: string,
  sourceRoot: string,
  architecturalBoundarySegments: ReadonlySet<string>,
  outsideSourceRootReason: string,
): DestinationAssessment {
  if (!isWithinDirectory(destination, sourceRoot)) {
    return withheldDestination(outsideSourceRootReason);
  }
  const boundaryReason = boundaryDestinationReason(
    currentDirectory,
    sourceRoot,
    destination,
    architecturalBoundarySegments,
  );
  if (boundaryReason) return withheldDestination(boundaryReason);
  return candidateDestination(destination);
}

function candidateDestination(suggestedHome: string): DestinationAssessment {
  return { suggestedHome, confidence: 'candidate', whyNoSuggestedHome: null };
}

function withheldDestination(whyNoSuggestedHome: string): DestinationAssessment {
  return { suggestedHome: null, confidence: 'withheld', whyNoSuggestedHome };
}

function counterevidenceFor(
  sourceUnit: LocalitySourceUnit,
  consumerCoverage: LocalityConsumerCoverage,
  nearestCommonDirectory: string | null,
  consumerFiles: string[],
  currentDirectory: string,
  whyNoSuggestedHome: string | null,
): string[] {
  const evidence: string[] = [
    'Path and observed-consumer heuristic; confirm conceptual ownership, complete consumers and behavior before moving files.',
  ];
  if (consumerCoverage === 'none') {
    evidence.push('No consumers were found in the current index.');
  }
  if (consumerCoverage === 'file-level') {
    evidence.push('File-level import evidence can hide which exported unit is actually used.');
  }
  if (nearestCommonDirectory === '.' || nearestCommonDirectory === 'src') {
    evidence.push('Nearest common directory is broad, so this is not enough evidence for automatic placement.');
  }
  if (consumerFiles.length === 1) {
    evidence.push(
      'Only one consumer was found; inlining or same-folder placement may be better than shared extraction.',
    );
  }
  if (sourceUnit.kind === 'file') {
    evidence.push('File targets describe module locality, not symbol-level usage.');
  }
  if (nearestCommonDirectory && currentDirectory.startsWith(`${nearestCommonDirectory}/`)) {
    evidence.push('Candidate already lives under the nearest common directory.');
  }
  if (whyNoSuggestedHome) {
    evidence.push(`No suggested home: ${whyNoSuggestedHome}`);
  }
  return evidence;
}

function reasonsFor(
  sourceUnit: LocalitySourceUnit,
  currentDirectory: string,
  nearestCommonDirectory: string | null,
  consumerFiles: string[],
  suggestedHome: string | null,
  whyNoSuggestedHome: string | null,
): string[] {
  const reasons: string[] = [];
  reasons.push(`${sourceUnit.shortName} currently lives in ${currentDirectory}.`);
  if (nearestCommonDirectory) {
    reasons.push(
      `${consumerFiles.length} consumer file(s) share ${nearestCommonDirectory} as their nearest common directory.`,
    );
  } else {
    reasons.push('No shared consumer directory was observed in the current evidence.');
  }
  if (suggestedHome) {
    reasons.push(`Suggested home is ${suggestedHome}.`);
  } else if (whyNoSuggestedHome) {
    reasons.push(`No suggested home: ${whyNoSuggestedHome}`);
  }
  return reasons;
}

function localityRecommendationFor(
  tier: LocalityRecommendedTier,
  suggestedHome: string | null,
  consumerCoverage: LocalityConsumerCoverage,
): string {
  if (tier === 'no-observed-consumers') {
    return 'Review references before moving; no consumers were found.';
  }
  if (tier === 'repository-level-review') {
    return 'Keep this as a broad locality signal; the inferred owner is too general for automatic relocation.';
  }
  if (!suggestedHome) {
    return 'Review ownership manually before changing structure.';
  }
  const coverage = consumerCoverage === 'symbol-observations' ? 'symbol usage' : 'module import';
  return `Review whether ${coverage} supports moving or extracting toward ${suggestedHome}.`;
}

function compareLocalityCandidates(a: LocalityCandidate, b: LocalityCandidate): number {
  return scoreLocalityCandidate(b) - scoreLocalityCandidate(a) || a.candidatePath.localeCompare(b.candidatePath);
}

function scoreLocalityCandidate(candidate: LocalityCandidate): number {
  let score = candidate.consumerFiles.length * 10;
  if (candidate.consumerCoverage === 'symbol-observations') {
    score += 5;
  }
  if (candidate.suggestedHome) {
    score += 3;
  }
  if (candidate.recommendedTier === 'repository-level-review') {
    score *= 0.1;
  }
  if (candidate.recommendedTier === 'no-observed-consumers') {
    score *= 0.05;
  }
  return score;
}

function directorySetForIndexedFiles(files: string[]): Set<string> {
  const directories = new Set<string>(['.']);
  for (const file of files) {
    let directory = normalizeDirectory(posix.dirname(file));
    while (!directories.has(directory)) {
      directories.add(directory);
      if (directory === '.') {
        break;
      }
      directory = normalizeDirectory(posix.dirname(directory));
    }
  }
  return directories;
}

function sourceRootFor(path: string): string {
  const segments = pathSegments(path);
  const sourceIndex = segments.indexOf('src');
  if (sourceIndex >= 0) {
    return segments.slice(0, sourceIndex + 1).join('/');
  }
  if (segments.length <= 1) {
    return '.';
  }
  return segments[0]!;
}

function isWithinDirectory(path: string, directory: string): boolean {
  const normalizedPath = normalizeDirectory(path);
  const normalizedDirectory = normalizeDirectory(directory);
  return (
    normalizedDirectory === '.' ||
    normalizedPath === normalizedDirectory ||
    normalizedPath.startsWith(`${normalizedDirectory}/`)
  );
}

function isArchitecturalBoundaryDirectory(
  currentDirectory: string,
  sourceRoot: string,
  architecturalBoundarySegments: ReadonlySet<string>,
): boolean {
  const currentSegments = pathSegments(currentDirectory);
  const rootSegments = pathSegments(sourceRoot);
  const localSegments = isWithinDirectory(currentDirectory, sourceRoot)
    ? currentSegments.slice(rootSegments.length)
    : currentSegments;

  return localSegments.some((segment) => architecturalBoundarySegments.has(segment.toLowerCase()));
}

function boundaryDestinationReason(
  currentDirectory: string,
  sourceRoot: string,
  destination: string,
  architecturalBoundarySegments: ReadonlySet<string>,
): string | null {
  if (normalizeDirectory(currentDirectory) === normalizeDirectory(destination)) {
    return null;
  }
  if (!isArchitecturalBoundaryDirectory(currentDirectory, sourceRoot, architecturalBoundarySegments)) {
    return null;
  }
  return `${currentDirectory} matches a protected directory-name marker; a move to ${destination} needs human design.`;
}

function architecturalBoundarySegmentsFor(...segmentLists: Array<readonly string[] | undefined>): ReadonlySet<string> {
  const segments = new Set(DEFAULT_ARCHITECTURAL_BOUNDARY_SEGMENTS);
  for (const list of segmentLists) {
    for (const segment of list ?? []) {
      const normalized = normalizeArchitecturalBoundarySegment(segment);
      if (normalized) {
        segments.add(normalized);
      }
    }
  }
  return segments;
}

function normalizeArchitecturalBoundarySegment(segment: string): string | null {
  const normalized = segment.trim().toLowerCase();
  return normalized === '' ? null : normalized;
}

function hasMarker(path: string, marker: string): boolean {
  return markerLabelsForPath(path).includes(marker);
}

function hasAnyMarker(path: string, markers: string[]): boolean {
  const labels = markerLabelsForPath(path);
  return markers.some((marker) => labels.includes(marker));
}

function endsWithSharedHomeSegment(path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  return last ? SHARED_HOME_SEGMENTS.has(last) : false;
}

function normalizeDirectory(directory: string): string {
  const normalized = normalizePath(directory);
  return normalized === '' ? '.' : normalized;
}

function pathSegments(path: string): string[] {
  const normalized = normalizePath(path);
  return normalized === '.' ? [] : normalized.split('/').filter(Boolean);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

// scip-query: ignore-twin — local ordering policy is independent from semantic identity construction.
function sortedUnique(values: Iterable<string>): string[] {
  return unique([...values]).sort((a, b) => a.localeCompare(b));
}

// scip-query: ignore-twin — generic collection helper is intentionally feature-local.
function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}
