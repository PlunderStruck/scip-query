import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getArchitecturalLayer,
  isKnownProjectLayerDependency,
  isUnknownSrcLayerEdge,
  knownSrcLayers,
  layerPolicyForEdge,
} from '../../../src/queries/cleanup/drift-policy.js';

describe('drift layer policy', () => {
  it('classifies source subdirectories as project layers', () => {
    expect(getArchitecturalLayer('src/queries/cleanup/dead.ts')).toBe('src/queries');
    expect(getArchitecturalLayer('src/reindex/index.ts')).toBe('src/reindex');
  });

  it('allows explicit src architecture edges and rejects unknown reverse edges', () => {
    expect(layerPolicyForEdge('src/queries', 'src/core')).toBe('ok');
    expect(layerPolicyForEdge('src/language-parsers', 'src/resolution')).toBe('ok');
    expect(layerPolicyForEdge('src/reindex', 'src/semantic')).toBe('ok');
    expect(layerPolicyForEdge('src/runtime', 'src/semantic')).toBe('ok');
    expect(layerPolicyForEdge('src/tla', 'src/source')).toBe('ok');
    expect(layerPolicyForEdge('src/tla', 'src/queries')).toBe('ok');
    expect(layerPolicyForEdge('src/semantic', 'src/instrumentation')).toBe('ok');
    expect(layerPolicyForEdge('src/semantic', 'src/source')).toBe('ok');
    expect(layerPolicyForEdge('src/semantic', 'src/reindex')).toBe('ok');
    expect(layerPolicyForEdge('src/semantic', 'src/runtime')).toBe('ok');
    expect(layerPolicyForEdge('src/runtime', 'src/language-parsers')).toBe('ok');
    expect(layerPolicyForEdge('src/storage', 'src/analysis')).toBe('ok');
    expect(layerPolicyForEdge('src/storage', 'src/queries')).toBe('ok');
    expect(layerPolicyForEdge('src/source', 'src/resolution')).toBe('ok');
    expect(layerPolicyForEdge('src/symbols', 'src/core')).toBe('ok');
    expect(layerPolicyForEdge('src/symbols', 'src/instrumentation')).toBe('ok');
    expect(layerPolicyForEdge('src/domain', 'src/storage')).toBe('violation');
  });

  it('allows the runtime -> tla edge (the CLI layer importing its query module)', () => {
    expect(layerPolicyForEdge('src/runtime', 'src/tla')).toBe('ok');
  });

  it('allows src/core from every layer that hosts a src/core/regex-utils.ts or command-availability.ts consumer', () => {
    expect(layerPolicyForEdge('src/source', 'src/core')).toBe('ok');
    expect(layerPolicyForEdge('src/semantic', 'src/core')).toBe('ok');
    expect(layerPolicyForEdge('src/runtime', 'src/core')).toBe('ok');
    expect(layerPolicyForEdge('src/tla', 'src/core')).toBe('ok');
    expect(layerPolicyForEdge('src/language-parsers', 'src/core')).toBe('ok');
  });

  it('marks unlisted source layers as unknown policy instead of explicit violations', () => {
    expect(layerPolicyForEdge('src/future', 'src/storage')).toBeNull();
    expect(isUnknownSrcLayerEdge('src/future', 'src/storage')).toBe(true);
    expect(isKnownProjectLayerDependency('src/future/file.ts', 'src/storage/db.ts')).toBe(false);
  });

  it('has a policy row for every current src subdirectory', () => {
    const actualSrcDirs = readdirSync(join(process.cwd(), 'src'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(knownSrcLayers()).toEqual(actualSrcDirs);
  });

  it('keeps generic app-layer drift useful for fixture-style projects', () => {
    expect(layerPolicyForEdge('app', 'core')).toBe('ok');
    expect(layerPolicyForEdge('app', 'infra')).toBe('violation');
    expect(layerPolicyForEdge('feature', 'infra')).toBeNull();
  });

  it('distinguishes this project policy from generic project shapes', () => {
    expect(isKnownProjectLayerDependency('src/queries/cleanup/dead.ts', 'src/core/project-index.ts')).toBe(true);
    expect(isKnownProjectLayerDependency('app/service.ts', 'core/state.ts')).toBe(false);
  });
});
