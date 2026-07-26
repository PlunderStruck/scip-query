import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  advanceNpmReleaseState,
  assertNpmReleaseStateMatches,
  createNpmReleaseState,
  decodeNpmReleaseState,
  NPM_RELEASE_STATE_KIND,
  NPM_RELEASE_STATE_VERSION,
  npmReleaseStatePath,
  parseNpmReleaseStateJson,
  serializeNpmReleaseState,
  type ReleasePackageIdentity,
} from '../../scripts/npm-release-state.js';

const MAIN: ReleasePackageIdentity = {
  name: 'scip-query',
  version: '0.19.6',
  size: 123,
  shasum: 'a'.repeat(40),
  integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
};
const SIDECAR: ReleasePackageIdentity = {
  name: 'scip-query-scip-windows',
  version: '0.13.1',
  size: 456,
  shasum: 'b'.repeat(40),
  integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
};
const GIT_REVISION = 'c'.repeat(40);
const REGISTRY = 'https://registry.npmjs.org/';

describe('npm release state contract', () => {
  it('round-trips a current additive record and keeps the schema discriminator aligned', () => {
    const state = createNpmReleaseState({
      main: MAIN,
      sidecar: SIDECAR,
      gitRevision: GIT_REVISION,
      registry: REGISTRY,
      now: '2026-07-25T00:00:00.000Z',
    });
    const decoded = decodeNpmReleaseState({
      ...state,
      additiveFutureField: { ignored: true },
      packages: {
        ...state.packages,
        main: { ...state.packages.main, additivePackageField: true },
      },
    });
    const schema = JSON.parse(readFileSync('docs/schemas/npm-release-state.schema.json', 'utf8')) as {
      required: string[];
      properties: {
        kind: { const: string };
        schemaVersion: { const: number };
        source: {
          required: string[];
          properties: { gitRevision: { pattern: string }; registry: { pattern: string } };
        };
        completedStages: { items: { enum: string[] }; oneOf: Array<{ const: string[] }> };
      };
    };

    expect(parseNpmReleaseStateJson(serializeNpmReleaseState(state))).toEqual(state);
    expect(decoded).toEqual(state);
    expect(schema.properties.kind.const).toBe(NPM_RELEASE_STATE_KIND);
    expect(schema.properties.schemaVersion.const).toBe(NPM_RELEASE_STATE_VERSION);
    expect(schema.required).toContain('source');
    expect(schema.properties.source.required).toContain('gitRevision');
    expect(schema.properties.source.required).toContain('registry');
    expect(GIT_REVISION).toMatch(new RegExp(schema.properties.source.properties.gitRevision.pattern));
    expect(REGISTRY).toMatch(new RegExp(schema.properties.source.properties.registry.pattern));
    expect(schema.properties.completedStages.items.enum).toEqual([
      'local-preflight-complete',
      'sidecar-registry-verified',
      'main-registry-verified',
    ]);
    expect(schema.properties.completedStages.oneOf.map((variant) => variant.const)).toEqual([
      ['local-preflight-complete'],
      ['local-preflight-complete', 'sidecar-registry-verified'],
      ['local-preflight-complete', 'main-registry-verified'],
      ['local-preflight-complete', 'sidecar-registry-verified', 'main-registry-verified'],
    ]);
  });

  it('advances facts monotonically in canonical order', () => {
    const initial = createNpmReleaseState({
      main: MAIN,
      sidecar: SIDECAR,
      gitRevision: GIT_REVISION,
      registry: REGISTRY,
      now: '2026-07-25T00:00:00.000Z',
    });
    const mainObservedFirst = advanceNpmReleaseState(initial, ['main-registry-verified'], '2026-07-25T00:01:00.000Z');
    const complete = advanceNpmReleaseState(
      mainObservedFirst,
      ['sidecar-registry-verified', 'main-registry-verified'],
      '2026-07-25T00:02:00.000Z',
    );

    expect(mainObservedFirst.completedStages).toEqual(['local-preflight-complete', 'main-registry-verified']);
    expect(complete.completedStages).toEqual([
      'local-preflight-complete',
      'sidecar-registry-verified',
      'main-registry-verified',
    ]);
    expect(complete.createdAt).toBe(initial.createdAt);
  });

  it('keeps updatedAt monotonic when the civil clock moves backward', () => {
    const initial = createNpmReleaseState({
      main: MAIN,
      sidecar: SIDECAR,
      gitRevision: GIT_REVISION,
      registry: REGISTRY,
      now: '2026-07-25T00:02:00.000Z',
    });
    const advanced = advanceNpmReleaseState(initial, ['sidecar-registry-verified'], '2026-07-25T00:01:00.000Z');

    expect(advanced.updatedAt).toBe(initial.updatedAt);
    expect(() => decodeNpmReleaseState(advanced)).not.toThrow();
  });

  it('uses one coordinate-stable path so changed same-version bytes conflict', () => {
    const state = createNpmReleaseState({
      main: MAIN,
      sidecar: SIDECAR,
      gitRevision: GIT_REVISION,
      registry: REGISTRY,
      now: '2026-07-25T00:00:00.000Z',
    });
    const changed = createNpmReleaseState({
      main: { ...MAIN, shasum: 'c'.repeat(40) },
      sidecar: SIDECAR,
      gitRevision: GIT_REVISION,
      registry: REGISTRY,
      now: '2026-07-25T00:00:00.000Z',
    });

    expect(npmReleaseStatePath('/repo', MAIN, SIDECAR)).toBe(
      npmReleaseStatePath('/repo', changed.packages.main, changed.packages.sidecar),
    );
    expect(npmReleaseStatePath('/repo', MAIN, SIDECAR)).toBe(
      npmReleaseStatePath('/repo', MAIN, {
        ...SIDECAR,
        integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}`,
      }),
    );
    expect(() => assertNpmReleaseStateMatches(state, changed)).toThrow(
      'records different source or package bytes. npm versions are immutable',
    );

    const differentRevision = createNpmReleaseState({
      main: MAIN,
      sidecar: SIDECAR,
      gitRevision: 'd'.repeat(40),
      registry: REGISTRY,
      now: '2026-07-25T00:00:00.000Z',
    });
    expect(() => assertNpmReleaseStateMatches(state, differentRevision)).toThrow('resume from the recorded revision');

    const differentRegistry = createNpmReleaseState({
      main: MAIN,
      sidecar: SIDECAR,
      gitRevision: GIT_REVISION,
      registry: 'https://registry.example.test/',
      now: '2026-07-25T00:00:00.000Z',
    });
    expect(() => assertNpmReleaseStateMatches(state, differentRegistry)).toThrow(
      'records different source or package bytes',
    );
  });

  it.each([
    ['malformed JSON', '{', 'not valid JSON'],
    [
      'future schema',
      JSON.stringify({ kind: NPM_RELEASE_STATE_KIND, schemaVersion: 2 }),
      'Unsupported npm release state schema 2',
    ],
  ])('rejects %s', (_label, bytes, expected) => {
    expect(() => parseNpmReleaseStateJson(bytes)).toThrow(expected);
  });

  it('rejects malformed identities, release IDs, time order, stages, and writers', () => {
    const state = createNpmReleaseState({
      main: MAIN,
      sidecar: SIDECAR,
      gitRevision: GIT_REVISION,
      registry: REGISTRY,
      now: '2026-07-25T00:00:00.000Z',
    });

    for (const [mutate, expected] of [
      [(value: Record<string, unknown>) => (value.releaseId = 'short'), 'releaseId'],
      [
        (value: Record<string, unknown>) => (value.source = { gitRevision: 'short', registry: REGISTRY }),
        'gitRevision',
      ],
      [
        (value: Record<string, unknown>) =>
          (value.source = { gitRevision: GIT_REVISION, registry: 'http://registry.example.test/' }),
        'credential-free HTTPS',
      ],
      [
        (value: Record<string, unknown>) =>
          (value.completedStages = ['main-registry-verified', 'local-preflight-complete']),
        'canonical order',
      ],
      [
        (value: Record<string, unknown>) => (value.completedStages = ['local-preflight-complete', 'unknown']),
        'unsupported completed stage',
      ],
      [(value: Record<string, unknown>) => (value.updatedAt = '2025-01-01T00:00:00.000Z'), 'precedes createdAt'],
      [(value: Record<string, unknown>) => (value.updatedAt = 'July 25, 2026'), 'canonical UTC ISO'],
      [(value: Record<string, unknown>) => (value.writer = { name: 'other', version: '1' }), 'writer name'],
      [
        (value: Record<string, unknown>) => (value.writer = { name: 'scip-query', version: '0.19.5' }),
        'writer version',
      ],
    ] as const) {
      const value = structuredClone(state) as unknown as Record<string, unknown>;
      mutate(value);
      expect(() => decodeNpmReleaseState(value)).toThrow(expected);
    }

    expect(() =>
      decodeNpmReleaseState({
        ...state,
        packages: {
          ...state.packages,
          main: { ...state.packages.main, integrity: 'sha1-not-sha512' },
        },
      }),
    ).toThrow('SHA-512');
  });
});
