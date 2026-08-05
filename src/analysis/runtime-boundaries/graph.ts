import { createHash } from 'node:crypto';
import type { ScipDatabase } from '../../storage/db.js';
import { getSourceFiles } from '../../source/primitives/source-fileset.js';
import { BOUNDARY_EXTRACTORS, boundaryFileContext } from './extractors.js';
import { deriveCarrierDiscriminators } from './carrier-discriminators.js';
import { composeHttpMounts } from './http-mounts.js';
import { propagateCompilerResolvedHttpSummaries } from './http-summaries.js';
import type {
  BoundaryEvidenceStrength,
  BoundaryFrontier,
  BoundaryKeyPart,
  BoundaryLink,
  BoundaryObservation,
  BoundaryRelationGroup,
  RuntimeBoundaryGraph,
} from './types.js';

export const RUNTIME_BOUNDARY_EXTRACTOR_VERSION = 'runtime-boundaries-v5';

interface GroupRule {
  id: string;
  protocol: string;
  producerActions: readonly string[];
  consumerActions: readonly string[];
  keyNames: readonly string[];
  traversable: boolean;
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
];

const MAX_MATERIALIZED_PAIRS_PER_GROUP = 64;

/** Extract and factor runtime evidence from all indexed source files. */
export function collectRuntimeBoundaryGraph(db: ScipDatabase): RuntimeBoundaryGraph {
  const files = getSourceFiles(db);
  const observations: BoundaryObservation[] = [];
  const extractionErrors: string[] = [];
  const coverage = new Map(
    BOUNDARY_EXTRACTORS.map((extractor) => [
      extractor.id,
      { id: extractor.id, applicableFiles: 0, observations: 0, errors: 0 },
    ]),
  );
  let filesWithAst = 0;

  for (const file of files) {
    const context = boundaryFileContext(db, file);
    if (!context) continue;
    filesWithAst += 1;
    for (const extractor of BOUNDARY_EXTRACTORS) {
      if (!extractor.supports(context)) continue;
      const extractorCoverage = coverage.get(extractor.id)!;
      extractorCoverage.applicableFiles += 1;
      try {
        const extracted = extractor.extract(context);
        extractorCoverage.observations += extracted.length;
        observations.push(...extracted);
      } catch (error) {
        extractorCoverage.errors += 1;
        extractionErrors.push(
          `${extractor.id} failed for ${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const primary = deduplicateObservations(observations);
  const propagated = propagateCompilerResolvedHttpSummaries(db, primary);
  coverage.set('builtin.wrapper', {
    id: 'builtin.wrapper',
    applicableFiles: propagated.filesInspected,
    observations: propagated.observations.length,
    errors: propagated.errors.length,
  });
  extractionErrors.push(...propagated.errors);
  const withHttpDerivations = deduplicateObservations([...primary, ...propagated.observations]);
  const withMounts = deduplicateObservations([...withHttpDerivations, ...composeHttpMounts(db, withHttpDerivations)]);
  const carriers = deriveCarrierDiscriminators(db, withMounts);
  coverage.set('builtin.carrier', {
    id: 'builtin.carrier',
    applicableFiles: carriers.bodySummaries,
    observations: carriers.observations.length,
    errors: carriers.errors.length,
  });
  extractionErrors.push(...carriers.errors);
  const deduplicated = deduplicateObservations([...withMounts, ...carriers.observations]);
  const relationGroups = buildRelationGroups(deduplicated);
  const links = materializeBoundedLinks(deduplicated, relationGroups);
  applyResolutionState(deduplicated, relationGroups);
  return {
    schemaVersion: 2,
    extractorVersion: RUNTIME_BOUNDARY_EXTRACTOR_VERSION,
    observations: deduplicated,
    relationGroups,
    links,
    frontiers: unresolvedFrontiers(deduplicated, relationGroups),
    coverage: {
      filesScanned: files.length,
      filesWithAst,
      filesWithoutAst: files.length - filesWithAst,
      extractors: [...coverage.values()],
      extractionErrors,
    },
  };
}

export function buildRelationGroups(observations: readonly BoundaryObservation[]): BoundaryRelationGroup[] {
  const groups = new Map<string, BoundaryRelationGroup>();
  for (const rule of GROUP_RULES) {
    const actions = new Set([...rule.producerActions, ...rule.consumerActions]);
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
  const traversableRules = new Set(GROUP_RULES.filter((rule) => rule.traversable).map((rule) => rule.id));
  for (const group of groups) {
    if (!traversableRules.has(group.joinRule) || group.producerIds.length === 0 || group.consumerIds.length === 0)
      continue;
    if (group.producerIds.length * group.consumerIds.length > MAX_MATERIALIZED_PAIRS_PER_GROUP) continue;
    for (const from of group.producerIds) {
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
  const linked = new Set(
    groups
      .filter((group) => group.producerIds.length > 0 && group.consumerIds.length > 0)
      .flatMap((group) => [...group.producerIds, ...group.consumerIds]),
  );
  for (const observation of observations) {
    observation.resolution = linked.has(observation.id) ? 'locally-linked' : 'unresolved';
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
  const grouped = new Set(groups.flatMap((group) => [...group.producerIds, ...group.consumerIds]));
  const paired = new Set(
    groups
      .filter((group) => group.producerIds.length > 0 && group.consumerIds.length > 0)
      .flatMap((group) => [...group.producerIds, ...group.consumerIds]),
  );
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
