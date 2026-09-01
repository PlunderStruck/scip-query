import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { createRequire } from 'node:module';
import type * as TypeScript from 'typescript';
import { detectAstLanguage, isVueSfcPath } from '../../source/ast/ast-language.js';
import type { ScipDatabase } from '../../storage/db.js';
import { withFileAccessRecording } from '../../domain/file-access-recorder.js';
import { getSourceFiles } from '../../source/primitives/source-fileset.js';
import { readSourceTextUncached } from '../../source/primitives/source-text.js';
import { fileContentHash } from '../../storage/evidence-cache.js';
import { createFileEvidenceProduct, evidenceProductInvalidation } from '../../storage/evidence-products.js';
import { BOUNDARY_EXTRACTORS, boundaryFileContext } from './extractors.js';
import type { RuntimeBoundaryProfileSpan } from './extractors.js';
import { deriveCarrierDiscriminators, serializedBodySummariesForFile } from './carrier-discriminators.js';
import { composeHttpMountsWithCoverage } from './http-mounts.js';
import { propagateCompilerResolvedHttpSummaries } from './http-summaries.js';
import { deriveDatabaseWorkQueueObservations } from './database-work-queues.js';
import { deduplicateFrontiers } from './frontiers.js';
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
export const RUNTIME_BOUNDARY_EXTRACTOR_VERSION = 'runtime-boundaries-v19';

const require = createRequire(import.meta.url);
const typescript = require('typescript') as typeof TypeScript;
const TYPESCRIPT_TRIVIA = new Set<TypeScript.SyntaxKind>([
  typescript.SyntaxKind.WhitespaceTrivia,
  typescript.SyntaxKind.NewLineTrivia,
  typescript.SyntaxKind.SingleLineCommentTrivia,
  typescript.SyntaxKind.MultiLineCommentTrivia,
]);
const TYPESCRIPT_LITERAL_VALUES = new Set<TypeScript.SyntaxKind>([
  typescript.SyntaxKind.NoSubstitutionTemplateLiteral,
  typescript.SyntaxKind.TemplateHead,
  typescript.SyntaxKind.TemplateMiddle,
  typescript.SyntaxKind.TemplateTail,
]);

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
const HTTP_SUMMARY_EXTRACTOR = 'builtin.http-summary';
const DERIVED_BOUNDARY_ACTIONS = {
  HTTP_HANDLE: 'http.handle',
  HTTP_REQUEST: 'http.request',
  REGISTRY_HANDLE: 'registry.handle',
} as const;
const DERIVED_BOUNDARY_ACTION_SET = new Set<string>(Object.values(DERIVED_BOUNDARY_ACTIONS));

export interface RuntimeBoundaryCollectionOptions {
  previousGraph?: RuntimeBoundaryGraph;
  affectedFiles?: readonly string[];
  /** Recompute compiler-derived relationships while retaining unchanged per-file extraction facts. */
  forceDerivedRebuild?: boolean;
  profileSpan?: RuntimeBoundaryProfileSpan;
}

/**
 * Extract changed-file facts, retain covered unchanged-file facts, and
 * globally refactor their relationships. Asynchronous so the extraction sweep
 * can yield the event loop: tree-sitter's native memory is released by V8
 * second-pass callbacks that only run on loop turns, and a synchronous
 * whole-repository sweep would retain every parsed tree until it finished.
 */
export async function collectRuntimeBoundaryGraph(
  db: ScipDatabase,
  opts: RuntimeBoundaryCollectionOptions = {},
): Promise<RuntimeBoundaryGraph> {
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
  const extracted = await extractBoundaryFiles(db, filesToExtract, opts.profileSpan);
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
  if (
    incrementallyReusable &&
    !opts.forceDerivedRebuild &&
    opts.previousGraph &&
    affectedDirectCoverageUnchanged(previousFileCoverage, extracted.fileCoverage, affectedFiles) &&
    (!affectedFilesMayChangeDerivedGraph(db, opts.previousGraph, affectedFiles) ||
      (affectedSyntaxUnchanged(previousFileCoverage, extracted.fileCoverage, affectedFiles) &&
        !affectedFilesAppearInGraph(opts.previousGraph, affectedFiles)))
  ) {
    for (const extractor of opts.previousGraph.coverage.extractors) {
      if (!coverage.has(extractor.id)) coverage.set(extractor.id, extractor);
    }
    const reusedPhases = reuseDerivedPhaseCoverage(opts.previousGraph.coverage.phases);
    phases.push(...reusedPhases);
    return {
      ...opts.previousGraph,
      observations: opts.previousGraph.observations,
      relationGroups: opts.previousGraph.relationGroups,
      links: opts.previousGraph.links,
      frontiers: opts.previousGraph.frontiers,
      coverage: {
        filesScanned: files.length,
        filesWithAst: fileCoverage.filter((entry) => entry.hasAst).length,
        filesWithoutAst: fileCoverage.filter((entry) => !entry.hasAst).length,
        filesReused: retainedFileCoverage.length,
        extractors: [...coverage.values()],
        extractionErrors: opts.previousGraph.coverage.extractionErrors,
        phases,
      },
      fileCoverage,
    };
  }
  const withDatabaseQueues = deduplicateObservations([...primary, ...deriveDatabaseWorkQueueObservations(primary)]);
  const httpSummaryReuse =
    incrementallyReusable && opts.previousGraph !== undefined
      ? httpSummaryReuseDecision(
          opts.previousGraph,
          previousFileCoverage,
          extracted.fileCoverage,
          affectedFiles,
          primary,
        )
      : { reuse: false, shapeUnchanged: false, proofFilesUnchanged: false, seedUnchanged: false };
  const reuseHttpSummary = httpSummaryReuse.reuse;
  opts.profileSpan?.('runtime-boundaries.http-summary.reuse-decision', () => undefined, httpSummaryReuse);
  phaseStartedAt = performance.now();
  let propagated: ReturnType<typeof propagateCompilerResolvedHttpSummaries>;
  if (reuseHttpSummary) {
    const previousHttpPhase = opts.previousGraph!.coverage.phases?.find((phase) => phase.id === 'http-summary');
    const previousWrapperCoverage = opts.previousGraph!.coverage.extractors.find(
      (extractor) => extractor.id === 'builtin.wrapper',
    );
    propagated = {
      observations: opts.previousGraph!.observations.filter(
        (observation) => observation.extractor === HTTP_SUMMARY_EXTRACTOR,
      ),
      frontiers: opts.previousGraph!.frontiers.filter(
        (frontier) => frontier.kind === 'call-resolution' && frontier.action === DERIVED_BOUNDARY_ACTIONS.HTTP_REQUEST,
      ),
      summaries: 0,
      filesInspected: previousHttpPhase?.filesVisited ?? previousWrapperCoverage?.applicableFiles ?? 0,
      errors: opts.previousGraph!.coverage.extractionErrors.filter((error) =>
        error.startsWith('builtin.http-summary failed'),
      ),
    };
    recordPhase(phases, 'http-summary', phaseStartedAt, withDatabaseQueues.length, propagated.observations.length, {
      filesVisited: 0,
      filesReused: propagated.filesInspected,
      factsReused: propagated.observations.length + propagated.frontiers.length,
      factsInvalidated: 0,
    });
    if (previousWrapperCoverage) coverage.set(previousWrapperCoverage.id, previousWrapperCoverage);
  } else {
    propagated = propagateCompilerResolvedHttpSummaries(db, withDatabaseQueues, opts.profileSpan);
    recordPhase(phases, 'http-summary', phaseStartedAt, withDatabaseQueues.length, propagated.observations.length, {
      filesVisited: propagated.filesInspected,
    });
    coverage.set('builtin.wrapper', {
      id: 'builtin.wrapper',
      applicableFiles: propagated.filesInspected,
      observations: propagated.observations.length,
      errors: propagated.errors.length,
    });
  }
  extractionErrors.push(...propagated.errors);
  const withHttpDerivations = deduplicateObservations([...withDatabaseQueues, ...propagated.observations]);
  phaseStartedAt = performance.now();
  const mountComposition = composeHttpMountsWithCoverage(db, withHttpDerivations);
  recordPhase(phases, 'http-mount', phaseStartedAt, withHttpDerivations.length, mountComposition.observations.length, {
    filesVisited: mountComposition.filesInspected,
  });
  const withMounts = deduplicateObservations([...withHttpDerivations, ...mountComposition.observations]);
  phaseStartedAt = performance.now();
  const reuseCarrier =
    reuseHttpSummary &&
    opts.previousGraph !== undefined &&
    canReuseCarrier(opts.previousGraph, previousFileCoverage, extracted.fileCoverage, affectedFiles);
  let carriers: ReturnType<typeof deriveCarrierDiscriminators>;
  if (reuseCarrier) {
    const previousCarrierPhase = opts.previousGraph!.coverage.phases?.find((phase) => phase.id === 'carrier');
    const previousCarrierCoverage = opts.previousGraph!.coverage.extractors.find(
      (extractor) => extractor.id === 'builtin.carrier',
    );
    carriers = {
      observations: opts.previousGraph!.observations.filter(
        (observation) => observation.extractor === 'builtin.carrier',
      ),
      bodySummaries: previousCarrierCoverage?.applicableFiles ?? 0,
      discriminatorSummaries: 0,
      filesInspected: previousCarrierPhase?.filesVisited ?? 0,
      errors: opts.previousGraph!.coverage.extractionErrors.filter((error) => error.startsWith('builtin.carrier')),
    };
    recordPhase(phases, 'carrier', phaseStartedAt, withMounts.length, carriers.observations.length, {
      filesVisited: 0,
      filesReused: carriers.filesInspected,
      factsReused: carriers.observations.length,
      factsInvalidated: 0,
    });
    if (previousCarrierCoverage) coverage.set(previousCarrierCoverage.id, previousCarrierCoverage);
  } else {
    carriers = deriveCarrierDiscriminators(
      db,
      withMounts,
      fileCoverage.flatMap((entry) => entry.bodySummaries ?? []),
    );
    recordPhase(phases, 'carrier', phaseStartedAt, withMounts.length, carriers.observations.length, {
      filesVisited: carriers.filesInspected,
    });
    coverage.set('builtin.carrier', {
      id: 'builtin.carrier',
      applicableFiles: carriers.bodySummaries,
      observations: carriers.observations.length,
      errors: carriers.errors.length,
    });
  }
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

function affectedDirectCoverageUnchanged(
  previousFileCoverage: readonly RuntimeBoundaryFileCoverage[] | undefined,
  currentAffectedCoverage: readonly RuntimeBoundaryFileCoverage[],
  affectedFiles: ReadonlySet<string>,
): boolean {
  if (!previousFileCoverage) return false;
  const previousAffectedCoverage = previousFileCoverage
    .filter((entry) => affectedFiles.has(entry.file))
    .filter(hasDirectBoundaryEffect)
    .map(directBoundaryCoverage)
    .sort((left, right) => left.file.localeCompare(right.file));
  const current = currentAffectedCoverage
    .filter(hasDirectBoundaryEffect)
    .map(directBoundaryCoverage)
    .sort((left, right) => left.file.localeCompare(right.file));
  return JSON.stringify(previousAffectedCoverage) === JSON.stringify(current);
}

function hasDirectBoundaryEffect(entry: RuntimeBoundaryFileCoverage): boolean {
  return entry.observationIds.length > 0 || entry.extractionErrors.length > 0;
}

function directBoundaryCoverage(
  entry: RuntimeBoundaryFileCoverage,
): Omit<RuntimeBoundaryFileCoverage, 'syntaxHash' | 'shapeHash' | 'bodySummaries'> {
  const { syntaxHash: _syntaxHash, shapeHash: _shapeHash, bodySummaries: _bodySummaries, ...coverage } = entry;
  return coverage;
}

function httpSummaryReuseDecision(
  previousGraph: RuntimeBoundaryGraph,
  previousFileCoverage: readonly RuntimeBoundaryFileCoverage[] | undefined,
  currentAffectedCoverage: readonly RuntimeBoundaryFileCoverage[],
  affectedFiles: ReadonlySet<string>,
  currentDirectObservations: readonly BoundaryObservation[],
): { reuse: boolean; shapeUnchanged: boolean; proofFilesUnchanged: boolean; seedUnchanged: boolean } {
  const shapeUnchanged = affectedShapeUnchanged(previousFileCoverage, currentAffectedCoverage, affectedFiles);
  const proofFiles = runtimeBoundaryHttpSummaryProofFiles(previousGraph);
  const changedFiles = syntaxChangedFiles(previousFileCoverage, currentAffectedCoverage);
  const proofFilesUnchanged = ![...changedFiles].some((file) => proofFiles.has(file));

  const previousDirectIds = new Set(
    (previousFileCoverage ?? [])
      .filter((entry) => affectedFiles.has(entry.file))
      .flatMap((entry) => entry.observationIds),
  );
  const currentDirectIds = new Set(currentAffectedCoverage.flatMap((entry) => entry.observationIds));
  const seedUnchanged =
    httpPropagationSeedSignature(previousGraph.observations, previousDirectIds) ===
    httpPropagationSeedSignature(currentDirectObservations, currentDirectIds);
  return {
    reuse: shapeUnchanged && proofFilesUnchanged && seedUnchanged,
    shapeUnchanged,
    proofFilesUnchanged,
    seedUnchanged,
  };
}

function syntaxChangedFiles(
  previousFileCoverage: readonly RuntimeBoundaryFileCoverage[] | undefined,
  currentAffectedCoverage: readonly RuntimeBoundaryFileCoverage[],
): Set<string> {
  const previousHashes = new Map(previousFileCoverage?.map((entry) => [entry.file, entry.syntaxHash] as const) ?? []);
  return new Set(
    currentAffectedCoverage
      .filter((entry) => entry.syntaxHash === undefined || previousHashes.get(entry.file) !== entry.syntaxHash)
      .map((entry) => entry.file),
  );
}

function canReuseCarrier(
  previousGraph: RuntimeBoundaryGraph,
  previousFileCoverage: readonly RuntimeBoundaryFileCoverage[] | undefined,
  currentAffectedCoverage: readonly RuntimeBoundaryFileCoverage[],
  affectedFiles: ReadonlySet<string>,
): boolean {
  if (!previousFileCoverage) return false;
  const previousBodySummaries = previousFileCoverage
    .filter((entry) => affectedFiles.has(entry.file))
    .map(({ file, bodySummaries }) => ({ file, bodySummaries: bodySummaries ?? [] }))
    .sort((left, right) => left.file.localeCompare(right.file));
  const currentBodySummaries = currentAffectedCoverage
    .map(({ file, bodySummaries }) => ({ file, bodySummaries: bodySummaries ?? [] }))
    .sort((left, right) => left.file.localeCompare(right.file));
  if (JSON.stringify(previousBodySummaries) !== JSON.stringify(currentBodySummaries)) return false;

  const changedFiles = syntaxChangedFiles(previousFileCoverage, currentAffectedCoverage);
  const proofFiles = runtimeBoundaryExtractorProofFiles(previousGraph, 'builtin.carrier');
  return ![...changedFiles].some((file) => proofFiles.has(file));
}

function runtimeBoundaryExtractorProofFiles(graph: RuntimeBoundaryGraph, extractor: string): Set<string> {
  const files = new Set<string>();
  for (const observation of graph.observations) {
    if (observation.extractor !== extractor) continue;
    files.add(observation.source.file);
    for (const span of observation.derivation.sourceSpans) files.add(span.file);
  }
  return files;
}

function affectedShapeUnchanged(
  previousFileCoverage: readonly RuntimeBoundaryFileCoverage[] | undefined,
  currentAffectedCoverage: readonly RuntimeBoundaryFileCoverage[],
  affectedFiles: ReadonlySet<string>,
): boolean {
  if (!previousFileCoverage) return false;
  const previousHashes = new Map(
    previousFileCoverage
      .filter((entry) => affectedFiles.has(entry.file))
      .map((entry) => [entry.file, entry.shapeHash] as const),
  );
  return (
    currentAffectedCoverage.length === affectedFiles.size &&
    currentAffectedCoverage.every(
      (entry) => entry.shapeHash !== undefined && previousHashes.get(entry.file) === entry.shapeHash,
    )
  );
}

function runtimeBoundaryHttpSummaryProofFiles(graph: RuntimeBoundaryGraph): Set<string> {
  const files = new Set<string>();
  for (const observation of graph.observations) {
    if (observation.extractor !== HTTP_SUMMARY_EXTRACTOR) continue;
    files.add(observation.source.file);
    for (const span of observation.derivation.sourceSpans) files.add(span.file);
  }
  for (const frontier of graph.frontiers) {
    if (
      frontier.kind === 'call-resolution' &&
      frontier.action === DERIVED_BOUNDARY_ACTIONS.HTTP_REQUEST &&
      frontier.source
    ) {
      files.add(frontier.source.file);
    }
  }
  return files;
}

function httpPropagationSeedSignature(
  observations: readonly BoundaryObservation[],
  directObservationIds: ReadonlySet<string>,
): string {
  return JSON.stringify(
    observations
      .filter(
        (observation) =>
          directObservationIds.has(observation.id) &&
          observation.action === DERIVED_BOUNDARY_ACTIONS.HTTP_REQUEST &&
          observation.owner.symbol !== null &&
          (observation.evidence === 'call-expression' || observation.evidence === 'client-adapter'),
      )
      .map((observation) => ({
        ownerSymbol: observation.owner.symbol,
        evidence: observation.evidence,
        methods: observation.keyParts
          .filter((part) => part.name === 'method' && part.evidence !== 'expression')
          .map((part) => part.value.toUpperCase())
          .sort(),
      }))
      .sort((left, right) =>
        `${left.ownerSymbol}\0${left.evidence}\0${left.methods.join(',')}`.localeCompare(
          `${right.ownerSymbol}\0${right.evidence}\0${right.methods.join(',')}`,
        ),
      ),
  );
}

function affectedFilesMayChangeDerivedGraph(
  db: ScipDatabase,
  previousGraph: RuntimeBoundaryGraph,
  affectedFiles: ReadonlySet<string>,
): boolean {
  const proofFiles = runtimeBoundaryDerivedProofFiles(previousGraph);
  const proofSymbols = runtimeBoundaryDerivedProofSymbols(previousGraph);
  if ([...affectedFiles].some((file) => proofFiles.has(file))) return true;
  if (proofSymbols.size === 0 || affectedFiles.size === 0) return false;

  const hasScipReferences = Boolean(
    db.get<{ present: number }>('SELECT 1 AS present FROM mentions WHERE role != 1 LIMIT 1'),
  );
  if (!hasScipReferences) return true;

  const files = [...affectedFiles];
  for (let offset = 0; offset < files.length; offset += 750) {
    const batch = files.slice(offset, offset + 750);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db.all<{ symbol: string }>(
      `SELECT DISTINCT global_symbol.symbol
       FROM mentions mention
       JOIN chunks reference_chunk ON reference_chunk.id = mention.chunk_id
       JOIN documents reference_document ON reference_document.id = reference_chunk.document_id
       JOIN global_symbols global_symbol ON global_symbol.id = mention.symbol_id
       WHERE mention.role != 1
         AND reference_document.relative_path IN (${placeholders})`,
      ...batch,
    );
    if (rows.some((row) => proofSymbols.has(row.symbol))) return true;
  }
  return false;
}

function runtimeBoundaryDerivedProofFiles(graph: RuntimeBoundaryGraph): Set<string> {
  const files = new Set<string>();
  for (const observation of graph.observations) {
    if (!DERIVED_BOUNDARY_ACTION_SET.has(observation.action)) continue;
    files.add(observation.source.file);
    for (const span of observation.derivation?.sourceSpans ?? []) files.add(span.file);
  }
  for (const frontier of graph.frontiers) {
    if (!frontier.action || !DERIVED_BOUNDARY_ACTION_SET.has(frontier.action) || !frontier.source) continue;
    files.add(frontier.source.file);
  }
  return files;
}

function runtimeBoundaryDerivedProofSymbols(graph: RuntimeBoundaryGraph): Set<string> {
  return new Set(
    graph.observations.flatMap((observation) =>
      DERIVED_BOUNDARY_ACTION_SET.has(observation.action) && observation.owner.symbol ? [observation.owner.symbol] : [],
    ),
  );
}

function affectedSyntaxUnchanged(
  previousFileCoverage: readonly RuntimeBoundaryFileCoverage[] | undefined,
  currentAffectedCoverage: readonly RuntimeBoundaryFileCoverage[],
  affectedFiles: ReadonlySet<string>,
): boolean {
  if (!previousFileCoverage) return false;
  const previousHashes = new Map(
    previousFileCoverage
      .filter((entry) => affectedFiles.has(entry.file))
      .map((entry) => [entry.file, entry.syntaxHash] as const),
  );
  return (
    currentAffectedCoverage.length === affectedFiles.size &&
    currentAffectedCoverage.every(
      (entry) => entry.syntaxHash !== undefined && previousHashes.get(entry.file) === entry.syntaxHash,
    )
  );
}

function affectedFilesAppearInGraph(previousGraph: RuntimeBoundaryGraph, affectedFiles: ReadonlySet<string>): boolean {
  const proofFiles = runtimeBoundaryProofFiles(previousGraph);
  return [...affectedFiles].some((file) => proofFiles.has(file));
}

function runtimeBoundaryProofFiles(graph: RuntimeBoundaryGraph): Set<string> {
  const files = new Set<string>();
  for (const observation of graph.observations) {
    files.add(observation.source.file);
    for (const span of observation.derivation?.sourceSpans ?? []) files.add(span.file);
  }
  for (const frontier of graph.frontiers) {
    if (frontier.source) files.add(frontier.source.file);
  }
  return files;
}

function reuseDerivedPhaseCoverage(
  previousPhases: readonly RuntimeBoundaryPhaseCoverage[] | undefined,
): RuntimeBoundaryPhaseCoverage[] {
  return (previousPhases ?? [])
    .filter((phase) => phase.id !== 'direct-extraction')
    .map((phase) => ({
      ...phase,
      durationMs: 0,
      filesVisited: 0,
      filesReused: phase.filesVisited ?? 0,
      factsReused: phase.outputFacts,
      factsInvalidated: 0,
    }));
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

const EXTRACTION_YIELD_INTERVAL_FILES = 256;

async function extractBoundaryFiles(
  db: ScipDatabase,
  files: readonly string[],
  profileSpan?: RuntimeBoundaryProfileSpan,
): Promise<{ observations: BoundaryObservation[]; fileCoverage: RuntimeBoundaryFileCoverage[] }> {
  const observations: BoundaryObservation[] = [];
  const fileCoverage: RuntimeBoundaryFileCoverage[] = [];
  const recordSpan: RuntimeBoundaryProfileSpan = profileSpan ?? ((_name, run) => run());
  const freshHashes: Array<{ relativePath: string; contentHash: string; value: BoundarySourceHashes }> = [];
  const freshDirect: Array<{ relativePath: string; contentHash: string; value: DirectExtractionPayload }> = [];
  const depHashes = new Map<string, string>();
  const currentDepHash = (path: string): string => {
    const known = depHashes.get(path);
    if (known !== undefined) return known;
    const computed = fileContentHash(db, path, readSourceTextUncached(db, path));
    depHashes.set(path, computed);
    return computed;
  };
  let filesSinceYield = 0;
  for (const file of files) {
    filesSinceYield += 1;
    if (filesSinceYield >= EXTRACTION_YIELD_INTERVAL_FILES) {
      filesSinceYield = 0;
      // Let queued second-pass finalizers free the native trees parsed by
      // earlier iterations before this sweep parses more.
      await yieldToEventLoop();
    }
    const source = recordSpan('runtime-boundaries.file.read', () => readSourceTextUncached(db, file));
    const contentHash = fileContentHash(db, file, source);
    depHashes.set(file, contentHash);
    // Direct extraction is a function of this file's bytes plus the bytes of
    // every file its resolvers consulted (imported constants, resolved call
    // targets, definition owners). The persisted payload names that consulted
    // set, and a hit requires every named dependency to still match.
    const cachedDirect = recordSpan('runtime-boundaries.file.direct-product', () => {
      const cached = DIRECT_EXTRACTION_PRODUCT.read(db, file, contentHash);
      if (!cached || cached.extractorVersion !== RUNTIME_BOUNDARY_EXTRACTOR_VERSION) return null;
      for (const dep of cached.deps) {
        if (currentDepHash(dep.path) !== dep.contentHash) return null;
      }
      return cached;
    });
    if (cachedDirect) {
      observations.push(...cachedDirect.observations);
      fileCoverage.push(cachedDirect.coverage);
      continue;
    }
    const applicableExtractors = recordSpan('runtime-boundaries.file.supports', () =>
      BOUNDARY_EXTRACTORS.filter((extractor) => extractor.supports(source)),
    );
    const hasBodySummaryCandidate = /\bJSON\.stringify\s*\(/u.test(source) && /\bbody\s*:/u.test(source);
    // Tokenized syntax/shape hashes are pure functions of the bytes, and
    // tokenizing every file dominated whole-repository extraction overhead;
    // one cheap content hash serves them from the persisted product instead.
    const sourceHashes = recordSpan('runtime-boundaries.file.hashes', () => {
      const cached = BOUNDARY_SOURCE_HASHES_PRODUCT.read(db, file, contentHash);
      if (cached) return cached;
      const computed = boundarySourceHashes(file, source);
      freshHashes.push({ relativePath: file, contentHash, value: computed });
      return computed;
    });
    const consultedFiles = new Set<string>();
    const fileObservations: BoundaryObservation[] = [];
    const coverage = withFileAccessRecording(
      (accessed) => consultedFiles.add(accessed),
      (): RuntimeBoundaryFileCoverage => {
        const context =
          applicableExtractors.length > 0 || hasBodySummaryCandidate
            ? boundaryFileContext(db, file, source, profileSpan)
            : null;
        const entry: RuntimeBoundaryFileCoverage = {
          file,
          hasAst: context !== null || boundaryAstEligible(file, source),
          syntaxHash: sourceHashes.syntaxHash,
          shapeHash: sourceHashes.shapeHash,
          bodySummaries: context && hasBodySummaryCandidate ? serializedBodySummariesForFile(context) : [],
          observationIds: [],
          extractors: [],
          extractionErrors: [],
        };
        if (context) {
          for (const extractor of applicableExtractors) {
            const extractorCoverage = { id: extractor.id, applicableFiles: 1, observations: 0, errors: 0 };
            try {
              const extracted = profileBoundaryWork(
                profileSpan,
                `runtime-boundaries.extractor.${extractor.id}`,
                file,
                () => extractor.extract(context),
              );
              extractorCoverage.observations = extracted.length;
              fileObservations.push(...extracted);
              entry.observationIds.push(...extracted.map((observation) => observation.id));
            } catch (error) {
              extractorCoverage.errors = 1;
              entry.extractionErrors.push(
                `${extractor.id} failed for ${file}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            entry.extractors.push(extractorCoverage);
          }
        }
        return entry;
      },
    );
    observations.push(...fileObservations);
    fileCoverage.push(coverage);
    // A file whose extraction errored is not cached: the error may be
    // environmental, and a retry should re-attempt extraction, not replay it.
    if (coverage.extractionErrors.length === 0) {
      consultedFiles.delete(file);
      freshDirect.push({
        relativePath: file,
        contentHash,
        value: {
          extractorVersion: RUNTIME_BOUNDARY_EXTRACTOR_VERSION,
          deps: [...consultedFiles].sort().map((path) => ({ path, contentHash: currentDepHash(path) })),
          observations: fileObservations,
          coverage,
        },
      });
    }
  }
  if (freshHashes.length > 0) BOUNDARY_SOURCE_HASHES_PRODUCT.writeBatch(db, freshHashes);
  if (freshDirect.length > 0) DIRECT_EXTRACTION_PRODUCT.writeBatch(db, freshDirect);
  return { observations, fileCoverage };
}

interface BoundarySourceHashes {
  syntaxHash: string;
  shapeHash: string;
}

const BOUNDARY_SOURCE_HASHES_PRODUCT = createFileEvidenceProduct<BoundarySourceHashes>({
  kind: 'runtime-boundary-source-hashes',
  invalidation: evidenceProductInvalidation('runtime-boundary-source-hashes'),
  serialize: (value) => JSON.stringify(value),
  deserialize: (payload) => {
    try {
      const parsed = JSON.parse(payload) as Partial<BoundarySourceHashes>;
      return typeof parsed.syntaxHash === 'string' && typeof parsed.shapeHash === 'string'
        ? { syntaxHash: parsed.syntaxHash, shapeHash: parsed.shapeHash }
        : null;
    } catch {
      return null;
    }
  },
});

/**
 * One file's complete direct-extraction result: its observations, its
 * coverage entry, and the consulted files whose bytes the result depends on.
 * The extractor version rides in the payload so a bumped extractor semantics
 * version can never serve rows written by an older one.
 */
interface DirectExtractionPayload {
  extractorVersion: string;
  deps: { path: string; contentHash: string }[];
  observations: BoundaryObservation[];
  coverage: RuntimeBoundaryFileCoverage;
}

const DIRECT_EXTRACTION_PRODUCT = createFileEvidenceProduct<DirectExtractionPayload>({
  kind: 'runtime-boundary-direct-extraction',
  invalidation: evidenceProductInvalidation('runtime-boundary-direct-extraction'),
  serialize: (value) => JSON.stringify(value),
  deserialize: (payload) => {
    try {
      const parsed = JSON.parse(payload) as Partial<DirectExtractionPayload>;
      if (
        typeof parsed.extractorVersion !== 'string' ||
        !Array.isArray(parsed.deps) ||
        !Array.isArray(parsed.observations) ||
        typeof parsed.coverage !== 'object' ||
        parsed.coverage === null ||
        !parsed.deps.every(
          (dep): dep is { path: string; contentHash: string } =>
            typeof dep === 'object' &&
            dep !== null &&
            typeof dep.path === 'string' &&
            typeof dep.contentHash === 'string',
        )
      ) {
        return null;
      }
      return parsed as DirectExtractionPayload;
    } catch {
      return null;
    }
  },
});

function boundarySourceHashes(file: string, source: string): { syntaxHash: string; shapeHash: string } {
  if (!/\.(?:[cm]?[jt]sx?)$/iu.test(file)) {
    const hash = createHash('sha256').update(source).digest('hex');
    return { syntaxHash: hash, shapeHash: hash };
  }
  const languageVariant = /\.[jt]sx$/iu.test(file)
    ? typescript.LanguageVariant.JSX
    : typescript.LanguageVariant.Standard;
  const scanner = typescript.createScanner(typescript.ScriptTarget.Latest, false, languageVariant, source);
  const syntaxHash = createHash('sha256');
  const shapeHash = createHash('sha256');
  const templateBraceDepths: number[] = [];
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) lineStarts.push(index + 1);
  }
  let tokenLine = 0;
  for (let token = scanner.scan(); token !== typescript.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token === typescript.SyntaxKind.CloseBraceToken &&
      templateBraceDepths.length > 0 &&
      templateBraceDepths.at(-1) === 0
    ) {
      token = scanner.reScanTemplateToken(false);
    }
    if (TYPESCRIPT_TRIVIA.has(token)) continue;
    const tokenText = scanner.getTokenText();
    while (lineStarts[tokenLine + 1] !== undefined && lineStarts[tokenLine + 1]! <= scanner.getTokenPos()) {
      tokenLine += 1;
    }
    syntaxHash.update(String(token));
    syntaxHash.update('\0');
    syntaxHash.update(tokenText);
    syntaxHash.update('\0');
    syntaxHash.update(String(tokenLine));
    syntaxHash.update('\0');
    shapeHash.update(String(token));
    shapeHash.update('\0');
    if (!TYPESCRIPT_LITERAL_VALUES.has(token) && !isBoundaryAddressString(token, tokenText)) {
      shapeHash.update(tokenText);
    }
    shapeHash.update('\0');
    shapeHash.update(String(tokenLine));
    shapeHash.update('\0');

    if (token === typescript.SyntaxKind.TemplateHead) {
      templateBraceDepths.push(0);
    } else if (token === typescript.SyntaxKind.TemplateTail) {
      templateBraceDepths.pop();
    } else if (token === typescript.SyntaxKind.OpenBraceToken && templateBraceDepths.length > 0) {
      templateBraceDepths[templateBraceDepths.length - 1]! += 1;
    } else if (
      token === typescript.SyntaxKind.CloseBraceToken &&
      templateBraceDepths.length > 0 &&
      templateBraceDepths.at(-1)! > 0
    ) {
      templateBraceDepths[templateBraceDepths.length - 1]! -= 1;
    }
  }
  return { syntaxHash: syntaxHash.digest('hex'), shapeHash: shapeHash.digest('hex') };
}

function isBoundaryAddressString(token: TypeScript.SyntaxKind, tokenText: string): boolean {
  if (token !== typescript.SyntaxKind.StringLiteral || tokenText.length < 2) return false;
  const value = tokenText.slice(1, -1);
  return value.startsWith('/') || value.includes('://');
}

function profileBoundaryWork<T>(
  profileSpan: RuntimeBoundaryProfileSpan | undefined,
  name: string,
  file: string,
  run: () => T,
): T {
  return profileSpan ? profileSpan(name, run, { file }) : run();
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
