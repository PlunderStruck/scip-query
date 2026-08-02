import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ObservationReceiptV2, ObservationSourceKind } from '../domain/observation-receipt.js';
import type { IndexedDefinition } from '../domain/types.js';
import { ProjectIndex } from '../queries/internal/project-index.js';
import type { ScipDatabase } from '../storage/db.js';
import * as queries from '../queries/index.js';
import { profileSpan } from '../instrumentation/profile.js';
import { semanticProviderLanguageForPath } from '../semantic/provider-cache.js';
import { rustSemanticEngineIdentity } from '../semantic/rust/engine-identity.js';
import {
  semanticEvidenceProduct,
  type SemanticReferenceMaterializationOptions,
  type SemanticReferenceMaterializationResult,
} from '../semantic/shared-primitives.js';
import { materializeSemanticCalleeCache } from '../semantic/symbol-evidence.js';
import { sourceFrameworkApplicability } from '../source/primitives/source-fileset.js';
import { projectEvidenceFingerprint, sha256Hex } from '../storage/evidence-cache.js';
import { createProjectEvidenceProduct, evidenceProductInvalidation } from '../storage/evidence-products.js';
import { formatBytes, withDb } from './cli-context.js';
import {
  chunked,
  groupAnalysisTasks,
  IsolatedProcessTimeoutError,
  runAnalysisTasks,
  runIsolatedJsonProcessWithEvidenceAsync,
  type IsolatedAnalysisResult,
} from './isolated-analysis-runner.js';
import { buildObservationReceipt } from './observation-receipt.js';
import { render } from './render.js';
import { healthReportCacheKey, readHealthReportCache, writeHealthReportCache } from './health-report-cache.js';
import { cliVersion } from '../platform/cli-version.js';

export { cliVersion } from '../platform/cli-version.js';
export const HEALTH_PHASE_COMMAND = '__health-phase';
export const DIFF_IMPACT_BATCH_COMMAND = '__diff-impact-batch';
const DIFF_IMPACT_BATCH_SIZE = 10;
const DEFAULT_DIFF_IMPACT_BATCH_CONCURRENCY = 4;
const MAX_DEFAULT_DIFF_IMPACT_BATCH_CONCURRENCY = 8;
const LARGE_COMMAND_SYMBOL_THRESHOLD = 25_000;
const LARGE_COMMAND_DOCUMENT_THRESHOLD = 2_500;
const DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT = 2_500;
const DEFAULT_HEALTH_PHASE_CONCURRENCY = 4;
const MAX_DEFAULT_HEALTH_PHASE_CONCURRENCY = 12;
const DEFAULT_HEALTH_PHASE_TIMEOUT_MS = 30_000;
const REACT_HEALTH_PHASES = new Set<HealthPhaseName>([
  'react-component-duplicates',
  'react-hook-candidates',
  'react-large-component-pressure',
]);
const VUE_HEALTH_PHASES = new Set<HealthPhaseName>([
  'vue-component-duplicates',
  'vue-composable-candidates',
  'vue-large-view-pressure',
]);
const VUE_HEALTH_TASK_PHASES = new Set<HealthPhaseName>([...VUE_HEALTH_PHASES, 'suppressions']);
const SIMILAR_EXTRACT_HEALTH_PHASES = new Set<HealthPhaseName>(['similar', 'extract-candidates']);
const HEALTH_SEMANTIC_PREWARM_MARKER_VERSION = 2;

export interface HealthSemanticPrewarmMarker {
  version: typeof HEALTH_SEMANTIC_PREWARM_MARKER_VERSION;
  definitions: number;
  referenceCacheWrites: number;
  referenceIncomplete: number;
  calleeRows: number;
  warmedAt: number;
}

const HEALTH_SEMANTIC_PREWARM_CACHE = createProjectEvidenceProduct<HealthSemanticPrewarmMarker>({
  kind: 'health-semantic-prewarm',
  invalidation: evidenceProductInvalidation('health-semantic-prewarm'),
  serialize: (value) => JSON.stringify(value),
  deserialize: parseHealthSemanticPrewarmMarker,
});

function parseHealthSemanticPrewarmMarker(payload: string): HealthSemanticPrewarmMarker | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const marker = parsed as Partial<HealthSemanticPrewarmMarker>;
    if (marker.version !== HEALTH_SEMANTIC_PREWARM_MARKER_VERSION) return null;
    if (typeof marker.definitions !== 'number' || !Number.isFinite(marker.definitions)) return null;
    if (typeof marker.referenceCacheWrites !== 'number' || !Number.isFinite(marker.referenceCacheWrites)) return null;
    if (typeof marker.referenceIncomplete !== 'number' || !Number.isFinite(marker.referenceIncomplete)) return null;
    if (typeof marker.calleeRows !== 'number' || !Number.isFinite(marker.calleeRows)) return null;
    if (typeof marker.warmedAt !== 'number' || !Number.isFinite(marker.warmedAt)) return null;
    return {
      version: HEALTH_SEMANTIC_PREWARM_MARKER_VERSION,
      definitions: marker.definitions,
      referenceCacheWrites: marker.referenceCacheWrites,
      referenceIncomplete: marker.referenceIncomplete,
      calleeRows: marker.calleeRows,
      warmedAt: marker.warmedAt,
    };
  } catch {
    return null;
  }
}

type HealthReport = ReturnType<typeof queries.health>;
type HealthPhaseName = (typeof queries.HEALTH_PHASES)[number];
type HealthPhaseResult = ReturnType<typeof queries.healthPhase>;
type HealthPhaseResultWithMeta = HealthPhaseResult & {
  healthPhaseMeta?: {
    status: 'deferred';
    reason: string;
    timeoutMs: number;
  };
};
type DiffImpactResult = ReturnType<typeof queries.diffImpact>;
type DiffImpactPartial = ReturnType<typeof queries.diffImpactPartial>;
type AvailableCpus = () => number;
type ConcurrencyResolver = (itemCount: number, env?: NodeJS.ProcessEnv, availableCpus?: AvailableCpus) => number;
type HealthPhaseTask = HealthPhaseName[];

export interface EvidenceBoundAnalysis<T> {
  result: T;
  observationReceipt: ObservationReceiptV2;
}

export interface IndexObservationAnchor {
  database: Pick<ScipDatabase, 'config' | 'generation'>;
  generationDigest: string;
}

export interface HealthCliOptions {
  scope?: string;
  full?: boolean;
  json?: boolean;
}

export type HealthSemanticPrewarmSkipReason =
  | 'default-mode'
  | 'disabled'
  | 'missing-project-fingerprint'
  | 'cache-hit'
  | 'no-semantic-definitions'
  | 'provider-unavailable'
  | 'error';

export interface HealthSemanticPrewarmResult {
  status: 'skipped' | 'warmed' | 'partial';
  reason: HealthSemanticPrewarmSkipReason | 'cache-miss' | 'incomplete-references';
  definitions: number;
  referenceCacheHits: number;
  referenceCacheWrites: number;
  referenceMisses: number;
  referenceIncomplete: number;
  calleeRows: number;
  error?: string;
}

// scip-query: ignore-stale — reviewed S1 owned contract; this interface is the injectable semantic-prewarm boundary.
export interface HealthSemanticPrewarmRuntime {
  env?: NodeJS.ProcessEnv;
  projectFingerprint(db: ScipDatabase): string | null;
  semanticEngineFingerprint(db: ScipDatabase): string;
  readMarker(db: ScipDatabase, cacheKey: string, projectFingerprint: string): HealthSemanticPrewarmMarker | null;
  writeMarker(
    db: ScipDatabase,
    cacheKey: string,
    projectFingerprint: string,
    marker: HealthSemanticPrewarmMarker,
  ): void;
  candidateDefinitions(db: ScipDatabase, opts: HealthCliOptions): IndexedDefinition[];
  materializeReferences(
    db: ScipDatabase,
    definitions: ReadonlyArray<IndexedDefinition>,
    opts?: SemanticReferenceMaterializationOptions,
  ): SemanticReferenceMaterializationResult;
  materializeCallees(db: ScipDatabase, definitions: ReadonlyArray<IndexedDefinition>): Map<number, unknown>;
}

export interface DiffImpactCliOptions {
  base?: string;
}

export function renderHeuristicNotice(label: string): void {
  console.log(`Heuristic ${label}: review before acting; these are candidates, not exact compiler facts.\n`);
}

// scip-query: ignore-stale — reviewed S1 owned contract; this names the user-facing analysis-budget disclosure.
export interface AnalysisBudgetDisclosure {
  scanLimit: number;
  semanticEnrichment: boolean;
  reason: string;
}

interface CommandAnalysisBudget {
  scanLimit?: number;
  semantic: boolean;
  analysisBudget?: AnalysisBudgetDisclosure;
}

export function isLargeCommandIndex(db: ScipDatabase): boolean {
  const statsResult = queries.stats(db);
  return (
    statsResult.symbols >= LARGE_COMMAND_SYMBOL_THRESHOLD || statsResult.documents >= LARGE_COMMAND_DOCUMENT_THRESHOLD
  );
}

export function commandAnalysisBudget(
  db: ScipDatabase,
  commandName: string,
  full: boolean | undefined,
  opts: { quiet?: boolean } = {},
): CommandAnalysisBudget {
  if (!isLargeCommandIndex(db)) return { semantic: true };

  if (full) {
    if (!opts.quiet) {
      console.error(
        `Large index detected; ${commandName} is running the unbounded semantic pass because --full was supplied.`,
      );
    }
    return { semantic: true };
  }

  if (!opts.quiet) {
    console.error(
      `Large index detected; ${commandName} will scan the highest-priority ${DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT} candidates with semantic enrichment disabled. ` +
        `Run "scip-query ${commandName} --full" for the unbounded semantic pass.`,
    );
  }
  return {
    scanLimit: DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT,
    semantic: false,
    analysisBudget: {
      scanLimit: DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT,
      semanticEnrichment: false,
      reason: 'large index default budget; pass --full for unbounded semantic analysis',
    },
  };
}

const DEFAULT_HEALTH_SEMANTIC_PREWARM_RUNTIME: HealthSemanticPrewarmRuntime = {
  env: process.env,
  projectFingerprint: projectEvidenceFingerprint,
  semanticEngineFingerprint: healthSemanticPrewarmEngineFingerprint,
  readMarker: (db, cacheKey, fingerprint) => HEALTH_SEMANTIC_PREWARM_CACHE.read(db, cacheKey, fingerprint),
  writeMarker: (db, cacheKey, fingerprint, marker) =>
    HEALTH_SEMANTIC_PREWARM_CACHE.write(db, cacheKey, fingerprint, marker),
  candidateDefinitions: (db, opts) =>
    new ProjectIndex(db)
      .scopedDefinitions(opts.scope)
      .filter((definition) => semanticProviderLanguageForPath(definition.relativePath) !== null),
  materializeReferences: (db, definitions, opts) =>
    semanticEvidenceProduct(db).materializeReferences(definitions, opts),
  materializeCallees: materializeSemanticCalleeCache,
};

export function prewarmHealthSemanticEvidence(
  db: ScipDatabase,
  opts: HealthCliOptions,
  runtime: HealthSemanticPrewarmRuntime = DEFAULT_HEALTH_SEMANTIC_PREWARM_RUNTIME,
): HealthSemanticPrewarmResult {
  if (opts.full !== true) return skippedHealthSemanticPrewarm('default-mode');
  if ((runtime.env ?? process.env)['SCIP_QUERY_HEALTH_SEMANTIC_PREWARM'] === '0') {
    return skippedHealthSemanticPrewarm('disabled');
  }

  let result = skippedHealthSemanticPrewarm('error');
  return profileSpan(
    'health.semantic-prewarm',
    () => {
      try {
        result = runHealthSemanticPrewarm(db, opts, runtime);
      } catch (error) {
        result = skippedHealthSemanticPrewarm('error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return result;
    },
    () => healthSemanticPrewarmProfileMetadata(result),
  );
}

// scip-query: ignore-extract — reviewed E1 workflow owner; capability checks, prewarm execution, and disclosure stay together.
function runHealthSemanticPrewarm(
  db: ScipDatabase,
  opts: HealthCliOptions,
  runtime: HealthSemanticPrewarmRuntime,
): HealthSemanticPrewarmResult {
  const fingerprint = runtime.projectFingerprint(db);
  if (!fingerprint) return skippedHealthSemanticPrewarm('missing-project-fingerprint');

  const cacheKey = healthSemanticPrewarmCacheKey(opts, runtime.semanticEngineFingerprint(db));
  const marker = runtime.readMarker(db, cacheKey, fingerprint);
  if (marker && marker.referenceIncomplete === 0) return skippedHealthSemanticPrewarm('cache-hit');

  let definitions: IndexedDefinition[] = [];
  definitions = profileSpan(
    'health.semantic-prewarm.candidate-definitions',
    () => {
      definitions = runtime.candidateDefinitions(db, opts);
      return definitions;
    },
    () => ({ definitions: definitions.length }),
  );
  if (definitions.length === 0) return skippedHealthSemanticPrewarm('no-semantic-definitions');

  let referenceRows = 0;
  const references = profileSpan(
    'health.semantic-prewarm.references',
    () => {
      const result = runtime.materializeReferences(db, definitions, { prefetchCallees: true });
      referenceRows = result.cacheHits + result.cacheWrites + result.inMemoryHits;
      return result;
    },
    () => ({ definitions: definitions.length, rows: referenceRows }),
  );
  const referenceRowsKnown = references.cacheHits + references.cacheWrites + references.inMemoryHits;
  if (referenceRowsKnown === 0 && references.misses + references.unkeyed > 0) {
    return skippedHealthSemanticPrewarm('provider-unavailable', {
      definitions: definitions.length,
      referenceMisses: references.misses,
    });
  }

  let calleeRows = 0;
  const calleeMap = profileSpan(
    'health.semantic-prewarm.callees',
    () => {
      const result = runtime.materializeCallees(db, definitions);
      calleeRows = result.size;
      return result;
    },
    () => ({ definitions: definitions.length, rows: calleeRows }),
  );
  if (references.incomplete > 0) {
    return {
      status: 'partial',
      reason: 'incomplete-references',
      definitions: definitions.length,
      referenceCacheHits: references.cacheHits,
      referenceCacheWrites: references.cacheWrites,
      referenceMisses: references.misses,
      referenceIncomplete: references.incomplete,
      calleeRows: calleeMap.size,
    };
  }

  profileSpan('health.semantic-prewarm.marker-write', () =>
    runtime.writeMarker(db, cacheKey, fingerprint, {
      version: HEALTH_SEMANTIC_PREWARM_MARKER_VERSION,
      definitions: definitions.length,
      referenceCacheWrites: references.cacheWrites,
      referenceIncomplete: references.incomplete,
      calleeRows: calleeMap.size,
      warmedAt: Date.now(),
    }),
  );

  return {
    status: 'warmed',
    reason: 'cache-miss',
    definitions: definitions.length,
    referenceCacheHits: references.cacheHits,
    referenceCacheWrites: references.cacheWrites,
    referenceMisses: references.misses,
    referenceIncomplete: references.incomplete,
    calleeRows: calleeMap.size,
  };
}

function healthSemanticPrewarmCacheKey(opts: HealthCliOptions, semanticEngineFingerprint: string): string {
  return JSON.stringify({
    version: HEALTH_SEMANTIC_PREWARM_MARKER_VERSION,
    cliVersion,
    semanticEngineFingerprint,
    scope: opts.scope ?? null,
  });
}

function healthSemanticPrewarmEngineFingerprint(db: ScipDatabase): string {
  return sha256Hex(
    JSON.stringify({
      kind: 'health-semantic-prewarm-engine',
      rust: rustSemanticEngineIdentity(db.config.projectRoot),
    }),
  );
}

function skippedHealthSemanticPrewarm(
  reason: HealthSemanticPrewarmSkipReason,
  overrides: Partial<HealthSemanticPrewarmResult> = {},
): HealthSemanticPrewarmResult {
  return {
    status: 'skipped',
    reason,
    definitions: 0,
    referenceCacheHits: 0,
    referenceCacheWrites: 0,
    referenceMisses: 0,
    referenceIncomplete: 0,
    calleeRows: 0,
    ...overrides,
  };
}

function healthSemanticPrewarmProfileMetadata(result: HealthSemanticPrewarmResult): Record<string, unknown> {
  return {
    status: result.status,
    reason: result.reason,
    definitions: result.definitions,
    referenceCacheHits: result.referenceCacheHits,
    referenceCacheWrites: result.referenceCacheWrites,
    referenceMisses: result.referenceMisses,
    referenceIncomplete: result.referenceIncomplete,
    calleeRows: result.calleeRows,
    error: result.error,
  };
}

function withIndexObservation<T>(run: (db: ScipDatabase) => T): { value: T; anchor: IndexObservationAnchor } {
  return withDb((db) => {
    const receipt = buildObservationReceipt({
      projectRoot: db.config.projectRoot,
      db,
      observedSourceKinds: ['index-generation'],
    });
    return {
      value: run(db),
      anchor: {
        database: { config: db.config, generation: db.generation },
        generationDigest: receipt.facts.index!.generation.digest,
      },
    };
  });
}

export function operationObservationReceipt(
  anchors: readonly IndexObservationAnchor[],
  isolatedReceipts: readonly (ObservationReceiptV2 | undefined)[],
  observedSources: readonly ObservationSourceKind[],
): ObservationReceiptV2 {
  const first = anchors[0];
  if (!first) {
    throw new Error('An evidence-bound analysis requires at least one index observation anchor.');
  }
  const expectedGeneration = first.generationDigest;
  const parentAligned = anchors.every((anchor) => anchor.generationDigest === expectedGeneration);
  const childrenAligned = isolatedReceipts.every(
    (receipt) => receipt?.facts.index?.generation.digest === expectedGeneration,
  );
  return buildObservationReceipt({
    projectRoot: first.database.config.projectRoot,
    ...(parentAligned && childrenAligned ? { db: first.database } : {}),
    observedSourceKinds: observedSources,
  });
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export async function runIsolatedHealthReport(opts: HealthCliOptions): Promise<HealthReport> {
  return (await runIsolatedHealthReportWithEvidence(opts)).result;
}

export async function runIsolatedHealthReportWithEvidence(
  opts: HealthCliOptions,
): Promise<EvidenceBoundAnalysis<HealthReport>> {
  const phaseTimeoutMs = healthPhaseTimeoutMs(opts);
  const cacheOptions = { ...opts, phaseTimeoutMs: phaseTimeoutMs ?? null };
  const cachedObservation = withIndexObservation((db) => {
    const key = healthReportCacheKey(db, cacheOptions, cliVersion);
    if (!key) return null;
    const report = readHealthReportCache(db, key);
    if (!report) return null;
    return report;
  });
  if (cachedObservation.value) {
    return {
      result: cachedObservation.value,
      observationReceipt: operationObservationReceipt(
        [cachedObservation.anchor],
        [],
        ['index-generation', 'live-workspace'],
      ),
    };
  }

  const overviewObservation = withIndexObservation((db) => ({
    applicability: healthPhaseApplicability(db, opts),
    overview: queries.healthPhase(db, 'overview', opts),
  }));
  const { applicability, overview } = overviewObservation.value;
  const anchors = [cachedObservation.anchor, overviewObservation.anchor];
  const resultByPhase = new Map<HealthPhaseName, HealthPhaseResult>();
  resultByPhase.set('overview', overview);
  const runnablePhases = queries.HEALTH_PHASES.filter((phase) => {
    if (phase === 'overview') return false;
    if (shouldRunHealthPhase(phase, applicability)) return true;
    resultByPhase.set(phase, skippedHealthPhaseResult(phase));
    return false;
  });

  const runnableTasks = healthPhaseTasks(runnablePhases);
  if (opts.full) {
    const prewarmObservation = withIndexObservation((db) => prewarmHealthSemanticEvidence(db, opts));
    anchors.push(prewarmObservation.anchor);
  }
  const runnableMessages = await runAnalysisTasks(runnableTasks, healthPhaseConcurrency(runnableTasks.length), (task) =>
    runHealthPhaseTaskProcess(task, opts, phaseTimeoutMs),
  );
  const runnableResults = runnableMessages.flatMap((message) => message.result);
  const phaseWarnings: string[] = [];
  runnableResults.forEach((result) => {
    if (result.healthPhaseMeta) {
      phaseWarnings.push(
        `Health phase "${result.phase}" deferred: ${result.healthPhaseMeta.reason}. Run health --full for exhaustive analysis.`,
      );
    }
    resultByPhase.set(result.phase, result);
  });

  if (phaseWarnings.length > 0) {
    const currentOverview = resultByPhase.get('overview') as Extract<HealthPhaseResult, { phase: 'overview' }>;
    resultByPhase.set('overview', {
      ...currentOverview,
      warnings: [...currentOverview.warnings, ...phaseWarnings],
    });
  }

  const report = queries.healthReportFromPhases(queries.HEALTH_PHASES.map((phase) => resultByPhase.get(phase)!));
  withDb((db) => {
    const key = healthReportCacheKey(db, cacheOptions, cliVersion);
    if (key) writeHealthReportCache(db, key, report);
  });
  return {
    result: report,
    observationReceipt: operationObservationReceipt(
      anchors,
      runnableMessages.map((message) => message.observationReceipt),
      ['index-generation', 'live-workspace'],
    ),
  };
}

function healthPhaseApplicability(db: ScipDatabase, opts: HealthCliOptions) {
  return sourceFrameworkApplicability(db, { scope: opts.scope });
}

export function shouldRunHealthPhase(
  phase: HealthPhaseName,
  applicability: ReturnType<typeof sourceFrameworkApplicability>,
): boolean {
  if (REACT_HEALTH_PHASES.has(phase)) return applicability.react;
  if (VUE_HEALTH_PHASES.has(phase)) return applicability.vue;
  return true;
}

export function healthPhaseTasks(phases: readonly HealthPhaseName[]): HealthPhaseTask[] {
  return groupAnalysisTasks(phases, [REACT_HEALTH_PHASES, VUE_HEALTH_TASK_PHASES, SIMILAR_EXTRACT_HEALTH_PHASES]);
}

export function skippedHealthPhaseResult(phase: HealthPhaseName): HealthPhaseResult {
  switch (phase) {
    case 'react-component-duplicates':
      return { phase, reactComponentDuplicates: { count: 0, loc: 0, files: [] } };
    case 'react-hook-candidates':
      return { phase, reactHookCandidates: { count: 0, loc: 0, files: [] } };
    case 'react-large-component-pressure':
      return { phase, reactLargeComponentPressure: { count: 0, loc: 0, files: [] } };
    case 'vue-component-duplicates':
      return { phase, vueComponentDuplicates: { count: 0, loc: 0, files: [] } };
    case 'vue-composable-candidates':
      return { phase, vueComposableCandidates: { count: 0, loc: 0, files: [] } };
    case 'vue-large-view-pressure':
      return { phase, vueLargeViewPressure: { count: 0, loc: 0, files: [] } };
    default:
      throw new Error(`Health phase "${phase}" cannot be synthesized.`);
  }
}

function runHealthPhaseTaskProcess(
  phases: HealthPhaseTask,
  opts: HealthCliOptions,
  timeoutMs: number | undefined,
): Promise<IsolatedAnalysisResult<HealthPhaseResultWithMeta[]>> {
  if (phases.length === 1) {
    return runHealthPhaseProcess(phases[0]!, opts, timeoutMs).then((message) => ({
      result: [message.result],
      ...(message.observationReceipt ? { observationReceipt: message.observationReceipt } : {}),
    }));
  }

  const phaseArg = phases.join(',');
  const cliPath = process.argv[1] ?? fileURLToPath(import.meta.url);
  const args: string[] = [phaseArg];
  if (opts.scope) args.push('--scope', opts.scope);
  if (opts.full) args.push('--full');

  return runIsolatedJsonProcessWithEvidenceAsync<HealthPhaseResult[]>({
    cliPath,
    command: HEALTH_PHASE_COMMAND,
    args,
    label: `Health phases "${phaseArg}"`,
    timeoutMs,
  }).catch((error) => {
    if (opts.full || !(error instanceof IsolatedProcessTimeoutError)) throw error;
    return {
      result: phases.map((phase) =>
        deferredHealthPhaseResult(phase, error.timeoutMs, `timed out after ${error.timeoutMs}ms`),
      ),
    };
  });
}

function runHealthPhaseProcess(
  phase: HealthPhaseName,
  opts: HealthCliOptions,
  timeoutMs: number | undefined,
): Promise<IsolatedAnalysisResult<HealthPhaseResultWithMeta>> {
  const cliPath = process.argv[1] ?? fileURLToPath(import.meta.url);
  const args: string[] = [phase];
  if (opts.scope) args.push('--scope', opts.scope);
  if (opts.full) args.push('--full');

  return runIsolatedJsonProcessWithEvidenceAsync<HealthPhaseResult>({
    cliPath,
    command: HEALTH_PHASE_COMMAND,
    args,
    label: `Health phase "${phase}"`,
    timeoutMs,
  }).catch((error) => {
    if (opts.full || !(error instanceof IsolatedProcessTimeoutError)) throw error;
    return {
      result: deferredHealthPhaseResult(phase, error.timeoutMs, `timed out after ${error.timeoutMs}ms`),
    };
  });
}

export function healthPhaseTimeoutMs(opts: HealthCliOptions, env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (opts.full) return undefined;
  const raw = env['SCIP_QUERY_HEALTH_PHASE_TIMEOUT_MS'];
  if (!raw) return DEFAULT_HEALTH_PHASE_TIMEOUT_MS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_HEALTH_PHASE_TIMEOUT_MS;
  return parsed === 0 ? undefined : parsed;
}

export function deferredHealthPhaseResult(
  phase: HealthPhaseName,
  timeoutMs: number,
  reason: string,
): HealthPhaseResultWithMeta {
  const meta = { healthPhaseMeta: { status: 'deferred' as const, reason, timeoutMs } };
  switch (phase) {
    case 'overview':
      throw new Error('Overview health phase cannot be deferred.');
    case 'dead':
      return { phase, dead: { count: 0, loc: 0, files: [] }, ...meta };
    case 'isolated':
      return { phase, isolated: { count: 0, loc: 0, files: [] }, ...meta };
    case 'cycles':
      return { phase, realCycleCount: 0, ...meta };
    case 'similar':
      return { phase, similarCount: 0, ...meta };
    case 'duplicate-bodies':
      return { phase, duplicateBodies: { count: 0, loc: 0, files: [] }, ...meta };
    case 'twin-drift':
      return { phase, twinDrift: { count: 0, loc: 0, files: [] }, ...meta };
    case 'react-component-duplicates':
      return { ...skippedHealthPhaseResult(phase), ...meta };
    case 'react-hook-candidates':
      return { ...skippedHealthPhaseResult(phase), ...meta };
    case 'react-large-component-pressure':
      return { ...skippedHealthPhaseResult(phase), ...meta };
    case 'vue-component-duplicates':
      return { ...skippedHealthPhaseResult(phase), ...meta };
    case 'vue-composable-candidates':
      return { ...skippedHealthPhaseResult(phase), ...meta };
    case 'vue-large-view-pressure':
      return { ...skippedHealthPhaseResult(phase), ...meta };
    case 'extract-candidates':
      return { phase, extractCount: 0, ...meta };
    case 'wrapper-candidates':
      return { phase, wrappers: { count: 0, loc: 0, files: [] }, ...meta };
    case 'passthrough-candidates':
      return { phase, passthroughs: { count: 0, loc: 0, files: [] }, ...meta };
    case 'stale-abstractions':
      return { phase, stale: { count: 0, loc: 0, files: [], unused: 0, singleUse: 0 }, ...meta };
    case 'drift':
      return {
        phase,
        drift: {
          count: 0,
          unusedImports: 0,
          architectureViolations: 0,
          layerViolations: 0,
          direct: 0,
          signal: 0,
        },
        ...meta,
      };
    case 'complexity-hotspots':
      return { phase, complexity: { top: [], extremeCount: 0 }, ...meta };
    case 'git-evidence':
      return { phase, gitEvidence: null, ...meta };
    case 'suppressions':
      return { phase, suppressions: { total: 0, byCategory: {} }, ...meta };
    case 'coverage-contracts':
      return { phase, coverageContracts: { count: 0, loc: 0, files: [] }, ...meta };
  }
}

// scip-query: ignore-similar — public scheduler entrypoints intentionally share
// the resolver factory; their env key and default cap are the product variation.
export const healthPhaseConcurrency = createAdaptiveConcurrencyResolver({
  envKey: 'SCIP_QUERY_HEALTH_CONCURRENCY',
  defaultMinimum: DEFAULT_HEALTH_PHASE_CONCURRENCY,
  defaultMaximum: MAX_DEFAULT_HEALTH_PHASE_CONCURRENCY,
});

export function renderHealthReport(report: HealthReport): void {
  console.log(`\n  Codebase Health Score: ${report.score}/100`);
  console.log(`    Risk:    ${report.riskScore}/100  (risk-oriented graph facts + change graph)`);
  console.log(`    Hygiene: ${report.hygieneScore}/100  (tidiness candidates)\n`);
  console.log(
    `  ${report.overview.documents} files | ${report.overview.symbols} symbols | ${formatBytes(report.overview.indexSizeBytes)}\n`,
  );
  if (report.warnings && report.warnings.length > 0) {
    console.log('  Warnings:');
    for (const warning of report.warnings) {
      console.log(`    ${warning}`);
    }
    console.log('');
  }

  console.log('  Findings:');
  const f = report.findings;
  if (f.deadSymbols > 0) console.log(`    Dead code:            ${f.deadSymbols} symbols (${f.deadLoc} LOC)`);
  if (f.isolatedSymbols > 0) console.log(`    Isolated symbols:     ${f.isolatedSymbols} (${f.isolatedLoc} LOC)`);
  if (f.cycles > 0) console.log(`    Circular deps:        ${f.cycles}`);
  if (f.similarPairs > 0) console.log(`    Similar pairs:        ${f.similarPairs}`);
  if (f.twinDriftGroups > 0) console.log(`    Drifted twins:        ${f.twinDriftGroups} group(s)`);
  if (f.reactComponentDuplicatePairs > 0)
    console.log(`    React components:     ${f.reactComponentDuplicatePairs} duplicate pair(s)`);
  if (f.reactHookCandidatePairs > 0) {
    console.log(
      `    React hook reuse:     ${formatScoreAwareCount(f.reactHookCandidatePairs, f.reactHookCandidateScoreCount)} candidate pair(s)`,
    );
  }
  if (f.reactLargeComponentPressureFiles > 0)
    console.log(`    React large comps:    ${f.reactLargeComponentPressureFiles} component(s)`);
  if (f.vueComponentDuplicatePairs > 0)
    console.log(`    Vue components:       ${f.vueComponentDuplicatePairs} duplicate pair(s)`);
  if (f.vueComposableCandidatePairs > 0) {
    console.log(
      `    Vue composables:      ${formatScoreAwareCount(f.vueComposableCandidatePairs, f.vueComposableCandidateScoreCount)} candidate pair(s)`,
    );
  }
  if (f.vueLargeViewPressureFiles > 0) console.log(`    Vue large views:      ${f.vueLargeViewPressureFiles} file(s)`);
  if (f.extractionCandidates > 0) console.log(`    Extract candidates:   ${f.extractionCandidates}`);
  if (f.wrappers > 0)
    console.log(`    Wrapper functions:    ${formatScoreAwareCount(f.wrappers, f.wrapperScoreCount)}`);
  if (f.passthroughs > 0) console.log(`    Passthroughs:         ${f.passthroughs}`);
  if (f.staleTypes > 0) console.log(`    Stale abstractions:   ${f.staleTypes}`);
  if (f.driftedFiles > 0) console.log(`    Pattern drift:        ${f.driftedFiles} files`);
  if (f.complexityHotspotCount > 0) console.log(`    Complexity hotspots:  ${f.complexityHotspotCount}`);

  if (report.actions.length > 0) {
    console.log('\n  Prioritized Actions (highest impact + lowest effort first):');
    for (let i = 0; i < report.actions.length; i++) {
      const a = report.actions[i]!;
      const loc = a.locRecoverable > 0 ? ` (~${a.locRecoverable} LOC involved)` : '';
      console.log(`    ${i + 1}. [${a.effort} effort / ${a.impact} impact] ${a.description}${loc}`);
    }
  }

  if (report.topComplexity.length > 0) {
    console.log('\n  Top Complexity Hotspots:');
    for (const c of report.topComplexity) {
      console.log(`    ${c.score.toFixed(1).padStart(6)}  ${c.symbol}`);
    }
  }

  renderHealthAxes(report);
  renderHealthPressure(report);

  if (report.scoreBreakdown.length > 0) {
    console.log('\n  Score Breakdown (100 minus the following):');
    for (const deduction of report.scoreBreakdown) {
      console.log(`    -${String(deduction.points).padStart(2)}  ${deduction.axis}: ${deduction.detail}`);
    }
  }

  if (report.actions.length === 0) {
    console.log(
      report.warnings && report.warnings.length > 0
        ? '\n  No findings from completed analyses. Review warnings before interpreting this result as clean.'
        : '\n  No issues found. Codebase is clean.',
    );
  }
}

function formatScoreAwareCount(rawCount: number, scoreCount: number): string {
  if (Math.abs(rawCount - scoreCount) < 0.01) return String(rawCount);
  return `${rawCount} (${formatCompactNumber(scoreCount)} score-weighted)`;
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function renderHealthPressure(report: HealthReport): void {
  if (report.pressure.length === 0) return;
  console.log('\n  Maintenance Pressure:');
  for (const pressure of report.pressure) {
    console.log(
      `    ${pressure.category}: ${pressure.count} / ${pressure.threshold} threshold ` +
        `(${pressure.ratio}x, -${pressure.extraPenalty} ${pressure.kind})`,
    );
  }
}

function renderHealthAxes(report: HealthReport): void {
  const axes = report.axes;
  console.log('\n  Axes:');
  console.log(`    Zero-reference candidates: ${axes.deletable.loc} LOC across ${axes.deletable.symbols} symbols`);
  if (axes.changeAmplification) {
    const amp = axes.changeAmplification;
    console.log(
      `    Change amplification: ${amp.medianFilesPerCommit} files/commit median, ${amp.p90FilesPerCommit} p90 (${amp.commitsAnalyzed} commits)`,
    );
  }
  if (axes.hiddenCoupling && axes.hiddenCoupling.pairCount > 0) {
    console.log(
      `    Hidden coupling:      ${axes.hiddenCoupling.pairCount} co-changing pair(s) without a dependency edge`,
    );
    for (const pair of axes.hiddenCoupling.top.slice(0, 3)) {
      console.log(
        `      ${pair.fileA} <-> ${pair.fileB}  (${pair.together}x together, ${Math.round(pair.confidence * 100)}%)`,
      );
    }
  }
  if (axes.churnWeightedComplexity && axes.churnWeightedComplexity.length > 0) {
    const top = axes.churnWeightedComplexity[0]!;
    if (top.weighted > 0) {
      console.log(
        `    Churn x complexity:   hottest is ${top.symbol} (${top.changes} changes, weighted ${top.weighted})`,
      );
    }
  }
  const quality = axes.evidenceQuality;
  console.log(
    `    Evidence quality:     ${quality.graphFindings} graph-fact finding(s), ${quality.heuristicFindings} heuristic finding(s), ${quality.userSuppressed} user-suppressed`,
  );
  if (report.validation && report.validation.flaggedFiles > 0) {
    const v = report.validation;
    const ratio = v.ratio === null ? 'n/a' : `${v.ratio}x`;
    console.log(
      `    Validation:           flagged files fix-density ${v.flaggedFixDensity} vs baseline ${v.baselineFixDensity} (${ratio})`,
    );
    console.log(`      fix-commit signal: subject-keyword heuristic over ${v.validationBasis.commitsScanned} commits`);
  }
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export async function runIsolatedDiffImpactReport(opts: DiffImpactCliOptions): Promise<DiffImpactResult> {
  return (await runIsolatedDiffImpactReportWithEvidence(opts)).result;
}

export async function runIsolatedDiffImpactReportWithEvidence(
  opts: DiffImpactCliOptions,
): Promise<EvidenceBoundAnalysis<DiffImpactResult>> {
  const planObservation = withIndexObservation((db) => {
    const plan = queries.diffImpactPlan(db, { base: opts.base });
    if (plan.note) {
      return { kind: 'complete' as const, result: queries.diffImpact(db, { base: opts.base }) };
    }
    if (plan.changedFiles.length === 0) {
      return { kind: 'complete' as const, result: queries.diffImpact(db, { base: opts.base }) };
    }
    return { kind: 'batched' as const, plan };
  });
  const plan = planObservation.value;

  if (plan.kind === 'complete') {
    return {
      result: plan.result,
      observationReceipt: operationObservationReceipt(
        [planObservation.anchor],
        [],
        ['index-generation', 'live-workspace'],
      ),
    };
  }

  const batches = chunked(plan.plan.changedFiles, DIFF_IMPACT_BATCH_SIZE);
  const partials = await runAnalysisTasks(batches, diffImpactBatchConcurrency(batches.length), (batch) =>
    runDiffImpactBatchProcess(batch, opts),
  );
  return {
    result: queries.mergeDiffImpactPartials(
      plan.plan.changedFiles,
      partials.map((partial) => partial.result),
    ),
    observationReceipt: operationObservationReceipt(
      [planObservation.anchor],
      partials.map((partial) => partial.observationReceipt),
      ['index-generation', 'live-workspace'],
    ),
  };
}

// scip-query: ignore-similar — parallel to healthPhaseConcurrency by design:
// same adaptive policy, different workload/env key/default cap.
export const diffImpactBatchConcurrency = createAdaptiveConcurrencyResolver({
  envKey: 'SCIP_QUERY_DIFF_IMPACT_CONCURRENCY',
  defaultMinimum: DEFAULT_DIFF_IMPACT_BATCH_CONCURRENCY,
  defaultMaximum: MAX_DEFAULT_DIFF_IMPACT_BATCH_CONCURRENCY,
});

function createAdaptiveConcurrencyResolver(opts: {
  envKey: string;
  defaultMinimum: number;
  defaultMaximum: number;
}): ConcurrencyResolver {
  return (itemCount, env = process.env, availableCpus = availableParallelism) =>
    adaptiveConcurrency(itemCount, env, availableCpus, opts);
}

function adaptiveConcurrency(
  itemCount: number,
  env: NodeJS.ProcessEnv,
  availableCpus: AvailableCpus,
  opts: { envKey: string; defaultMinimum: number; defaultMaximum: number },
): number {
  const raw = env[opts.envKey];
  const defaultConcurrency = defaultAdaptiveConcurrency(availableCpus, opts);
  const parsed = raw ? parseInt(raw, 10) : defaultConcurrency;
  if (!Number.isFinite(parsed) || parsed < 1) return Math.min(defaultConcurrency, itemCount);
  return Math.min(parsed, itemCount);
}

function defaultAdaptiveConcurrency(
  availableCpus: AvailableCpus,
  opts: { defaultMinimum: number; defaultMaximum: number },
): number {
  const cpuCount = availableCpus();
  const adaptive = Number.isFinite(cpuCount) ? Math.max(opts.defaultMinimum, cpuCount - 1) : 0;
  return Math.min(opts.defaultMaximum, Math.max(opts.defaultMinimum, adaptive));
}

function runDiffImpactBatchProcess(
  files: readonly string[],
  opts: DiffImpactCliOptions,
): Promise<IsolatedAnalysisResult<DiffImpactPartial>> {
  const cliPath = process.argv[1] ?? fileURLToPath(import.meta.url);
  const args: string[] = [];
  if (opts.base) args.push('--base', opts.base);

  return runIsolatedJsonProcessWithEvidenceAsync<DiffImpactPartial>({
    cliPath,
    command: DIFF_IMPACT_BATCH_COMMAND,
    args,
    env: {
      ...process.env,
      SCIP_QUERY_DIFF_IMPACT_FILES: JSON.stringify(files),
    },
    label: 'Diff-impact batch',
  });
}

export function renderDiffImpactReport(result: DiffImpactResult): void {
  console.log(`Changed files: ${result.summary.totalChangedFiles}`);
  console.log(`Changed symbols: ${result.summary.totalChangedSymbols}`);
  console.log(`Affected consumer files: ${result.summary.totalAffectedFiles}`);
  if (result.summary.note) {
    console.log(`Note: ${result.summary.note}`);
  }
  for (const tier of result.evidenceTiers.filter((status) => status.state === 'failed')) {
    console.log(
      `WARNING: ${tier.tier} evidence failed for ${tier.attemptedSymbols} candidate symbol(s): ${tier.reason}`,
    );
  }
  const unattributed = result.attributionNotes.filter((note) => note.method === 'unattributed');
  if (unattributed.length > 0) {
    const files = [...new Set(unattributed.map((note) => note.file))];
    for (const file of files) {
      const count = unattributed.filter((note) => note.file === file).length;
      console.log(`note: ${count} changed line-range(s) in ${file} belong to no indexed symbol`);
    }
  }
  console.log('');
  if (result.changedSymbols.length > 0) {
    console.log('Changed symbols:');
    render.list(result.changedSymbols, (s) => `  ${s.file}  ${s.shortName}  (fan-in: ${s.fanIn})`);
  }
  if (result.affectedConsumers.length > 0) {
    console.log('\nAffected consumer files:');
    render.list(result.affectedConsumers, (c) => `  ${c.file}  (${c.consumedSymbols} symbol(s))`);
  }
}
