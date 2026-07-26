import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commandAnalysisBudget,
  deferredHealthPhaseResult,
  diffImpactBatchConcurrency,
  healthPhaseConcurrency,
  healthPhaseTasks,
  healthPhaseTimeoutMs,
  prewarmHealthSemanticEvidence,
  shouldRunHealthPhase,
  skippedHealthPhaseResult,
  type HealthSemanticPrewarmRuntime,
} from '../../src/runtime/cli-support.js';
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
    materializeCallees: vi.fn(() => new Map([[1, []]])),
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
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Large index detected'));
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

describe('healthPhaseTimeoutMs', () => {
  it('applies a default phase timeout only outside full mode', () => {
    expect(healthPhaseTimeoutMs({}, {})).toBe(30000);
    expect(healthPhaseTimeoutMs({ full: true }, {})).toBeUndefined();
  });

  it('allows the health phase timeout to be overridden or disabled', () => {
    expect(healthPhaseTimeoutMs({}, { SCIP_QUERY_HEALTH_PHASE_TIMEOUT_MS: '12000' })).toBe(12000);
    expect(healthPhaseTimeoutMs({}, { SCIP_QUERY_HEALTH_PHASE_TIMEOUT_MS: '0' })).toBeUndefined();
    expect(healthPhaseTimeoutMs({}, { SCIP_QUERY_HEALTH_PHASE_TIMEOUT_MS: 'nope' })).toBe(30000);
  });
});

describe('prewarmHealthSemanticEvidence', () => {
  it('does not run semantic prewarm outside full health mode', () => {
    const runtime = fakePrewarmRuntime();

    expect(prewarmHealthSemanticEvidence(fakeLargeDb(), {}, runtime)).toMatchObject({
      status: 'skipped',
      reason: 'default-mode',
    });
    expect(runtime.projectFingerprint).not.toHaveBeenCalled();
  });

  it('honors the prewarm disable environment switch', () => {
    const runtime = fakePrewarmRuntime({ env: { SCIP_QUERY_HEALTH_SEMANTIC_PREWARM: '0' } as NodeJS.ProcessEnv });

    expect(prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime)).toMatchObject({
      status: 'skipped',
      reason: 'disabled',
    });
    expect(runtime.projectFingerprint).not.toHaveBeenCalled();
  });

  it('skips candidate scans when the project prewarm marker is warm', () => {
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

    expect(prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime)).toMatchObject({
      status: 'skipped',
      reason: 'cache-hit',
    });
    expect(runtime.candidateDefinitions).not.toHaveBeenCalled();
    expect(runtime.materializeReferences).not.toHaveBeenCalled();
    expect(runtime.materializeCallees).not.toHaveBeenCalled();
  });

  it('ignores prewarm markers that recorded incomplete Rust references', () => {
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

    expect(prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime)).toMatchObject({
      status: 'warmed',
      reason: 'cache-miss',
      definitions: 2,
    });
    expect(runtime.candidateDefinitions).toHaveBeenCalledTimes(1);
    expect(runtime.materializeReferences).toHaveBeenCalledTimes(1);
  });

  it('materializes reference and callee caches before writing the project marker', () => {
    const runtime = fakePrewarmRuntime();

    expect(prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true, scope: 'src' }, runtime)).toMatchObject({
      status: 'warmed',
      definitions: 2,
      referenceCacheWrites: 2,
      calleeRows: 1,
    });
    expect(runtime.materializeReferences).toHaveBeenCalledTimes(1);
    expect(runtime.materializeCallees).toHaveBeenCalledTimes(1);
    expect(runtime.writeMarker).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('"scope":"src"'),
      'project-a',
      expect.objectContaining({
        version: 2,
        referenceIncomplete: 0,
        definitions: 2,
        referenceCacheWrites: 2,
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

  it('profiles each semantic prewarm stage with result cardinalities', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-health-prewarm-'));
    const profilePath = join(tempDir, 'profile.jsonl');
    const previousProfile = process.env.SCIP_QUERY_PROFILE;
    const previousProfileOut = process.env.SCIP_QUERY_PROFILE_OUT;

    try {
      process.env.SCIP_QUERY_PROFILE = '1';
      process.env.SCIP_QUERY_PROFILE_OUT = profilePath;

      expect(prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, fakePrewarmRuntime())).toMatchObject({
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
        { name: 'health.semantic-prewarm.references', definitions: 2, rows: 2 },
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

  it('does not mark a project warm when the semantic provider is unavailable', () => {
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
        computed: 0,
        incomplete: 0,
        cacheWrites: 0,
      })),
    });

    expect(prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime)).toMatchObject({
      status: 'skipped',
      reason: 'provider-unavailable',
      definitions: 2,
      referenceMisses: 2,
    });
    expect(runtime.materializeCallees).not.toHaveBeenCalled();
    expect(runtime.writeMarker).not.toHaveBeenCalled();
  });

  it('does not mark a project warm when Rust reference materialization is incomplete', () => {
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

    expect(prewarmHealthSemanticEvidence(fakeLargeDb(), { full: true }, runtime)).toMatchObject({
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
  it('groups runnable frontend phases by framework for cache reuse', () => {
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

  it('groups cheap health phases to avoid a late second scheduling wave', () => {
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

  it('runs frontend phases only when matching files are present', () => {
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

  it('synthesizes the same empty summaries frontend phases return with no source files', () => {
    expect(skippedHealthPhaseResult('react-component-duplicates')).toEqual({
      phase: 'react-component-duplicates',
      reactComponentDuplicates: { count: 0, loc: 0, files: [] },
    });
    expect(skippedHealthPhaseResult('vue-composable-candidates')).toEqual({
      phase: 'vue-composable-candidates',
      vueComposableCandidates: { count: 0, loc: 0, files: [] },
    });
  });

  it('synthesizes zero-pressure deferred summaries for timed-out default health phases', () => {
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
});

describe('diffImpactBatchConcurrency', () => {
  it('uses an adaptive default capped below the full batch count', () => {
    expect(diffImpactBatchConcurrency(20, {}, () => 14)).toBe(8);
    expect(diffImpactBatchConcurrency(20, {}, () => 6)).toBe(5);
    expect(diffImpactBatchConcurrency(3, {}, () => 14)).toBe(3);
  });

  it('honors explicit environment overrides', () => {
    expect(diffImpactBatchConcurrency(20, { SCIP_QUERY_DIFF_IMPACT_CONCURRENCY: '6' }, () => 14)).toBe(6);
    expect(diffImpactBatchConcurrency(20, { SCIP_QUERY_DIFF_IMPACT_CONCURRENCY: '100' }, () => 14)).toBe(20);
    expect(diffImpactBatchConcurrency(20, { SCIP_QUERY_DIFF_IMPACT_CONCURRENCY: 'nope' }, () => 14)).toBe(8);
  });
});
