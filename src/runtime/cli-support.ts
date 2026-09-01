import { availableParallelism, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import type { ObservationReceiptV2, ObservationSourceKind } from '../domain/observation-receipt.js';
import type { IndexedDefinition } from '../domain/types.js';
import { ProjectIndex } from '../queries/internal/project-index.js';
import type { ScipDatabase } from '../storage/db.js';
import * as queries from '../queries/index.js';
import { profileAsyncSpan, profileSpan } from '../instrumentation/profile.js';
import { collectNativeGarbage } from '../platform/native-gc.js';
import { getSemanticProvider, semanticProviderLanguageForPath } from '../semantic/provider-cache.js';
import { rustSemanticEngineIdentity } from '../semantic/rust/engine-identity.js';
import {
  semanticEvidenceProduct,
  type SemanticReferenceMaterializationOptions,
  type SemanticReferenceMaterializationResult,
} from '../semantic/shared-primitives.js';
import { materializeSemanticCalleeCache } from '../semantic/symbol-evidence.js';
import {
  warmTypeScriptReferenceFragments,
  type TypeScriptReferenceFragmentWarmProgress,
  type TypeScriptReferenceFragmentWarmResult,
} from '../semantic/typescript/reference-fragment-shadow.js';
import { sourceFrameworkApplicability } from '../source/primitives/source-fileset.js';
import { projectEvidenceFingerprint, sha256Hex } from '../storage/evidence-cache.js';
import { clearRegisteredCaches } from '../storage/cache-registry.js';
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
export const HEALTH_SEMANTIC_PREWARM_COMMAND = '__health-semantic-prewarm';
export const DIFF_IMPACT_BATCH_COMMAND = '__diff-impact-batch';
// A diff-impact batch materializes the project-wide TypeScript reference-fragment
// view once. Keep enough changed files together to amortize that scan, and run
// batches sequentially by default so they do not contend while reading the same
// cache. The environment override remains available for workloads whose evidence
// providers do not have this project-wide cost.
const DIFF_IMPACT_BATCH_SIZE = 128;
const DEFAULT_DIFF_IMPACT_BATCH_CONCURRENCY = 1;
const MAX_DEFAULT_DIFF_IMPACT_BATCH_CONCURRENCY = 1;
// A cold diff-impact batch with no watch service hosts the TypeScript compiler
// program while it computes reference fragments for the changed files; on a
// large repository that program alone exceeds Node's default old-space limit.
const MAX_DEFAULT_DIFF_IMPACT_BATCH_HEAP_MB = 6144;
const MIN_DEFAULT_DIFF_IMPACT_BATCH_HEAP_MB = 2048;
// The same cold batch persists reference fragments for the whole project one
// provider batch at a time; on a large repository that takes several minutes
// even though every batch is resumable, so the batch gets the full-health
// phase budget rather than the generic analysis timeout.
const DEFAULT_DIFF_IMPACT_BATCH_TIMEOUT_MS = 10 * 60_000;
const LARGE_COMMAND_SYMBOL_THRESHOLD = 25_000;
const LARGE_COMMAND_DOCUMENT_THRESHOLD = 2_500;
const DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT = 2_500;
const DEFAULT_HEALTH_PHASE_CONCURRENCY = 4;
const MAX_DEFAULT_HEALTH_PHASE_CONCURRENCY = 12;
const DEFAULT_FULL_HEALTH_PHASE_CONCURRENCY = 1;
// Full phases run as isolated children that each reassemble the project's
// reference map, so their count is gated by memory: one child per ~7 GiB of
// half the machine (the 6 GiB phase heap plus native headroom), at most four.
const MAX_DEFAULT_FULL_HEALTH_PHASE_CONCURRENCY = 4;
const FULL_HEALTH_PHASE_MEMORY_BYTES = 7 * 1024 * 1024 * 1024;
const DEFAULT_FULL_HEALTH_PHASE_HEAP_MB = 6144;
const DEFAULT_FULL_HEALTH_PHASE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_HEALTH_PHASE_TIMEOUT_MS = 30_000;
const MAX_DEFAULT_HEALTH_SEMANTIC_PREWARM_HEAP_MB = 8192;
const MIN_DEFAULT_HEALTH_SEMANTIC_PREWARM_HEAP_MB = 2048;
const DEFAULT_HEALTH_SEMANTIC_PREWARM_TIMEOUT_MS = 10 * 60_000;
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
type ConcurrencyResolver = (
  itemCount: number,
  env?: NodeJS.ProcessEnv,
  availableCpus?: AvailableCpus,
  totalMemoryBytes?: number,
) => number;
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
  /** Indexed TypeScript files whose reference fragments are persisted; absent when the fragment path was unavailable. */
  referenceFragmentFiles?: number;
  /** TypeScript reference fragments computed and persisted by this run. */
  referenceFragmentComputedFiles?: number;
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
  /**
   * Persist a reference fragment for every indexed TypeScript file without
   * assembling the project-wide reference map; null when the fragment path is
   * unavailable and definitions must be materialized one batch at a time.
   * `onBatch` runs after each persisted provider batch and may release the
   * semantic provider; the next batch resolves a fresh one.
   */
  warmReferenceFragments(
    db: ScipDatabase,
    onBatch?: (progress: TypeScriptReferenceFragmentWarmProgress) => void,
  ): Promise<TypeScriptReferenceFragmentWarmResult | null>;
  materializeReferences(
    db: ScipDatabase,
    definitions: ReadonlyArray<IndexedDefinition>,
    opts?: SemanticReferenceMaterializationOptions,
  ): SemanticReferenceMaterializationResult;
  materializeCallees(db: ScipDatabase, definitions: ReadonlyArray<IndexedDefinition>): Map<number, unknown>;
  releaseSemanticMemory?(db: ScipDatabase): void;
  /** Fraction of the V8 old-space limit currently used; drives adaptive provider releases. */
  heapUsedFraction?(): number;
  /** Force a collection so garbage is not mistaken for live pressure; true when a collector was available. */
  collectGarbage?(): boolean;
  /** Yield one event-loop turn between batches so second-pass finalizers can reclaim native memory. */
  yieldToEventLoop?(): Promise<void>;
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
    if (commandName === 'dead') {
      if (!opts.quiet) {
        console.error(
          'Large index detected; dead is scanning all candidates with semantic enrichment disabled to keep memory bounded.',
        );
      }
      return { semantic: false };
    }
    if (!opts.quiet) {
      console.error(
        `Large index detected; ${commandName} is running the unbounded semantic pass because --full was supplied.`,
      );
    }
    return { semantic: true };
  }

  if (!opts.quiet) {
    const expansionGuidance =
      commandName === 'inspect'
        ? 'Use --full only when every omitted semantic candidate can change the decision; it does not override source or behavior materialization ceilings.'
        : commandName === 'dead'
          ? `Run "scip-query dead --full" for an unbounded candidate scan; semantic enrichment remains disabled on large indexes to keep memory bounded.`
          : `Run "scip-query ${commandName} --full" for the unbounded semantic pass.`;
    console.error(
      `Large index detected; ${commandName} is using its bounded default analysis with semantic enrichment disabled. ` +
        `Candidate scans, when this command uses one, are capped at ${DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT}. ` +
        expansionGuidance,
    );
  }
  return {
    scanLimit: DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT,
    semantic: false,
    analysisBudget: {
      scanLimit: DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT,
      semanticEnrichment: false,
      reason:
        commandName === 'dead'
          ? 'large index default budget; pass --full for an unbounded memory-safe candidate scan'
          : 'large index default budget; pass --full for unbounded semantic analysis',
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
  warmReferenceFragments: (db, onBatch) =>
    warmTypeScriptReferenceFragments(db, (relativePath) => getSemanticProvider(db, relativePath), { onBatch }),
  materializeReferences: (db, definitions, opts) =>
    semanticEvidenceProduct(db).materializeReferences(definitions, opts),
  materializeCallees: materializeSemanticCalleeCache,
  releaseSemanticMemory: (db) => clearRegisteredCaches(db, { groups: ['semantic-provider'] }),
  heapUsedFraction: () => {
    const stats = getHeapStatistics();
    return stats.heap_size_limit > 0 ? stats.used_heap_size / stats.heap_size_limit : 0;
  },
  collectGarbage: collectNativeGarbage,
  yieldToEventLoop: () => new Promise<void>((resolve) => setImmediate(resolve)),
};

/**
 * Semantic prewarm computes with a live compiler session whose checker state
 * grows with every resolved file. Batching by file keeps each computation's
 * working set small, and every batch's rows are persisted before the next
 * batch starts, so a mid-pass release, crash, or timeout never loses
 * completed work — the next run resumes from the cache.
 */
const HEALTH_SEMANTIC_PREWARM_BATCH_FILES = 256;

/**
 * Relieve memory only when the isolated heap is actually under pressure, and
 * measure that pressure after a forced collection so batch garbage is not
 * mistaken for live state. A provider release discards the compiler session,
 * and rebuilding it for the next batch is expensive, so it is paid only
 * instead of an OOM: on a large repository the live compiler program alone
 * can hold more than half of the isolated heap.
 */
const HEALTH_SEMANTIC_PREWARM_RELEASE_HEAP_FRACTION = 0.75;

export function healthSemanticPrewarmFileBatches(
  definitions: readonly IndexedDefinition[],
  maxFilesPerBatch: number = HEALTH_SEMANTIC_PREWARM_BATCH_FILES,
): IndexedDefinition[][] {
  if (!Number.isSafeInteger(maxFilesPerBatch) || maxFilesPerBatch < 1) {
    throw new Error(`Prewarm batch size must be a positive safe integer; received ${maxFilesPerBatch}.`);
  }
  const byFile = new Map<string, IndexedDefinition[]>();
  for (const definition of definitions) {
    const bucket = byFile.get(definition.relativePath);
    if (bucket) bucket.push(definition);
    else byFile.set(definition.relativePath, [definition]);
  }
  const batches: IndexedDefinition[][] = [];
  let current: IndexedDefinition[] = [];
  let currentFiles = 0;
  for (const fileDefinitions of byFile.values()) {
    if (currentFiles >= maxFilesPerBatch) {
      batches.push(current);
      current = [];
      currentFiles = 0;
    }
    current.push(...fileDefinitions);
    currentFiles += 1;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function prewarmHealthSemanticEvidence(
  db: ScipDatabase,
  opts: HealthCliOptions,
  runtime: HealthSemanticPrewarmRuntime = DEFAULT_HEALTH_SEMANTIC_PREWARM_RUNTIME,
): Promise<HealthSemanticPrewarmResult> {
  if (opts.full !== true) return skippedHealthSemanticPrewarm('default-mode');
  if ((runtime.env ?? process.env)['SCIP_QUERY_HEALTH_SEMANTIC_PREWARM'] === '0') {
    return skippedHealthSemanticPrewarm('disabled');
  }

  let result = skippedHealthSemanticPrewarm('error');
  return profileAsyncSpan(
    'health.semantic-prewarm',
    async () => {
      try {
        result = await runHealthSemanticPrewarm(db, opts, runtime);
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

interface HeapPressureRelief {
  /** Relieve pressure between batches; `release` discards the provider session as the last resort. */
  relieve(opts: { release: boolean }): void;
  readonly collections: number;
  readonly releases: number;
}

function createHeapPressureRelief(db: ScipDatabase, runtime: HealthSemanticPrewarmRuntime): HeapPressureRelief {
  let collections = 0;
  let releases = 0;
  const underPressure = (): boolean =>
    (runtime.heapUsedFraction?.() ?? 0) >= HEALTH_SEMANTIC_PREWARM_RELEASE_HEAP_FRACTION;
  return {
    relieve({ release }) {
      if (!underPressure()) return;
      if (runtime.collectGarbage?.()) {
        collections += 1;
        if (!underPressure()) return;
      }
      if (!release) return;
      runtime.releaseSemanticMemory?.(db);
      releases += 1;
    },
    get collections() {
      return collections;
    },
    get releases() {
      return releases;
    },
  };
}

interface ReferenceMaterializationTotals {
  definitions: number;
  cacheHits: number;
  cacheWrites: number;
  inMemoryHits: number;
  misses: number;
  unkeyed: number;
  incomplete: number;
}

function addReferenceMaterialization(
  totals: ReferenceMaterializationTotals,
  result: SemanticReferenceMaterializationResult,
): void {
  totals.definitions += result.definitions;
  totals.cacheHits += result.cacheHits;
  totals.cacheWrites += result.cacheWrites;
  totals.inMemoryHits += result.inMemoryHits;
  totals.misses += result.misses;
  totals.unkeyed += result.unkeyed;
  totals.incomplete += result.incomplete;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; capability checks, prewarm execution, and disclosure stay together.
async function runHealthSemanticPrewarm(
  db: ScipDatabase,
  opts: HealthCliOptions,
  runtime: HealthSemanticPrewarmRuntime,
): Promise<HealthSemanticPrewarmResult> {
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

  const pressure = createHeapPressureRelief(db, runtime);
  const yieldToEventLoop = async (): Promise<void> => {
    await runtime.yieldToEventLoop?.();
  };

  // TypeScript references are served per file from persisted fragments, so the
  // fragment rows are the warm state. Persisting them file by file bounds the
  // working set by one provider batch; assembling the project-wide reference
  // map only to discard it is what exhausted the isolated heap before.
  const typeScriptDefinitions = definitions.filter(
    (definition) => semanticProviderLanguageForPath(definition.relativePath) === 'typescript',
  );
  let fragments: TypeScriptReferenceFragmentWarmResult | null = null;
  if (typeScriptDefinitions.length > 0) {
    let warmed: TypeScriptReferenceFragmentWarmResult | null = null;
    fragments = await profileAsyncSpan(
      'health.semantic-prewarm.reference-fragments',
      async () => {
        warmed = await runtime.warmReferenceFragments(db, () => pressure.relieve({ release: true }));
        return warmed;
      },
      () => ({
        definitions: typeScriptDefinitions.length,
        rows: warmed?.computedFiles ?? 0,
        files: warmed?.files ?? 0,
        cacheHits: warmed?.cacheHits ?? 0,
        available: warmed !== null,
      }),
    );
  }

  // Everything the fragment path does not cover is materialized per
  // definition in file batches, each persisted before the next starts.
  const referenceDefinitions = fragments
    ? definitions.filter((definition) => semanticProviderLanguageForPath(definition.relativePath) !== 'typescript')
    : definitions;
  const references: ReferenceMaterializationTotals = {
    definitions: 0,
    cacheHits: 0,
    cacheWrites: 0,
    inMemoryHits: 0,
    misses: 0,
    unkeyed: 0,
    incomplete: 0,
  };
  let referenceRows = 0;
  await profileAsyncSpan(
    'health.semantic-prewarm.references',
    async () => {
      for (const batch of healthSemanticPrewarmFileBatches(referenceDefinitions)) {
        addReferenceMaterialization(references, runtime.materializeReferences(db, batch, { prefetchCallees: false }));
        pressure.relieve({ release: true });
        await yieldToEventLoop();
      }
      referenceRows = references.cacheHits + references.cacheWrites + references.inMemoryHits;
    },
    () => ({ definitions: referenceDefinitions.length, rows: referenceRows, releases: pressure.releases }),
  );
  const fragmentRows = fragments ? typeScriptDefinitions.length : 0;
  if (referenceRows + fragmentRows === 0 && references.misses + references.unkeyed > 0) {
    return skippedHealthSemanticPrewarm('provider-unavailable', {
      definitions: definitions.length,
      referenceMisses: references.misses,
    });
  }

  profileSpan('health.semantic-prewarm.release-reference-memory', () => runtime.releaseSemanticMemory?.(db));

  let calleeRows = 0;
  const calleeReleasesBefore = pressure.releases;
  await profileAsyncSpan(
    'health.semantic-prewarm.callees',
    async () => {
      for (const batch of healthSemanticPrewarmFileBatches(definitions)) {
        calleeRows += runtime.materializeCallees(db, batch).size;
        pressure.relieve({ release: true });
        await yieldToEventLoop();
      }
    },
    () => ({
      definitions: definitions.length,
      rows: calleeRows,
      releases: pressure.releases - calleeReleasesBefore,
      collections: pressure.collections,
    }),
  );
  const fragmentDisclosure = fragments
    ? { referenceFragmentFiles: fragments.files, referenceFragmentComputedFiles: fragments.computedFiles }
    : {};
  if (references.incomplete > 0) {
    return {
      status: 'partial',
      reason: 'incomplete-references',
      definitions: definitions.length,
      referenceCacheHits: references.cacheHits,
      referenceCacheWrites: references.cacheWrites,
      referenceMisses: references.misses,
      referenceIncomplete: references.incomplete,
      ...fragmentDisclosure,
      calleeRows,
    };
  }

  profileSpan('health.semantic-prewarm.marker-write', () =>
    runtime.writeMarker(db, cacheKey, fingerprint, {
      version: HEALTH_SEMANTIC_PREWARM_MARKER_VERSION,
      definitions: definitions.length,
      referenceCacheWrites: references.cacheWrites,
      referenceIncomplete: references.incomplete,
      calleeRows,
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
    ...fragmentDisclosure,
    calleeRows,
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

  const runnableTasks = orderHealthPhaseTasksByCost(healthPhaseTasks(runnablePhases));
  const phaseWarnings: string[] = [];
  let prewarmMessage: IsolatedAnalysisResult<HealthSemanticPrewarmResult> | undefined;
  if (opts.full) {
    try {
      prewarmMessage = await runHealthSemanticPrewarmProcess(opts);
    } catch (error) {
      phaseWarnings.push(`Health semantic prewarm omitted: ${healthIsolatedFailureReason(error)}.`);
    }
  }
  const phaseConcurrency = opts.full
    ? fullHealthPhaseConcurrency(runnableTasks.length)
    : healthPhaseConcurrency(runnableTasks.length);
  const runnableMessages = await runAnalysisTasks(runnableTasks, phaseConcurrency, (task) =>
    runHealthPhaseTaskProcess(task, opts, phaseTimeoutMs),
  );
  const runnableResults = runnableMessages.flatMap((message) => message.result);
  runnableResults.forEach((result) => {
    if (result.healthPhaseMeta) {
      phaseWarnings.push(
        opts.full
          ? `Health phase "${result.phase}" omitted after a bounded worker failure: ${result.healthPhaseMeta.reason}.`
          : `Health phase "${result.phase}" deferred: ${result.healthPhaseMeta.reason}. Run health --full for exhaustive analysis.`,
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
      [prewarmMessage?.observationReceipt, ...runnableMessages.map((message) => message.observationReceipt)],
      ['index-generation', 'live-workspace'],
    ),
  };
}

function runHealthSemanticPrewarmProcess(
  opts: HealthCliOptions,
): Promise<IsolatedAnalysisResult<HealthSemanticPrewarmResult>> {
  const cliPath = process.argv[1] ?? fileURLToPath(import.meta.url);
  const args: string[] = ['--full'];
  if (opts.scope) args.push('--scope', opts.scope);
  return runIsolatedJsonProcessWithEvidenceAsync<HealthSemanticPrewarmResult>({
    cliPath,
    command: HEALTH_SEMANTIC_PREWARM_COMMAND,
    args,
    env: {
      ...process.env,
      NODE_OPTIONS: `--max-old-space-size=${healthSemanticPrewarmHeapMb()}`,
    },
    label: 'Health semantic prewarm',
    timeoutMs: healthSemanticPrewarmTimeoutMs(),
  });
}

export function healthSemanticPrewarmHeapMb(
  env: NodeJS.ProcessEnv = process.env,
  totalMemoryBytes: number = totalmem(),
): number {
  const parsed = Number.parseInt(env['SCIP_QUERY_HEALTH_SEMANTIC_PREWARM_HEAP_MB'] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultHealthSemanticPrewarmHeapMb(totalMemoryBytes);
}

/**
 * The isolated prewarm heap is a backstop, not a budget: half of physical
 * memory, bounded to [2 GiB, 8 GiB], so a machine that cannot host the
 * previous fixed 8 GiB heap fails inside the child instead of swapping the
 * whole host, while large machines keep the ceiling the batches were sized for.
 */
export function defaultHealthSemanticPrewarmHeapMb(totalMemoryBytes: number): number {
  return boundedIsolatedHeapMb(totalMemoryBytes, {
    min: MIN_DEFAULT_HEALTH_SEMANTIC_PREWARM_HEAP_MB,
    max: MAX_DEFAULT_HEALTH_SEMANTIC_PREWARM_HEAP_MB,
  });
}

/** Half of physical memory, bounded; the maximum when the machine size is unknown. */
function boundedIsolatedHeapMb(totalMemoryBytes: number, bounds: { min: number; max: number }): number {
  const halfOfMachineMb = Math.floor(totalMemoryBytes / (2 * 1024 * 1024));
  if (!Number.isFinite(halfOfMachineMb) || halfOfMachineMb <= 0) return bounds.max;
  return Math.max(bounds.min, Math.min(bounds.max, halfOfMachineMb));
}

export function healthSemanticPrewarmTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env['SCIP_QUERY_HEALTH_SEMANTIC_PREWARM_TIMEOUT_MS'] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_HEALTH_SEMANTIC_PREWARM_TIMEOUT_MS;
}

export function fullHealthPhaseHeapMb(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env['SCIP_QUERY_HEALTH_FULL_PHASE_HEAP_MB'] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_FULL_HEALTH_PHASE_HEAP_MB;
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

/**
 * Relative wall-time of the isolated phases measured on a ~7,800-file
 * TypeScript repository with warm caches. Unlisted phases count as light. The
 * pool runs tasks in order, so starting the heavy ones first keeps the last
 * worker from finishing alone (longest-processing-time-first scheduling).
 */
const HEALTH_PHASE_COST_WEIGHT: Partial<Record<HealthPhaseName, number>> = {
  'wrapper-candidates': 49,
  'complexity-hotspots': 35,
  'passthrough-candidates': 31,
  'stale-abstractions': 30,
  'extract-candidates': 29,
  similar: 29,
  dead: 20,
  isolated: 12,
  'react-component-duplicates': 10,
  'react-hook-candidates': 10,
  cycles: 8,
};

export function orderHealthPhaseTasksByCost(tasks: readonly HealthPhaseTask[]): HealthPhaseTask[] {
  const weight = (task: HealthPhaseTask): number =>
    task.reduce((sum, phase) => sum + (HEALTH_PHASE_COST_WEIGHT[phase] ?? 1), 0);
  return tasks
    .map((task, index) => ({ task, index, weight: weight(task) }))
    .sort((left, right) => right.weight - left.weight || left.index - right.index)
    .map((entry) => entry.task);
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
    ...(opts.full ? { env: fullHealthPhaseProcessEnv() } : {}),
    label: `Health phases "${phaseArg}"`,
    timeoutMs,
  }).catch((error) => {
    if (!opts.full && !(error instanceof IsolatedProcessTimeoutError)) throw error;
    const failureTimeoutMs = error instanceof IsolatedProcessTimeoutError ? error.timeoutMs : (timeoutMs ?? 0);
    return {
      result: phases.map((phase) =>
        deferredHealthPhaseResult(
          phase,
          failureTimeoutMs,
          error instanceof IsolatedProcessTimeoutError
            ? `timed out after ${error.timeoutMs}ms`
            : healthIsolatedFailureReason(error),
        ),
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
    ...(opts.full ? { env: fullHealthPhaseProcessEnv() } : {}),
    label: `Health phase "${phase}"`,
    timeoutMs,
  }).catch((error) => {
    if (!opts.full && !(error instanceof IsolatedProcessTimeoutError)) throw error;
    const failureTimeoutMs = error instanceof IsolatedProcessTimeoutError ? error.timeoutMs : (timeoutMs ?? 0);
    return {
      result: deferredHealthPhaseResult(
        phase,
        failureTimeoutMs,
        error instanceof IsolatedProcessTimeoutError
          ? `timed out after ${error.timeoutMs}ms`
          : healthIsolatedFailureReason(error),
      ),
    };
  });
}

export function healthIsolatedFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/heap out of memory|reaching memory limit/i.test(message)) return 'exceeded its isolated memory limit';
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() || 'isolated worker failed';
  return firstLine.length <= 240 ? firstLine : `${firstLine.slice(0, 237)}...`;
}

function fullHealthPhaseProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    NODE_OPTIONS: `--max-old-space-size=${fullHealthPhaseHeapMb(env)}`,
  };
}

export function healthPhaseTimeoutMs(opts: HealthCliOptions, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const defaultTimeoutMs = opts.full ? DEFAULT_FULL_HEALTH_PHASE_TIMEOUT_MS : DEFAULT_HEALTH_PHASE_TIMEOUT_MS;
  const raw = env['SCIP_QUERY_HEALTH_PHASE_TIMEOUT_MS'];
  if (!raw) return defaultTimeoutMs;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultTimeoutMs;
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

export const fullHealthPhaseConcurrency = createAdaptiveConcurrencyResolver({
  envKey: 'SCIP_QUERY_HEALTH_FULL_CONCURRENCY',
  defaultMinimum: DEFAULT_FULL_HEALTH_PHASE_CONCURRENCY,
  defaultMaximum: MAX_DEFAULT_FULL_HEALTH_PHASE_CONCURRENCY,
  memoryPerTaskBytes: FULL_HEALTH_PHASE_MEMORY_BYTES,
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

  if (report.detectorEvidence.length > 0) {
    console.log('\n  Detector Evidence Calibration:');
    for (const contract of report.detectorEvidence) {
      const unavailable =
        contract.unavailableRequirements.length > 0
          ? `; unavailable: ${contract.unavailableRequirements.join(', ')}`
          : '';
      console.log(`    ${contract.detector}: ${contract.status}/${contract.providerCoverage}${unavailable}`);
    }
    console.log('    Full claims, non-claims, providers, and recovery commands are available in health --json.');
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

  const batches = diffImpactBatches(plan.plan.changedFiles);
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

export function diffImpactBatches(files: readonly string[]): string[][] {
  return chunked(files, DIFF_IMPACT_BATCH_SIZE);
}

interface AdaptiveConcurrencyOptions {
  envKey: string;
  defaultMinimum: number;
  defaultMaximum: number;
  /** When set, half of physical memory divided by this bounds the default as well. */
  memoryPerTaskBytes?: number;
}

function createAdaptiveConcurrencyResolver(opts: AdaptiveConcurrencyOptions): ConcurrencyResolver {
  return (itemCount, env = process.env, availableCpus = availableParallelism, totalMemoryBytes = totalmem()) =>
    adaptiveConcurrency(itemCount, env, availableCpus, totalMemoryBytes, opts);
}

function adaptiveConcurrency(
  itemCount: number,
  env: NodeJS.ProcessEnv,
  availableCpus: AvailableCpus,
  totalMemoryBytes: number,
  opts: AdaptiveConcurrencyOptions,
): number {
  const raw = env[opts.envKey];
  const defaultConcurrency = defaultAdaptiveConcurrency(availableCpus, totalMemoryBytes, opts);
  const parsed = raw ? parseInt(raw, 10) : defaultConcurrency;
  if (!Number.isFinite(parsed) || parsed < 1) return Math.min(defaultConcurrency, itemCount);
  return Math.min(parsed, itemCount);
}

function defaultAdaptiveConcurrency(
  availableCpus: AvailableCpus,
  totalMemoryBytes: number,
  opts: AdaptiveConcurrencyOptions,
): number {
  const cpuCount = availableCpus();
  const adaptive = Number.isFinite(cpuCount) ? Math.max(opts.defaultMinimum, cpuCount - 1) : 0;
  const memoryBound =
    opts.memoryPerTaskBytes !== undefined && Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0
      ? Math.floor(totalMemoryBytes / 2 / opts.memoryPerTaskBytes)
      : Number.POSITIVE_INFINITY;
  return Math.min(opts.defaultMaximum, memoryBound, Math.max(opts.defaultMinimum, adaptive));
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
      NODE_OPTIONS: `--max-old-space-size=${diffImpactBatchHeapMb()}`,
    },
    label: 'Diff-impact batch',
    timeoutMs: diffImpactBatchTimeoutMs(),
  });
}

export function diffImpactBatchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env['SCIP_QUERY_DIFF_IMPACT_BATCH_TIMEOUT_MS'] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DIFF_IMPACT_BATCH_TIMEOUT_MS;
}

export function diffImpactBatchHeapMb(
  env: NodeJS.ProcessEnv = process.env,
  totalMemoryBytes: number = totalmem(),
): number {
  const parsed = Number.parseInt(env['SCIP_QUERY_DIFF_IMPACT_BATCH_HEAP_MB'] ?? '', 10);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  return boundedIsolatedHeapMb(totalMemoryBytes, {
    min: MIN_DEFAULT_DIFF_IMPACT_BATCH_HEAP_MB,
    max: MAX_DEFAULT_DIFF_IMPACT_BATCH_HEAP_MB,
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
