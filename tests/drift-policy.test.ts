import { describe, expect, it } from 'vitest';
import {
  getArchitecturalLayer,
  isKnownProjectLayerDependency,
  layerPolicyForEdge,
} from '../src/queries/drift-policy.js';

describe('drift layer policy', () => {
  it('classifies source subdirectories as project layers', () => {
    expect(getArchitecturalLayer('src/queries/dead.ts')).toBe('src/queries');
    expect(getArchitecturalLayer('src/reindex/index.ts')).toBe('src/reindex');
  });

  it('allows explicit src architecture edges and rejects unknown reverse edges', () => {
    expect(layerPolicyForEdge('src/queries', 'src/core')).toBe('ok');
    expect(layerPolicyForEdge('src/language-parsers', 'src/resolution')).toBe('ok');
    expect(layerPolicyForEdge('src/reindex', 'src/semantic')).toBe('ok');
    expect(layerPolicyForEdge('src/runtime', 'src/semantic')).toBe('violation');
    expect(layerPolicyForEdge('src/domain', 'src/storage')).toBe('violation');
  });

  it('keeps generic app-layer drift useful for fixture-style projects', () => {
    expect(layerPolicyForEdge('app', 'core')).toBe('ok');
    expect(layerPolicyForEdge('app', 'infra')).toBe('violation');
    expect(layerPolicyForEdge('feature', 'infra')).toBeNull();
  });

  it('distinguishes this project policy from generic project shapes', () => {
    expect(isKnownProjectLayerDependency('src/queries/dead.ts', 'src/core/project-index.ts')).toBe(true);
    expect(isKnownProjectLayerDependency('app/service.ts', 'core/state.ts')).toBe(false);
  });
});
