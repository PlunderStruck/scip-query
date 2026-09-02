import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commandAnalysisBudget,
  deferredHealthPhaseResult,
  diffImpactBatches,
  diffImpactBatchConcurrency,
  diffImpactBatchHeapMb,
  diffImpactBatchTimeoutMs,
  fullHealthPhaseConcurrency,
  fullHealthPhaseHeapMb,
  healthIsolatedFailureReason,
  healthPhaseConcurrency,
  healthPhaseTasks,
  healthPhaseTimeoutMs,
  orderHealthPhaseTasksByCost,
  defaultHealthSemanticPrewarmHeapMb,
  healthSemanticPrewarmFileBatches,
  healthSemanticPrewarmHeapMb,
  healthSemanticPrewarmTimeoutMs,
  operationObservationReceipt,
  prewarmHealthSemanticEvidence,
  shouldRunHealthPhase,
  skippedHealthPhaseResult,
  type HealthSemanticPrewarmRuntime,
} from '../../src/runtime/cli-support.js';
import { buildObservationReceipt } from '../../src/runtime/observation-receipt.js';
import type { IndexedDefinition } from '../../src/domain/types.js';
import type { ScipDatabase } from '../../src/storage/db.js';

function fakeLargeDb(): ScipDatabase {
  return {
    config: { dbPath: '/tmp/missing-index.db' },
    generation: {
      identity: 'test-generation',
      databasePath: '/tmp/missing-index.db',
      source: 'legacy',
    },
    get: (sql: string) => {
      if (sql.includes('documents')) return { c: 10_000 };
      if (sql.includes('global_symbols')) return { c: 100_000 };
      return { c: 0 };
    },
  } as unknown as ScipDatabase;
}

function fakeDefinition(id: number, relativePath: string): IndexedDefinition {
  return {
    documentId: id,
    symbolId: id,
    symbol: `test symbol ${id}`,
    relativePath,
    startLine: 1,
    endLine: 3,
    leaf: `fn${id}`,
    parentTypeName: null,
    isFunctionLike: true,
    isTypeLike: false,
    kind: 12,
    documentation: null,
    enclosingSymbol: null,
  } as IndexedDefinition;
}

describe('operationObservationReceipt', () => {
  const database = {
    config: { projectRoot: process.cwd() },
    generation: {
      identity: 'generation-a',
      databasePath: '/tmp/generation-a/index.db',
      source: 'immutable' as const,
    },
  };
  const workerReceipt = buildObservationReceipt({
    projectRoot: process.cwd(),
    db: database,
    observedSourceKinds: ['index-generation'],
  });
  const anchor = {
    database,
    generationDigest: workerReceipt.facts.index!.generation.digest,
  };

  it('retains index identity when every parent and worker used the same generation', () => {
    expect(operationObservationReceipt([anchor], [workerReceipt], ['index-generation'])).toMatchObject({
      observedSources: [{ kind: 'index-generation' }],
      facts: { index: { generation: { digest: anchor.generationDigest } } },
    });
  });

  it('drops index authority when a worker generation is missing or different', () => {
    const mismatched = {
      ...workerReceipt,
      facts: {
        ...workerReceipt.facts,
        index: {
          ...workerReceipt.facts.index!,
          generation: { ...workerReceipt.facts.index!.generation, digest: 'different-generation' },
        },
      },
    };

    for (const worker of [undefined, mismatched]) {
      const receipt = operationObservationReceipt([anchor], [worker], ['index-generation']);
      expect(receipt.facts).not.toHaveProperty('index');
      expect(receipt.observedSources).toEqual([{ kind: 'process' }]);
    }
  });
});

function fakePrewarmRuntime(overrides: Partial<HealthSemanticPrewarmRuntime> = {}): HealthSemanticPrewarmRuntime {
  return {
    env: {},
    projectFingerprint: vi.fn(() => 'project-a'),
    semanticEngineFingerprint: vi.fn(() => 'semantic-engine-a'),
    readMarker: vi.fn(() => null),
    writeMarker: vi.fn(),
    candidateDefinitions: vi.fn(() => [fakeDefinition(1, 'src/main.ts'), fakeDefinition(2, 'src/lib.rs')]),
    materializeReferences: vi.fn((_, definitions) => ({
      definitions: definitions.length,
      inMemoryHits: 0,
      incompleteInMemoryHits: 0,
      cacheHits: 0,
      misses: definitions.length,
      unkeyed: 0,
      skippedUnsupportedLanguage: 0,
      parseFailures: 0,
      computed: definitions.length,
      incomplete: 0,
      cacheWrites: definitions.length,
    })),
    warmSourceDependencies: vi.fn(async () => ({ files: 2 })),
    warmSourceFacts: vi.fn(async () => ({ files: 2, withFacts: 1 })),
    warmReferenceFragments: vi.fn(async () => ({ files: 1, cacheHits: 0, cacheMisses: 1, computedFiles: 1 })),
    materializeCallees: vi.fn(() => new Map([[1, []]])),
    releaseSemanticMemory: vi.fn(),
    yieldToEventLoop: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('commandAnalysisBudget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('suppresses large-index warnings for JSON commands without changing the budget', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(commandAnalysisBudget(fakeLargeDb(), 'cleanup-plan', false, { quiet: true })).toEqual({
      scanLimit: 2500,
      semantic: false,
      analysisBudget: {
        scanLimit: 2500,
        semanticEnrichment: false,
        reason: 'large index default budget; pass --full for unbounded semantic analysis',
      },
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps large-index warnings for human output', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(commandAnalysisBudget(fakeLargeDb(), 'cleanup-plan', false)).toEqual({
      scanLimit: 2500,
      semantic: false,
      analysisBudget: {
        scanLimit: 2500,
        semanticEnrichment: false,
        reason: 'large index default budget; pass --full for unbounded semantic analysis',
      },
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('bounded default analysis'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Candidate scans, when this command uses one'));
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('will scan the highest-priority'));
  });

  it('keeps dead full scans memory-bounded by withholding whole-project semantic enrichment', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(commandAnalysisBudget(fakeLargeDb(), 'dead', true)).toEqual({ semantic: false });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('scanning all candidates'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('semantic enrichment disabled'));
  });
});

describe('healthPhaseConcurrency', () => {
  it('uses an adaptive default capped below the full phase count', () => {
    expect(healthPhaseConcurrency(20, {}, () => 14)).toBe(12);
    expect(healthPhaseConcurrency(20, {}, () => 6)).toBe(5);
    expect(healthPhaseConcurrency(3, {}, () => 14)).toBe(3);
  });

  it('honors explicit environment overrides', () => {
    expect(healthPhaseConcurrency(20, { SCIP_QUERY_HEALTH_CONCURRENCY: '6' }, () => 14)).toBe(6);
    expect(healthPhaseConcurrency(20, { SCIP_QUERY_HEALTH_CONCURRENCY: '100' }, () => 14)).toBe(20);
    expect(healthPhaseConcurrency(20, { SCIP_QUERY_HEALTH_CONCURRENCY: 'nope' }, () => 14)).toBe(12);
  });
});

describe('fullHealthPhaseConcurrency', () => {
  const GIB = 1024 * 1024 * 1024;

  it('runs as many memory-heavy phase tasks as half the machine can hold, at most four', () => {
    // 61 GiB: floor(30.5 GiB / 7 GiB) = 4 → capped at the maximum of four.
    expect(fullHealthPhaseConcurrency(20, {}, () => 24, 61 * GIB)).toBe(4);
    // 32 GiB: floor(16 GiB / 7 GiB) = 2.
    expect(fullHealthPhaseConcurrency(20, {}, () => 24, 32 * GIB)).toBe(2);
    // 16 GiB laptop: one phase at a time, as before.
    expect(fullHealthPhaseConcurrency(20, {}, () => 14, 16 * GIB)).toBe(1);
    // Two cores leave one worker regardless of memory.
    expect(fullHealthPhaseConcurrency(20, {}, () => 2, 128 * GIB)).toBe(1);
    // Never more workers than tasks, and an unknown machine size falls back to CPU gating.
    expect(fullHealthPhaseConcurrency(1, {}, () => 14, 61 * GIB)).toBe(1);
    expect(fullHealthPhaseConcurrency(20, {}, () => 24, Number.NaN)).toBe(4);
  });

  it('honors an explicit override', () => {
    expect(fullHealthPhaseConcurrency(20, { SCIP_QUERY_HEALTH_FULL_CONCURRENCY: '2' }, () => 14, 16 * GIB)).toBe(2);
    expect(fullHealthPhaseConcurrency(20, { SCIP_QUERY_HEALTH_FULL_CONCURRENCY: '1' }, () => 24, 61 * GIB)).toBe(1);
  });
});

describe('healthPhaseTimeoutMs', () => {
  it('gives exhaustive full phases enough time while bounding stuck workers', () => {
    expect(healthPhaseTimeoutMs({}, {})).toBe(30000);
    expect(healthPhaseTimeoutMs({ full: true }, {})).toBe(600000);
  });

  it('allows the health phase timeout to be overridden or disabled', () => {
    expect(healthPhaseTimeoutMs({}, { SCIP_QUERY_HEALTH_PHASE_TIMEOUT_MS: '12000' })).toBe(12000);
    expect(healthPhaseTimeoutMs({ full: true }, { SCIP_QUERY_HEALTH_PHASE_TIMEOUT_MS: '12000' })).toBe(12000);
    expect(healthPhaseTimeoutMs({}, { SCIP_QUERY_HEALTH_PHASE_TIMEOUT_MS: '0' })).toBeUndefined();
    expect(healthPhaseTimeoutMs({}, { SCIP_QUERY_HEALTH_PHASE_TIMEOUT_MS: 'nope' })).toBe(30000);
    expect(healthPhaseTimeoutMs({ full: true }, { SCIP_QUERY_HEALTH_PHASE_TIMEOUT_MS: 'nope' })).toBe(600000);
  });
});

describe('orderHealthPhaseTasksByCost', () => {
  it('starts the heaviest isolated tasks first and keeps the original order for ties', () => {
    expect(
      orderHealthPhaseTasksByCost([
        ['cycles'],
        ['drift'],
        ['dead'],
        ['similar', 'extract-candidates'],
        ['wrapper-candidates'],
        ['git-evidence'],
      ]),
    ).toEqual([
      ['similar', 'extract-candidates'],
      ['wrapper-candidates'],
      ['dead'],
      ['cycles'],
      ['drift'],
      ['git-evidence'],
    ]);
  });
});

describe('healthSemanticPrewarmHeapMb', () => {
  it('uses a bounded isolated heap with an explicit override', () => {
    const GIB = 1024 * 1024 * 1024;
    expect(healthSemanticPrewarmHeapMb({}, 64 * GIB)).toBe(16384);
    expect(healthSemanticPrewarmHeapMb({ SCIP_QUERY_HEALTH_SEMANTIC_PREWARM_HEAP_MB: '6144' }, 64 * GIB)).toBe(6144);
    expect(healthSemanticPrewarmHeapMb({ SCIP_QUERY_HEALTH_SEMANTIC_PREWARM_HEAP_MB: 'invalid' }, 64 * GIB)).toBe(16384);
    expect(healthSemanticPrewarmHeapMb({ SCIP_QUERY_HEALTH_SEMANTIC_PREWARM_HEAP_MB: '12288' }, 8 * GIB)).toBe(12288);
  });

  it('derives the default heap from physical memory within fixed bounds', () => {
    const GIB = 1024 * 1024 * 1024;
    // Half of physical memory, between 2 GB and 16 GB: a large compiler
    // program then crosses the pressure threshold, and rebuilds its session,
    // far less often on a big machine, while a laptop keeps today's bound.
    expect(defaultHealthSemanticPrewarmHeapMb(64 * GIB)).toBe(16384);
    expect(defaultHealthSemanticPrewarmHeapMb(32 * GIB)).toBe(16384);
    expect(defaultHealthSemanticPrewarmHeapMb(16 * GIB)).toBe(8192);
    expect(defaultHealthSemanticPrewarmHeapMb(8 * GIB)).toBe(4096);
    expect(defaultHealthSemanticPrewarmHeapMb(2 * GIB)).toBe(2048);
    expect(defaultHealthSemanticPrewarmHeapMb(Number.NaN)).toBe(16384);
  });
});

describe('healthSemanticPrewarmTimeoutMs', () => {
  it('bounds the isolated prewarm with an explicit override', () => {
    expect(healthSemanticPrewarmTimeoutMs({})).toBe(600000);
    expect(healthSemanticPrewarmTimeoutMs({ SCIP_QUERY_HEALTH_SEMANTIC_PREWARM_TIMEOUT_MS: '1200000' })).toBe(1200000);
    expect(healthSemanticPrewarmTimeoutMs({ SCIP_QUERY_HEALTH_SEMANTIC_PREWARM_TIMEOUT_MS: 'invalid' })).toBe(600000);
  });
});

describe('healthSemanticPrewarmFileBatches', () => {
  it('keeps every definition, grouped by file, within the batch file bound', () => {
    const definitions = [
      fakeDefinition(1, 'src/a.ts'),
      fakeDefinition(2, 'src/b.ts'),
      fakeDefinition(3, 'src/a.ts'),
      fakeDefinition(4, 'src/c.ts'),
    ];

    const batches = healthSemanticPrewarmFileBatches(definitions, 2);

    expect(batches.map((batch) => batch.map((definition) => definition.symbolId))).toEqual([[1, 3, 2], [4]]);
    expect(batches.flat()).toHaveLength(definitions.length);
  });

  it('rejects an invalid batch bound', () => {
    expect(() => healthSemanticPrewarmFileBatches([], 0)).toThrow('positive safe integer');
  });
});

describe('diffImpactBatchHeapMb', () => {
  it('bounds the isolated diff-impact batch heap by machine memory with an explicit override', () => {
    const GIB = 1024 * 1024 * 1024;
    expect(diffImpactBatchHeapMb({}, 64 * GIB)).toBe(6144);
    expect(diffImpactBatchHeapMb({}, 8 * GIB)).toBe(4096);
    expect(diffImpactBatchHeapMb({}, 2 * GIB)).toBe(2048);
    expect(diffImpactBatchHeapMb({ SCIP_QUERY_DIFF_IMPACT_BATCH_HEAP_MB: '8192' }, 8 * GIB)).toBe(8192);
    expect(diffImpactBatchHeapMb({ SCIP_QUERY_DIFF_IMPACT_BATCH_HEAP_MB: 'invalid' }, 64 * GIB)).toBe(6144);
  });
});

describe('diffImpactBatchTimeoutMs', () => {
  it('gives a cold batch the full-health phase budget with an explicit override', () => {
    expect(diffImpactBatchTimeoutMs({})).toBe(600000);
    expect(diffImpactBatchTimeoutMs({ SCIP_QUERY_DIFF_IMPACT_BATCH_TIMEOUT_MS: '1200000' })).toBe(1200000);
    expect(diffImpactBatchTimeoutMs({ SCIP_QUERY_DIFF_IMPACT_BATCH_TIMEOUT_MS: 'invalid' })).toBe(600000);
    expect(diffImpactBatchTimeoutMs({ SCIP_QUERY_DIFF_IMPACT_BATCH_TIMEOUT_MS: '0' })).toBe(600000);
  });
});

describe('fullHealthPhaseHeapMb', () => {
  it('uses a bounded isolated heap with an explicit override', () => {
    expect(fullHealthPhaseHeapMb({})).toBe(6144);
    expect(fullHealthPhaseHeapMb({ SCIP_QUERY_HEALTH_FULL_PHASE_HEAP_MB: '8192' })).toBe(8192);
    expect(fullHealthPhaseHeapMb({ SCIP_QUERY_HEALTH_FULL_PHASE_HEAP_MB: 'invalid' })).toBe(6144);
  });
});

describe('prewarmHealthSemanticEvidence', () => {
  it('does not run semantic prewarm outside full health mode', async () => {
    const runtime = fakePrewarmRuntime();

    await expect(prewarmHealthSemanticEvidence(fakeLargeDb(), {}, runtime)).resolves.toMatchObject({
      status: 'skipped',
      reason: 'default-mode',
    });
    expect(runtime.projectFingerprint).not.toHaveBeenCalled();
  });

  it('honors the prewarm disable environment switch', async () => {
    const runtime = fakePrewarmRuntime({ env: { SCIP_QUERY_HEALTH_SEMANTIC_PREWARM: '0' } as NodeJS.ProcessEnv });

    await expect(prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime)).resolves.toMatchObject({
      status: 'skipped',
      reason: 'disabled',
    });
    expect(runtime.projectFingerprint).not.toHaveBeenCalled();
  });

  it('skips candidate scans when the project prewarm marker is warm', async () => {
    const runtime = fakePrewarmRuntime({
      readMarker: vi.fn(() => ({
        version: 2,
        definitions: 2,
        referenceCacheWrites: 2,
        referenceIncomplete: 0,
        calleeRows: 1,
        warmedAt: 123,
      })),
    });

    await expect(prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime)).resolves.toMatchObject({
      status: 'skipped',
      reason: 'cache-hit',
    });
    expect(runtime.candidateDefinitions).not.toHaveBeenCalled();
    expect(runtime.warmReferenceFragments).not.toHaveBeenCalled();
    expect(runtime.materializeReferences).not.toHaveBeenCalled();
    expect(runtime.materializeCallees).not.toHaveBeenCalled();
  });

  it('ignores prewarm markers that recorded incomplete Rust references', async () => {
    const runtime = fakePrewarmRuntime({
      readMarker: vi.fn(() => ({
        version: 2,
        definitions: 2,
        referenceCacheWrites: 1,
        referenceIncomplete: 1,
        calleeRows: 1,
        warmedAt: 123,
      })),
    });

    await expect(prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime)).resolves.toMatchObject({
      status: 'warmed',
      reason: 'cache-miss',
      definitions: 2,
    });
    expect(runtime.candidateDefinitions).toHaveBeenCalledTimes(1);
    expect(runtime.materializeReferences).toHaveBeenCalledTimes(1);
  });

  it('batches the callee prewarm by file and releases the provider only under heap pressure', async () => {
    const definitions = Array.from({ length: 300 }, (_, index) => fakeDefinition(index + 1, `src/file-${index}.ts`));
    const heapFractions = [0.8, 0.2];
    const materializeCallees = vi.fn((_db: unknown, batch: readonly IndexedDefinition[]) => {
      return new Map(batch.map((definition) => [definition.symbolId, []]));
    });
    const releaseSemanticMemory = vi.fn();
    const runtime = fakePrewarmRuntime({
      candidateDefinitions: vi.fn(() => definitions),
      materializeCallees,
      releaseSemanticMemory,
      heapUsedFraction: vi.fn(() => heapFractions.shift() ?? 0.2),
    });

    const result = await prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime);

    expect(result).toMatchObject({ status: 'warmed', calleeRows: 300 });
    // 300 single-definition files at 256 files per batch → two callee batches.
    expect(materializeCallees).toHaveBeenCalledTimes(2);
    // One unconditional release after the reference pass, one pressure-driven
    // release after the first callee batch, none after the second (0.2 < 0.75).
    expect(releaseSemanticMemory).toHaveBeenCalledTimes(2);
    expect(runtime.writeMarker).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'project-a',
      expect.objectContaining({ calleeRows: 300 }),
    );
  });

  it('persists import products in yielding batches before the provider builds', async () => {
    const order: string[] = [];
    const warmSourceDependencies = vi.fn(async () => {
      order.push('source-dependencies');
      return { files: 7 };
    });
    const warmReferenceFragments = vi.fn(async () => {
      order.push('reference-fragments');
      return { files: 1, cacheHits: 0, cacheMisses: 1, computedFiles: 1 };
    });
    const runtime = fakePrewarmRuntime({
      candidateDefinitions: vi.fn(() => [fakeDefinition(1, 'src/main.ts')]),
      warmSourceDependencies,
      warmReferenceFragments,
    });

    const result = await prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime);

    expect(result).toMatchObject({ status: 'warmed', sourceDependencyFiles: 7, sourceFactsFiles: 2, referenceFragmentFiles: 1 });
    // The dependency graph the provider needs must already be served from
    // persisted products when the provider builds; otherwise it parses every
    // file in one synchronous sweep that cannot free a single tree.
    expect(order).toEqual(['source-dependencies', 'reference-fragments']);
  });

  it('warms TypeScript reference fragments instead of assembling the project reference map', async () => {
    const definitions = Array.from({ length: 300 }, (_, index) => fakeDefinition(index + 1, `src/file-${index}.ts`));
    const warmReferenceFragments = vi.fn(
      async (_db: unknown, onBatch?: (progress: { computedFiles: number; missingFiles: number }) => void) => {
        onBatch?.({ computedFiles: 128, missingFiles: 300 });
        onBatch?.({ computedFiles: 300, missingFiles: 300 });
        return { files: 300, cacheHits: 0, cacheMisses: 300, computedFiles: 300 };
      },
    );
    const collectGarbage = vi.fn(() => true);
    const releaseSemanticMemory = vi.fn();
    const heapFractions = [0.9, 0.9, 0.2, 0.2];
    const runtime = fakePrewarmRuntime({
      candidateDefinitions: vi.fn(() => definitions),
      warmReferenceFragments,
      collectGarbage,
      releaseSemanticMemory,
      heapUsedFraction: vi.fn(() => heapFractions.shift() ?? 0.2),
    });

    const result = await prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime);

    expect(result).toMatchObject({
      status: 'warmed',
      definitions: 300,
      referenceFragmentFiles: 300,
      referenceFragmentComputedFiles: 300,
      referenceCacheWrites: 0,
    });
    expect(warmReferenceFragments).toHaveBeenCalledTimes(1);
    // Fragment rows are the warm state; the per-definition path never runs for them.
    expect(runtime.materializeReferences).not.toHaveBeenCalled();
    // The first fragment batch measured pressure (0.9), collected, and measured
    // again (0.9): still under pressure, so the compiler session is discarded
    // and the next batch resolves a fresh provider. The second batch (0.2) is
    // left alone.
    expect(collectGarbage).toHaveBeenCalledTimes(1);
    // One pressure-driven release plus the unconditional one after the stage.
    expect(releaseSemanticMemory).toHaveBeenCalledTimes(2);
  });

  it('materializes non-TypeScript references in persisted file batches and collects before releasing', async () => {
    const definitions = Array.from({ length: 300 }, (_, index) => fakeDefinition(index + 1, `src/file-${index}.rs`));
    const materializeReferences = vi.fn((_db: unknown, batch: readonly IndexedDefinition[]) => ({
      definitions: batch.length,
      inMemoryHits: 0,
      incompleteInMemoryHits: 0,
      cacheHits: 0,
      misses: batch.length,
      unkeyed: 0,
      skippedUnsupportedLanguage: 0,
      parseFailures: 0,
      computed: batch.length,
      incomplete: 0,
      cacheWrites: batch.length,
    }));
    const collectGarbage = vi.fn(() => true);
    const releaseSemanticMemory = vi.fn();
    const heapFractions = [0.9, 0.5, 0.9, 0.9];
    const runtime = fakePrewarmRuntime({
      candidateDefinitions: vi.fn(() => definitions),
      materializeReferences,
      collectGarbage,
      releaseSemanticMemory,
      heapUsedFraction: vi.fn(() => heapFractions.shift() ?? 0.2),
    });

    const result = await prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime);

    expect(result).toMatchObject({ status: 'warmed', definitions: 300, referenceCacheWrites: 300 });
    expect(result).not.toHaveProperty('referenceFragmentFiles');
    expect(runtime.warmReferenceFragments).not.toHaveBeenCalled();
    // 300 single-definition files at 256 files per batch → two reference batches.
    expect(materializeReferences).toHaveBeenCalledTimes(2);
    // Batch one: pressure (0.9) relieved by a collection (0.5), no release.
    // Batch two: pressure (0.9) survives the collection (0.9), so release.
    expect(collectGarbage).toHaveBeenCalledTimes(2);
    // One pressure-driven release plus the unconditional one after the stage.
    expect(releaseSemanticMemory).toHaveBeenCalledTimes(2);
    // Every batch of both stages yields an event-loop turn.
    expect(runtime.yieldToEventLoop).toHaveBeenCalledTimes(4);
  });

  it('falls back to batched per-definition references when the fragment path is unavailable', async () => {
    const definitions = Array.from({ length: 300 }, (_, index) => fakeDefinition(index + 1, `src/file-${index}.ts`));
    const materializeReferences = vi.fn((_db: unknown, batch: readonly IndexedDefinition[]) => ({
      definitions: batch.length,
      inMemoryHits: 0,
      incompleteInMemoryHits: 0,
      cacheHits: 0,
      misses: batch.length,
      unkeyed: 0,
      skippedUnsupportedLanguage: 0,
      parseFailures: 0,
      computed: batch.length,
      incomplete: 0,
      cacheWrites: batch.length,
    }));
    const runtime = fakePrewarmRuntime({
      candidateDefinitions: vi.fn(() => definitions),
      warmReferenceFragments: vi.fn(async () => null),
      materializeReferences,
    });

    const result = await prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime);

    expect(result).toMatchObject({ status: 'warmed', definitions: 300, referenceCacheWrites: 300 });
    expect(result).not.toHaveProperty('referenceFragmentFiles');
    expect(materializeReferences).toHaveBeenCalledTimes(2);
  });

  it('materializes reference and callee caches before writing the project marker', async () => {
    const runtime = fakePrewarmRuntime();

    await expect(
      prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true, scope: 'src' }, runtime),
    ).resolves.toMatchObject({
      status: 'warmed',
      definitions: 2,
      referenceCacheWrites: 1,
      referenceFragmentFiles: 1,
      referenceFragmentComputedFiles: 1,
      calleeRows: 1,
    });
    expect(runtime.warmReferenceFragments).toHaveBeenCalledTimes(1);
    // Only the Rust definition reaches the per-definition path.
    expect(runtime.materializeReferences).toHaveBeenCalledTimes(1);
    expect(runtime.materializeReferences).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ relativePath: 'src/lib.rs' })],
      { prefetchCallees: false },
    );
    expect(runtime.releaseSemanticMemory).toHaveBeenCalledTimes(1);
    expect(runtime.materializeCallees).toHaveBeenCalledTimes(1);
    expect(runtime.writeMarker).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('"scope":"src"'),
      'project-a',
      expect.objectContaining({
        version: 2,
        referenceIncomplete: 0,
        definitions: 2,
        referenceCacheWrites: 1,
        calleeRows: 1,
      }),
    );
    expect(runtime.writeMarker).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('"semanticEngineFingerprint":"semantic-engine-a"'),
      'project-a',
      expect.anything(),
    );
  });

  it('profiles each semantic prewarm stage with result cardinalities', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-health-prewarm-'));
    const profilePath = join(tempDir, 'profile.jsonl');
    const previousProfile = process.env.SCIP_QUERY_PROFILE;
    const previousProfileOut = process.env.SCIP_QUERY_PROFILE_OUT;

    try {
      process.env.SCIP_QUERY_PROFILE = '1';
      process.env.SCIP_QUERY_PROFILE_OUT = profilePath;

      await expect(
        prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, fakePrewarmRuntime()),
      ).resolves.toMatchObject({
        status: 'warmed',
        definitions: 2,
      });

      const events = readFileSync(profilePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(
        events
          .filter((event) => String(event.name).startsWith('health.semantic-prewarm'))
          .map(({ name, definitions, rows }) => ({ name, definitions, rows })),
      ).toEqual([
        { name: 'health.semantic-prewarm.candidate-definitions', definitions: 2 },
        { name: 'health.semantic-prewarm.source-dependencies' },
        { name: 'health.semantic-prewarm.source-facts' },
        { name: 'health.semantic-prewarm.reference-fragments', definitions: 1, rows: 1 },
        { name: 'health.semantic-prewarm.references', definitions: 1, rows: 1 },
        { name: 'health.semantic-prewarm.release-reference-memory' },
        { name: 'health.semantic-prewarm.callees', definitions: 2, rows: 1 },
        { name: 'health.semantic-prewarm.marker-write' },
        { name: 'health.semantic-prewarm', definitions: 2 },
      ]);
    } finally {
      if (previousProfile === undefined) delete process.env.SCIP_QUERY_PROFILE;
      else process.env.SCIP_QUERY_PROFILE = previousProfile;
      if (previousProfileOut === undefined) delete process.env.SCIP_QUERY_PROFILE_OUT;
      else process.env.SCIP_QUERY_PROFILE_OUT = previousProfileOut;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not mark a project warm when the semantic provider is unavailable', async () => {
    const runtime = fakePrewarmRuntime({
      warmReferenceFragments: vi.fn(async () => null),
      materializeReferences: vi.fn((_, definitions) => ({
        definitions: definitions.length,
        inMemoryHits: 0,
        incompleteInMemoryHits: 0,
        cacheHits: 0,
        misses: definitions.length,
        unkeyed: 0,
        skippedUnsupportedLanguage: 0,
        parseFailures: 0,
        computed: 0,
        incomplete: 0,
        cacheWrites: 0,
      })),
    });

    await expect(prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime)).resolves.toMatchObject({
      status: 'skipped',
      reason: 'provider-unavailable',
      definitions: 2,
      referenceMisses: 2,
    });
    expect(runtime.materializeCallees).not.toHaveBeenCalled();
    expect(runtime.writeMarker).not.toHaveBeenCalled();
  });

  it('does not mark a project warm when Rust reference materialization is incomplete', async () => {
    const runtime = fakePrewarmRuntime({
      materializeReferences: vi.fn((_, definitions) => ({
        definitions: definitions.length,
        inMemoryHits: 0,
        incompleteInMemoryHits: 0,
        cacheHits: 0,
        misses: definitions.length,
        unkeyed: 0,
        skippedUnsupportedLanguage: 0,
        parseFailures: 0,
        computed: definitions.length - 1,
        incomplete: 1,
        cacheWrites: definitions.length - 1,
      })),
    });

    await expect(prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime)).resolves.toMatchObject({
      status: 'partial',
      reason: 'incomplete-references',
      definitions: 2,
      referenceIncomplete: 1,
      calleeRows: 1,
    });
    expect(runtime.materializeCallees).toHaveBeenCalledTimes(1);
    expect(runtime.writeMarker).not.toHaveBeenCalled();
  });
});

describe('frontend health phase pruning', () => {
  it('groups runnable frontend phases by framework for cache reuse', async () => {
    expect(
      healthPhaseTasks([
        'overview',
        'react-component-duplicates',
        'react-hook-candidates',
        'react-large-component-pressure',
        'vue-component-duplicates',
        'vue-composable-candidates',
        'vue-large-view-pressure',
        'dead',
      ]),
    ).toEqual([
      ['overview'],
      ['react-component-duplicates', 'react-hook-candidates', 'react-large-component-pressure'],
      ['vue-component-duplicates', 'vue-composable-candidates', 'vue-large-view-pressure'],
      ['dead'],
    ]);
  });

  it('groups cheap health phases to avoid a late second scheduling wave', async () => {
    expect(
      healthPhaseTasks([
        'dead',
        'cycles',
        'similar',
        'react-component-duplicates',
        'react-hook-candidates',
        'react-large-component-pressure',
        'vue-component-duplicates',
        'vue-composable-candidates',
        'vue-large-view-pressure',
        'extract-candidates',
        'suppressions',
      ]),
    ).toEqual([
      ['dead'],
      ['cycles'],
      ['similar', 'extract-candidates'],
      ['react-component-duplicates', 'react-hook-candidates', 'react-large-component-pressure'],
      ['vue-component-duplicates', 'vue-composable-candidates', 'vue-large-view-pressure', 'suppressions'],
    ]);
  });

  it('runs frontend phases only when matching files are present', async () => {
    expect(
      shouldRunHealthPhase('react-component-duplicates', {
        react: false,
        vue: true,
      }),
    ).toBe(false);
    expect(
      shouldRunHealthPhase('react-hook-candidates', {
        react: true,
        vue: false,
      }),
    ).toBe(true);
    expect(
      shouldRunHealthPhase('vue-large-view-pressure', {
        react: true,
        vue: false,
      }),
    ).toBe(false);
    expect(
      shouldRunHealthPhase('dead', {
        react: false,
        vue: false,
      }),
    ).toBe(true);
  });

  it('synthesizes the same empty summaries frontend phases return with no source files', async () => {
    expect(skippedHealthPhaseResult('react-component-duplicates')).toEqual({
      phase: 'react-component-duplicates',
      reactComponentDuplicates: { count: 0, loc: 0, files: [] },
    });
    expect(skippedHealthPhaseResult('vue-composable-candidates')).toEqual({
      phase: 'vue-composable-candidates',
      vueComposableCandidates: { count: 0, loc: 0, files: [] },
    });
  });

  it('synthesizes zero-pressure deferred summaries for timed-out default health phases', async () => {
    expect(deferredHealthPhaseResult('twin-drift', 30000, 'slow')).toMatchObject({
      phase: 'twin-drift',
      twinDrift: { count: 0, loc: 0, files: [] },
    });
    expect(deferredHealthPhaseResult('complexity-hotspots', 30000, 'slow')).toMatchObject({
      phase: 'complexity-hotspots',
      complexity: { top: [], extremeCount: 0 },
    });
    expect(deferredHealthPhaseResult('stale-abstractions', 30000, 'slow')).toMatchObject({
      phase: 'stale-abstractions',
      stale: { count: 0, loc: 0, files: [], unused: 0, singleUse: 0 },
    });
  });

  it('summarizes isolated health failures without copying unbounded child stderr', async () => {
    expect(healthIsolatedFailureReason(new Error('worker failed:\nFATAL ERROR: heap out of memory'))).toBe(
      'exceeded its isolated memory limit',
    );
    expect(healthIsolatedFailureReason(new Error(`failure ${'x'.repeat(400)}`))).toHaveLength(240);
  });
});

describe('diffImpactBatchConcurrency', () => {
  it('amortizes one project-wide reference scan across a large changed-file set', async () => {
    const files = Array.from({ length: 129 }, (_, index) => `src/file-${index}.ts`);
    expect(diffImpactBatches(files.slice(0, 93))).toEqual([files.slice(0, 93)]);
    expect(diffImpactBatches(files)).toEqual([files.slice(0, 128), files.slice(128)]);
  });

  it('runs cache-heavy batches sequentially by default', async () => {
    expect(diffImpactBatchConcurrency(20, {}, () => 14)).toBe(1);
    expect(diffImpactBatchConcurrency(20, {}, () => 6)).toBe(1);
    expect(diffImpactBatchConcurrency(3, {}, () => 14)).toBe(1);
  });

  it('honors explicit environment overrides', async () => {
    expect(diffImpactBatchConcurrency(20, { SCIP_QUERY_DIFF_IMPACT_CONCURRENCY: '6' }, () => 14)).toBe(6);
    expect(diffImpactBatchConcurrency(20, { SCIP_QUERY_DIFF_IMPACT_CONCURRENCY: '100' }, () => 14)).toBe(20);
    expect(diffImpactBatchConcurrency(20, { SCIP_QUERY_DIFF_IMPACT_CONCURRENCY: 'nope' }, () => 14)).toBe(1);
  });
});
