import { posix } from 'node:path';

import { ProjectIndex } from '../../core/project-index.js';
import type { IndexedDefinition } from '../../domain/types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { findFirstSymbolMatch } from '../../symbols/symbol-lookup.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { definitionConsumerFileMap } from '../internal/consumer-evidence.js';

export type LocalityActionTier = 'signal';

export type LocalityConsumerCoverage = 'exact' | 'file-level' | 'none';

export type LocalityRecommendedTier =
  | 'same-file'
  | 'sibling-folder'
  | 'feature-local-shared'
  | 'app-level-shared'
  | 'package-level-shared'
  | 'repository-level-review'
  | 'no-exact-consumers';

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
  nearestCommonOwner: string | null;
  boundaryMarkers: string[];
  recommendedTier: LocalityRecommendedTier;
  suggestedHome: string | null;
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
}

interface SourceUnitWithDefinition {
  unit: LocalitySourceUnit;
  definition?: IndexedDefinition;
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

export function localityCandidates(db: ScipDatabase, options: LocalityCandidatesOptions = {}): LocalityCandidate[] {
  const limit = positiveInteger(options.limit, DEFAULT_LIMIT);
  const minConsumers = positiveInteger(options.minConsumers, DEFAULT_MIN_CONSUMERS);
  const index = new ProjectIndex(db);
  const graph = index.fileDependencyGraph(options.scope);

  const sourceUnits = options.target
    ? resolveTargetSourceUnits(db, index, options.target)
    : scanFileSourceUnits(db, options.scope, options.scanLimit);

  const candidates = sourceUnits
    .map((source) => buildLocalityCandidate(index, graph, source, options))
    .filter((candidate) => candidate.consumerFiles.length >= minConsumers || options.target)
    .sort(compareLocalityCandidates);

  return candidates.slice(0, limit);
}

function resolveTargetSourceUnits(db: ScipDatabase, index: ProjectIndex, target: string): SourceUnitWithDefinition[] {
  const filePath = resolveIndexedFilePath(db, target);
  if (filePath) {
    return [fileSourceUnit(filePath)];
  }

  const match = findFirstSymbolMatch(db, target);
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

function buildLocalityCandidate(
  index: ProjectIndex,
  graph: Map<string, Set<string>>,
  source: SourceUnitWithDefinition,
  options: LocalityCandidatesOptions,
): LocalityCandidate {
  const consumerFiles = source.definition
    ? symbolConsumerFiles(index, source.definition, options.semantic)
    : fileConsumerFiles(graph, source.unit.file);
  const consumerCoverage = source.definition
    ? consumerFiles.length > 0
      ? 'exact'
      : 'none'
    : consumerFiles.length > 0
      ? 'file-level'
      : 'none';
  const candidatePath = source.unit.file;
  const currentDirectory = normalizeDirectory(posix.dirname(candidatePath));
  const nearestCommonOwner = nearestCommonDirectory(consumerFiles);
  const directoryAncestry = directoryAncestryFor(currentDirectory);
  const boundaryMarkers = unique([
    ...boundaryMarkersForPath(currentDirectory),
    ...(nearestCommonOwner ? boundaryMarkersForPath(nearestCommonOwner) : []),
  ]);
  const tier = recommendedTier(source.unit, currentDirectory, nearestCommonOwner, consumerFiles);
  const suggestedHome = suggestedHomeFor(tier, nearestCommonOwner, consumerFiles);
  const counterevidence = counterevidenceFor(
    source.unit,
    consumerCoverage,
    nearestCommonOwner,
    consumerFiles,
    currentDirectory,
  );
  const reasons = reasonsFor(source.unit, currentDirectory, nearestCommonOwner, consumerFiles, suggestedHome);

  return {
    actionTier: 'signal',
    sourceUnit: source.unit,
    candidatePath,
    currentDirectory,
    directoryAncestry,
    consumerFiles,
    consumerCoverage,
    nearestCommonOwner,
    boundaryMarkers,
    recommendedTier: tier,
    suggestedHome,
    counterevidence,
    reasons,
    recommendation: recommendationFor(tier, suggestedHome, consumerCoverage),
  };
}

function symbolConsumerFiles(
  index: ProjectIndex,
  definition: IndexedDefinition,
  semantic: boolean | undefined,
): string[] {
  const consumers = definitionConsumerFileMap(index, [definition], {
    semantic: semantic !== false,
    sourceFallback: true,
  });
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
  const suffix = docs.find((path) => path.endsWith(`/${normalizedTarget}`));
  if (suffix) {
    return suffix;
  }
  return docs.find((path) => path.includes(normalizedTarget)) ?? null;
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

function nearestCommonDirectory(files: string[]): string | null {
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
  nearestCommonOwner: string | null,
  consumerFiles: string[],
): LocalityRecommendedTier {
  if (!nearestCommonOwner) {
    return 'no-exact-consumers';
  }
  if (sourceUnit.kind === 'symbol' && consumerFiles.length === 1) {
    return consumerFiles[0] === sourceUnit.file ? 'same-file' : 'sibling-folder';
  }
  if (nearestCommonOwner === '.' || nearestCommonOwner === 'src') {
    return 'repository-level-review';
  }
  if (hasMarker(nearestCommonOwner, 'package')) {
    return 'package-level-shared';
  }
  if (hasMarker(nearestCommonOwner, 'app')) {
    return 'app-level-shared';
  }
  if (
    hasAnyMarker(nearestCommonOwner, ['feature', 'domain', 'module']) ||
    hasAnyMarker(currentDirectory, ['feature', 'domain', 'module'])
  ) {
    return 'feature-local-shared';
  }
  return 'sibling-folder';
}

function suggestedHomeFor(
  tier: LocalityRecommendedTier,
  nearestCommonOwner: string | null,
  consumerFiles: string[],
): string | null {
  if (!nearestCommonOwner) {
    return null;
  }
  if (tier === 'no-exact-consumers' || tier === 'repository-level-review') {
    return null;
  }
  if (tier === 'same-file') {
    return consumerFiles[0] ?? null;
  }
  if (tier === 'sibling-folder' && consumerFiles.length === 1) {
    return normalizeDirectory(posix.dirname(consumerFiles[0]));
  }
  if (endsWithSharedHomeSegment(nearestCommonOwner)) {
    return nearestCommonOwner;
  }
  return nearestCommonOwner === '.' ? null : `${nearestCommonOwner}/shared`;
}

function counterevidenceFor(
  sourceUnit: LocalitySourceUnit,
  consumerCoverage: LocalityConsumerCoverage,
  nearestCommonOwner: string | null,
  consumerFiles: string[],
  currentDirectory: string,
): string[] {
  const evidence: string[] = ['Report-only signal; review ownership before moving files.'];
  if (consumerCoverage === 'none') {
    evidence.push('No consumers were found in the current index.');
  }
  if (consumerCoverage === 'file-level') {
    evidence.push('File-level import evidence can hide which exported unit is actually used.');
  }
  if (nearestCommonOwner === '.' || nearestCommonOwner === 'src') {
    evidence.push('Nearest common owner is broad, so this is not enough evidence for automatic placement.');
  }
  if (consumerFiles.length === 1) {
    evidence.push(
      'Only one consumer was found; inlining or same-folder placement may be better than shared extraction.',
    );
  }
  if (sourceUnit.kind === 'file') {
    evidence.push('File targets describe module locality, not symbol-level usage.');
  }
  if (nearestCommonOwner && currentDirectory.startsWith(`${nearestCommonOwner}/`)) {
    evidence.push('Candidate already lives under the nearest common owner.');
  }
  return evidence;
}

function reasonsFor(
  sourceUnit: LocalitySourceUnit,
  currentDirectory: string,
  nearestCommonOwner: string | null,
  consumerFiles: string[],
  suggestedHome: string | null,
): string[] {
  const reasons: string[] = [];
  reasons.push(`${sourceUnit.shortName} currently lives in ${currentDirectory}.`);
  if (nearestCommonOwner) {
    reasons.push(`${consumerFiles.length} consumer file(s) share ${nearestCommonOwner} as their nearest common owner.`);
  } else {
    reasons.push('No consumer owner could be inferred from the current index.');
  }
  if (suggestedHome) {
    reasons.push(`Suggested home is ${suggestedHome}.`);
  }
  return reasons;
}

function recommendationFor(
  tier: LocalityRecommendedTier,
  suggestedHome: string | null,
  consumerCoverage: LocalityConsumerCoverage,
): string {
  if (tier === 'no-exact-consumers') {
    return 'Review references before moving; no consumers were found.';
  }
  if (tier === 'repository-level-review') {
    return 'Keep this as a broad locality signal; the inferred owner is too general for automatic relocation.';
  }
  if (!suggestedHome) {
    return 'Review ownership manually before changing structure.';
  }
  const coverage = consumerCoverage === 'exact' ? 'symbol usage' : 'module import';
  return `Review whether ${coverage} supports moving or extracting toward ${suggestedHome}.`;
}

function compareLocalityCandidates(a: LocalityCandidate, b: LocalityCandidate): number {
  return scoreLocalityCandidate(b) - scoreLocalityCandidate(a) || a.candidatePath.localeCompare(b.candidatePath);
}

function scoreLocalityCandidate(candidate: LocalityCandidate): number {
  let score = candidate.consumerFiles.length * 10;
  if (candidate.consumerCoverage === 'exact') {
    score += 5;
  }
  if (candidate.suggestedHome) {
    score += 3;
  }
  if (candidate.recommendedTier === 'repository-level-review') {
    score -= 8;
  }
  if (candidate.recommendedTier === 'no-exact-consumers') {
    score -= 12;
  }
  return score;
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

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function normalizeDirectory(directory: string): string {
  const normalized = normalizePath(directory);
  return normalized === '' ? '.' : normalized;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function sortedUnique(values: Iterable<string>): string[] {
  return unique([...values]).sort((a, b) => a.localeCompare(b));
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}
