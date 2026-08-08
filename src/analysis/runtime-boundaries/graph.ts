import { createHash } from 'node:crypto';
import { detectAstLanguage, isVueSfcPath } from '../../source/ast/ast-language.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getSourceFiles } from '../../source/primitives/source-fileset.js';
import { getSourceText } from '../../source/primitives/source-text.js';
import { BOUNDARY_EXTRACTORS, boundaryFileContext } from './extractors.js';
import { deriveCarrierDiscriminators } from './carrier-discriminators.js';
import { composeHttpMountsWithCoverage } from './http-mounts.js';
import { propagateCompilerResolvedHttpSummaries } from './http-summaries.js';
import { deriveDatabaseWorkQueueObservations } from './database-work-queues.js';
import type {
  BoundaryEvidenceStrength,
  BoundaryFrontier,
  BoundaryKeyPart,
  BoundaryLink,
  BoundaryObservation,
  BoundaryRelationGroup,
  RuntimeBoundaryFileCoverage,
  RuntimeBoundaryGraph,
  RuntimeBoundaryPhaseCoverage,
  RuntimeBoundaryPhaseId,
} from './types.js';

// Increment whenever direct facts or any derived propagation rule changes so an
// older persisted graph can never be incrementally mixed with newer semantics.
export const RUNTIME_BOUNDARY_EXTRACTOR_VERSION = 'runtime-boundaries-v15';

interface GroupRule {
  id: string;
  protocol: string;
  producerActions: readonly string[];
  consumerActions: readonly string[];
  declarationActions?: readonly string[];
  keyNames: readonly string[];
  traversable: boolean;
  linkFrom?: 'producer' | 'declaration';
  requireUniquePair?: boolean;
  requireUniqueConsumer?: boolean;
}

const GROUP_RULES: readonly GroupRule[] = [
  {
    id: 'http.method-path',
    protocol: 'http',
    producerActions: ['http.request'],
    consumerActions: ['http.handle'],
    keyNames: ['method', 'path'],
    traversable: true,
  },
  {
    id: 'registry.identity-key',
    protocol: 'registry',
    producerActions: ['registry.dispatch'],
    consumerActions: ['registry.handle'],
    keyNames: ['registry', 'key'],
    traversable: true,
  },
  {
    id: 'registry.capability-key',
    protocol: 'registry',
    producerActions: ['registry.reference'],
    consumerActions: ['registry.handle'],
    keyNames: ['key'],
    traversable: true,
    requireUniqueConsumer: true,
  },
  {
    id: 'queue.address',
    protocol: 'queue',
    producerActions: ['queue.send'],
    consumerActions: ['queue.consume'],
    keyNames: ['address'],
    traversable: true,
  },
  {
    id: 'carrier.discriminator',
    protocol: 'carrier',
    producerActions: ['carrier.publish'],
    consumerActions: ['carrier.consume'],
    keyNames: ['carrier', 'field', 'value'],
    traversable: true,
  },
  {
    id: 'resource.identity',
    protocol: 'database',
    producerActions: ['database.write'],
    consumerActions: ['database.read'],
    keyNames: ['resource'],
    traversable: false,
  },
  {
    id: 'framework.effect-httpapi-operation',
    protocol: 'framework',
    producerActions: [],
    consumerActions: ['framework.handle'],
    declarationActions: ['framework.declare'],
    keyNames: ['adapter', 'group', 'operation'],
    traversable: true,
    linkFrom: 'declaration',
    requireUniquePair: true,
  },
];

const MAX_MATERIALIZED_PAIRS_PER_GROUP = 64;

export interface RuntimeBoundaryCollectionOptions {
  previousGraph?: RuntimeBoundaryGraph;
  affectedFiles?: readonly string[];
}

/** Extract changed-file facts, retain covered unchanged-file facts, and globally refactor their relationships. */
export function collectRuntimeBoundaryGraph(
  db: ScipDatabase,
  opts: RuntimeBoundaryCollectionOptions = {},
): RuntimeBoundaryGraph {
  const files = getSourceFiles(db);
  const fileSet = new Set(files);
  const affectedFiles = new Set((opts.affectedFiles ?? []).map(normalizeBoundaryFile));
  const previousFileCoverage = opts.previousGraph?.fileCoverage;
  const incrementallyReusable =
    affectedFiles.size > 0 &&
    opts.previousGraph?.extractorVersion === RUNTIME_BOUNDARY_EXTRACTOR_VERSION &&
    previousFileCoverage !== undefined &&
    previousFileCoverage.length === opts.previousGraph.coverage.filesScanned;
  const retainedFileCoverage = incrementallyReusable
    ? previousFileCoverage.filter((entry) => fileSet.has(entry.file) && !affectedFiles.has(entry.file))
    : [];
  const retainedObservationIds = new Set(retainedFileCoverage.flatMap((entry) => entry.observationIds));
  const retainedObservations = incrementallyReusable
    ? opts.previousGraph!.observations.filter(
        (observation) => retainedObservationIds.has(observation.id) && fileSet.has(observation.source.file),
      )
    : [];
  const filesToExtract = incrementallyReusable ? files.filter((file) => affectedFiles.has(file)) : files;
  const phases: RuntimeBoundaryPhaseCoverage[] = [];
  const previousDirectObservationCount =
    previousFileCoverage?.reduce((total, entry) => total + entry.observationIds.length, 0) ?? 0;
  let phaseStartedAt = performance.now();
  const extracted = extractBoundaryFiles(db, filesToExtract);
  recordPhase(phases, 'direct-extraction', phaseStartedAt, filesToExtract.length, extracted.observations.length, {
    filesVisited: filesToExtract.length,
    filesReused: retainedFileCoverage.length,
    factsReused: retainedObservations.length,
    factsInvalidated: Math.max(0, previousDirectObservationCount - retainedObservations.length),
  });
  const fileCoverage = [...retainedFileCoverage, ...extracted.fileCoverage].sort((left, right) =>
    left.file.localeCompare(right.file),
  );
  const coverage = aggregateFileCoverage(fileCoverage);
  const extractionErrors = fileCoverage.flatMap((entry) => entry.extractionErrors);
  const primary = deduplicateObservations([...retainedObservations, ...extracted.observations]);
  const withDatabaseQueues = deduplicateObservations([...primary, ...deriveDatabaseWorkQueueObservations(primary)]);
  phaseStartedAt = performance.now();
  const propagated = propagateCompilerResolvedHttpSummaries(db, withDatabaseQueues);
  recordPhase(phases, 'http-summary', phaseStartedAt, withDatabaseQueues.length, propagated.observations.length, {
    filesVisited: propagated.filesInspected,
  });
  coverage.set('builtin.wrapper', {
    id: 'builtin.wrapper',
    applicableFiles: propagated.filesInspected,
    observations: propagated.observations.length,
    errors: propagated.errors.length,
  });
  extractionErrors.push(...propagated.errors);
  const withHttpDerivations = deduplicateObservations([...withDatabaseQueues, ...propagated.observations]);
  phaseStartedAt = performance.now();
  const mountComposition = composeHttpMountsWithCoverage(db, withHttpDerivations);
  recordPhase(phases, 'http-mount', phaseStartedAt, withHttpDerivations.length, mountComposition.observations.length, {
    filesVisited: mountComposition.filesInspected,
  });
  const withMounts = deduplicateObservations([...withHttpDerivations, ...mountComposition.observations]);
  phaseStartedAt = performance.now();
  const carriers = deriveCarrierDiscriminators(db, withMounts);
  recordPhase(phases, 'carrier', phaseStartedAt, withMounts.length, carriers.observations.length, {
    filesVisited: carriers.filesInspected,
  });
  coverage.set('builtin.carrier', {
    id: 'builtin.carrier',
    applicableFiles: carriers.bodySummaries,
    observations: carriers.observations.length,
    errors: carriers.errors.length,
  });
  extractionErrors.push(...carriers.errors);
  const deduplicated = deduplicateObservations([...withMounts, ...carriers.observations]);
  phaseStartedAt = performance.now();
  const relationGroups = buildRelationGroups(deduplicated);
  recordPhase(phases, 'relations', phaseStartedAt, deduplicated.length, relationGroups.length);
  phaseStartedAt = performance.now();
  const links = materializeBoundedLinks(deduplicated, relationGroups);
  recordPhase(phases, 'links', phaseStartedAt, relationGroups.length, links.length);
  applyResolutionState(deduplicated, relationGroups);
  phaseStartedAt = performance.now();
  const frontiers = deduplicateFrontiers([
    ...unresolvedFrontiers(deduplicated, relationGroups),
    ...propagated.frontiers,
  ]);
  recordPhase(phases, 'frontiers', phaseStartedAt, deduplicated.length, frontiers.length);
  return {
    schemaVersion: 2,
    extractorVersion: RUNTIME_BOUNDARY_EXTRACTOR_VERSION,
    observations: deduplicated,
    relationGroups,
    links,
    frontiers,
    coverage: {
      filesScanned: files.length,
      filesWithAst: fileCoverage.filter((entry) => entry.hasAst).length,
      filesWithoutAst: fileCoverage.filter((entry) => !entry.hasAst).length,
      ...(incrementallyReusable ? { filesReused: retainedFileCoverage.length } : {}),
      extractors: [...coverage.values()],
      extractionErrors,
      phases,
    },
    fileCoverage,
  };
}

function recordPhase(
  phases: RuntimeBoundaryPhaseCoverage[],
  id: RuntimeBoundaryPhaseId,
  startedAt: number,
  inputFacts: number,
  outputFacts: number,
  details: Pick<RuntimeBoundaryPhaseCoverage, 'filesVisited' | 'filesReused' | 'factsReused' | 'factsInvalidated'> = {},
): void {
  phases.push({
    id,
    durationMs: Math.max(0, performance.now() - startedAt),
    inputFacts,
    outputFacts,
    ...details,
  });
}

function extractBoundaryFiles(
  db: ScipDatabase,
  files: readonly string[],
): { observations: BoundaryObservation[]; fileCoverage: RuntimeBoundaryFileCoverage[] } {
  const observations: BoundaryObservation[] = [];
  const fileCoverage: RuntimeBoundaryFileCoverage[] = [];
  for (const file of files) {
    const source = getSourceText(db, file);
    const applicableExtractors = BOUNDARY_EXTRACTORS.filter((extractor) => extractor.supports(source));
    const context = applicableExtractors.length > 0 ? boundaryFileContext(db, file) : null;
    const coverage: RuntimeBoundaryFileCoverage = {
      file,
      hasAst: context !== null || boundaryAstEligible(file, source),
      observationIds: [],
      extractors: [],
      extractionErrors: [],
    };
    if (context) {
      for (const extractor of applicableExtractors) {
        const extractorCoverage = { id: extractor.id, applicableFiles: 1, observations: 0, errors: 0 };
        try {
          const extracted = extractor.extract(context);
          extractorCoverage.observations = extracted.length;
          observations.push(...extracted);
          coverage.observationIds.push(...extracted.map((observation) => observation.id));
        } catch (error) {
          extractorCoverage.errors = 1;
          coverage.extractionErrors.push(
            `${extractor.id} failed for ${file}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        coverage.extractors.push(extractorCoverage);
      }
    }
    fileCoverage.push(coverage);
  }
  return { observations, fileCoverage };
}

function boundaryAstEligible(file: string, source: string): boolean {
  if (!source) return false;
  if (isVueSfcPath(file)) return /<script\b/iu.test(source);
  return detectAstLanguage(file) !== null;
}

function aggregateFileCoverage(fileCoverage: readonly RuntimeBoundaryFileCoverage[]) {
  const coverage = new Map(
    BOUNDARY_EXTRACTORS.map((extractor) => [
      extractor.id,
      { id: extractor.id, applicableFiles: 0, observations: 0, errors: 0 },
    ]),
  );
  for (const file of fileCoverage) {
    for (const extractor of file.extractors) {
      const total = coverage.get(extractor.id);
      if (!total) continue;
      total.applicableFiles += extractor.applicableFiles;
      total.observations += extractor.observations;
      total.errors += extractor.errors;
    }
  }
  return coverage;
}

function normalizeBoundaryFile(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\//u, '');
}

export function buildRelationGroups(observations: readonly BoundaryObservation[]): BoundaryRelationGroup[] {
  const groups = new Map<string, BoundaryRelationGroup>();
  for (const rule of GROUP_RULES) {
    const actions = new Set([...rule.producerActions, ...rule.consumerActions, ...(rule.declarationActions ?? [])]);
    for (const observation of observations) {
      if (!actions.has(observation.action) || observation.strength === 'candidate') continue;
      const keyParts = resolvedKeys(observation, rule.keyNames);
      if (!keyParts) continue;
      const normalizedKey = keyParts
        .map((part) => `${part.name}=${normalizedKeyPart(part.name, part.value)}`)
        .join('\0');
      const scopeKey = observation.sourceScope === 'production' ? 'production' : observation.sourceScope;
      const identity = `${rule.id}\0${scopeKey}\0${normalizedKey}`;
      const id = `boundary-group:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
      const group = groups.get(id) ?? {
        id,
        protocol: rule.protocol,
        joinRule: rule.id,
        normalizedKey,
        keyParts,
        producerIds: [],
        consumerIds: [],
        declarationIds: [],
        derivation: {
          kind: 'mechanically-derived' as const,
          rule: rule.id,
          ruleVersion: '2',
          inputFactIds: [],
          sourceSpans: [],
        },
      };
      if (rule.producerActions.includes(observation.action)) group.producerIds.push(observation.id);
      if (rule.consumerActions.includes(observation.action)) group.consumerIds.push(observation.id);
      if (rule.declarationActions?.includes(observation.action)) group.declarationIds.push(observation.id);
      group.derivation.inputFactIds.push(observation.id);
      group.derivation.sourceSpans.push(observation.source);
      groups.set(id, group);
    }
  }
  return [...groups.values()].map(normalizeGroup).sort(compareGroups);
}

function normalizeGroup(group: BoundaryRelationGroup): BoundaryRelationGroup {
  return {
    ...group,
    producerIds: uniqueSorted(group.producerIds),
    consumerIds: uniqueSorted(group.consumerIds),
    declarationIds: uniqueSorted(group.declarationIds),
    derivation: {
      ...group.derivation,
      inputFactIds: uniqueSorted(group.derivation.inputFactIds),
      sourceSpans: [
        ...new Map(
          group.derivation.sourceSpans.map((span) => [`${span.file}:${span.startLine}:${span.endLine}`, span]),
        ).values(),
      ],
    },
  };
}

export function materializeBoundedLinks(
  observations: readonly BoundaryObservation[],
  groups: readonly BoundaryRelationGroup[],
): BoundaryLink[] {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const links = new Map<string, BoundaryLink>();
  for (const group of groups) {
    const rule = GROUP_RULES.find((candidate) => candidate.id === group.joinRule);
    if (!rule?.traversable) continue;
    const fromIds = rule.linkFrom === 'declaration' ? group.declarationIds : group.producerIds;
    if (fromIds.length === 0 || group.consumerIds.length === 0) continue;
    if (rule.requireUniquePair && (fromIds.length !== 1 || group.consumerIds.length !== 1)) continue;
    if (rule.requireUniqueConsumer && group.consumerIds.length !== 1) continue;
    if (fromIds.length * group.consumerIds.length > MAX_MATERIALIZED_PAIRS_PER_GROUP) continue;
    for (const from of fromIds) {
      for (const to of group.consumerIds) {
        const left = byId.get(from);
        const right = byId.get(to);
        if (!left || !right || sameSite(left, right)) continue;
        const strength: BoundaryEvidenceStrength =
          left.strength === 'derived' || right.strength === 'derived' ? 'derived' : 'exact';
        const identity = `${group.joinRule}\0${from}\0${to}`;
        const link: BoundaryLink = {
          id: `boundary-link:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`,
          from,
          to,
          joinRule: group.joinRule,
          matchedKeyParts: group.keyParts,
          strength,
          derivation: {
            kind: 'mechanically-derived',
            rule: group.joinRule,
            ruleVersion: '2',
            inputFactIds: [from, to],
            sourceSpans: [left.source, right.source],
          },
        };
        links.set(link.id, link);
      }
    }
  }
  return [...links.values()].sort(compareLinks);
}

function applyResolutionState(
  observations: readonly BoundaryObservation[],
  groups: readonly BoundaryRelationGroup[],
): void {
  const linked = new Set(groups.filter(groupHasProvenCounterpart).flatMap(groupParticipants));
  const ambiguous = new Set(groups.filter(groupHasAmbiguousCounterpart).flatMap(groupParticipants));
  for (const observation of observations) {
    observation.resolution = linked.has(observation.id)
      ? 'locally-linked'
      : ambiguous.has(observation.id)
        ? 'ambiguous'
        : 'unresolved';
  }
}

function unresolvedFrontiers(
  observations: readonly BoundaryObservation[],
  groups: readonly BoundaryRelationGroup[],
): BoundaryFrontier[] {
  const provedSites = new Set(
    observations
      .filter((observation) => observation.strength !== 'candidate')
      .map(
        (observation) =>
          `${observation.action}\0${observation.source.file}\0${observation.source.startLine}\0${observation.source.endLine}`,
      ),
  );
  const grouped = new Set(groups.flatMap(groupParticipants));
  const paired = new Set(groups.filter(groupHasProvenCounterpart).flatMap(groupParticipants));
  return observations
    .filter((observation) => observation.sourceScope === 'production')
    .filter(
      (observation) =>
        observation.strength !== 'candidate' ||
        !provedSites.has(
          `${observation.action}\0${observation.source.file}\0${observation.source.startLine}\0${observation.source.endLine}`,
        ),
    )
    .filter((observation) => !paired.has(observation.id))
    .map((observation): BoundaryFrontier => {
      const missingKeyParts = observation.keyParts
        .filter((part) => part.evidence === 'expression' || part.value.length === 0)
        .map((part) => part.name);
      const reason =
        missingKeyParts.length > 0
          ? `${observation.extractor} observed ${observation.action}, but ${missingKeyParts.join(', ')} remained symbolic or unknown.`
          : observation.resolution === 'ambiguous'
            ? `${observation.extractor} established the address for ${observation.action}, but more than one indexed peer has the same runtime key.`
            : grouped.has(observation.id)
              ? `${observation.extractor} established the address for ${observation.action}, but the indexed production scope contains no counterpart role in that relation group.`
              : `${observation.extractor} observed ${observation.action}, but no supported factorization rule could establish its addressed relation.`;
      return {
        observationId: observation.id,
        reason,
        missingKeyParts,
        sourceScope: observation.sourceScope,
      };
    })
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
}

function groupParticipants(group: BoundaryRelationGroup): string[] {
  return [...group.producerIds, ...group.consumerIds, ...group.declarationIds];
}

function groupHasProvenCounterpart(group: BoundaryRelationGroup): boolean {
  const rule = GROUP_RULES.find((candidate) => candidate.id === group.joinRule);
  if (!rule) return false;
  const fromIds = rule.linkFrom === 'declaration' ? group.declarationIds : group.producerIds;
  if (fromIds.length === 0 || group.consumerIds.length === 0) return false;
  return !rule.requireUniquePair || (fromIds.length === 1 && group.consumerIds.length === 1);
}

function groupHasAmbiguousCounterpart(group: BoundaryRelationGroup): boolean {
  const rule = GROUP_RULES.find((candidate) => candidate.id === group.joinRule);
  if (!rule?.requireUniquePair) return false;
  const fromIds = rule.linkFrom === 'declaration' ? group.declarationIds : group.producerIds;
  return fromIds.length > 0 && group.consumerIds.length > 0 && (fromIds.length !== 1 || group.consumerIds.length !== 1);
}

function deduplicateFrontiers(frontiers: readonly BoundaryFrontier[]): BoundaryFrontier[] {
  return [...new Map(frontiers.map((frontier) => [frontier.observationId, frontier])).values()].sort((left, right) =>
    left.observationId.localeCompare(right.observationId),
  );
}

function resolvedKeys(observation: BoundaryObservation, keyNames: readonly string[]): BoundaryKeyPart[] | null {
  const keys: BoundaryKeyPart[] = [];
  for (const name of keyNames) {
    const part = observation.keyParts.find((candidate) => candidate.name === name);
    if (!part || part.evidence === 'expression' || part.value.length === 0) return null;
    keys.push({ ...part, value: normalizedKeyPart(name, part.value) });
  }
  return keys;
}

function normalizedKeyPart(name: string, value: string): string {
  if (name === 'method') return value.toUpperCase();
  if (name !== 'path') return value;
  const normalized = value.startsWith('/') ? value : `/${value}`;
  return normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized;
}

function sameSite(left: BoundaryObservation, right: BoundaryObservation): boolean {
  return left.source.file === right.source.file && left.source.startLine === right.source.startLine;
}

function deduplicateObservations(observations: readonly BoundaryObservation[]): BoundaryObservation[] {
  return [...new Map(observations.map((observation) => [observation.id, observation])).values()].sort(
    (left, right) =>
      left.source.file.localeCompare(right.source.file) ||
      left.source.startLine - right.source.startLine ||
      left.action.localeCompare(right.action),
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function compareGroups(left: BoundaryRelationGroup, right: BoundaryRelationGroup): number {
  return left.joinRule.localeCompare(right.joinRule) || left.normalizedKey.localeCompare(right.normalizedKey);
}

function compareLinks(left: BoundaryLink, right: BoundaryLink): number {
  return (
    left.joinRule.localeCompare(right.joinRule) ||
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to)
  );
}
