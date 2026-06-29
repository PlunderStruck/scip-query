import { describe, expect, it } from 'vitest';
import { getProjectCapabilities, type ProjectReadiness } from '../../src/runtime/project-readiness.js';

describe('getProjectCapabilities', () => {
  it('reports per-language semantic and verification support without implying parity', () => {
    const readiness: ProjectReadiness = {
      languages: ['typescript', 'python'],
      indexers: [
        {
          language: 'typescript',
          binaryLabel: 'scip-typescript',
          installed: true,
          runnable: true,
        },
        {
          language: 'python',
          binaryLabel: 'scip-python-plus',
          installed: true,
          runnable: true,
        },
      ],
      semantic: {
        language: 'typescript',
        available: true,
        dependencyAvailable: true,
        tsconfigPath: 'tsconfig.json',
      },
      checkers: [{ label: 'tsc --noEmit', coversExtensions: ['.ts', '.tsx', '.js', '.jsx', '.vue'] }],
      gitAvailable: true,
    };

    const report = getProjectCapabilities(readiness);
    const typescript = report.matrix.find((row) => row.language === 'typescript');
    const python = report.matrix.find((row) => row.language === 'python');

    expect(typescript?.semantic.status).toBe('available');
    expect(typescript?.cleanupVerification.status).toBe('available');
    expect(python?.semantic.status).toBe('unavailable');
    expect(python?.semantic.reason).toContain('No semantic provider is registered for python');
    expect(python?.cleanupVerification.status).toBe('unavailable');
    expect(python?.cleanupVerification.reason).toContain('.py');
  });

  it('marks source fallback unavailable when the language indexer is not runnable', () => {
    const readiness: ProjectReadiness = {
      languages: ['dart'],
      indexers: [
        {
          language: 'dart',
          binaryLabel: 'scip-dart',
          installed: false,
          runnable: false,
          note: 'scip-dart is not installed.',
        },
      ],
      checkers: [],
      gitAvailable: true,
    };

    const report = getProjectCapabilities(readiness);

    expect(report.matrix[0]?.indexing.status).toBe('unavailable');
    expect(report.matrix[0]?.sourceFacts.status).toBe('unavailable');
  });

  it('reports Clojure as graph-backed with source callsite facts and clj-kondo cleanup verification', () => {
    const readiness: ProjectReadiness = {
      languages: ['clojure'],
      indexers: [
        {
          language: 'clojure',
          binaryLabel: 'scip-clojure',
          installed: true,
          runnable: true,
        },
      ],
      checkers: [{ label: 'clj-kondo --lint .', coversExtensions: ['.clj', '.cljs', '.cljc'] }],
      gitAvailable: true,
    };

    const report = getProjectCapabilities(readiness);
    const clojure = report.matrix[0];

    expect(clojure?.language).toBe('clojure');
    expect(clojure?.indexing.status).toBe('available');
    expect(clojure?.sourceFacts.status).toBe('available');
    expect(clojure?.sourceFacts.reason).toContain('callable, callsite, and protocol/record member');
    expect(clojure?.semantic.status).toBe('unavailable');
    expect(clojure?.cleanupVerification.status).toBe('available');
    expect(clojure?.cleanupVerification.reason).toBe('clj-kondo --lint .');
  });

  it('keeps source facts and detectors available when an indexed graph exists but the indexer cannot refresh', () => {
    const readiness: ProjectReadiness = {
      languages: ['clojure'],
      indexers: [
        {
          language: 'clojure',
          binaryLabel: 'scip-clojure',
          installed: false,
          runnable: false,
          note: 'scip-clojure is not installed.',
        },
      ],
      checkers: [{ label: 'clj-kondo --lint .', coversExtensions: ['.clj', '.cljs', '.cljc'] }],
      gitAvailable: true,
    };

    const report = getProjectCapabilities(readiness, { hasIndexedGraph: true });
    const clojure = report.matrix[0];

    expect(report.capabilities.find((capability) => capability.id === 'indexing')?.status).toBe('partial');
    expect(report.capabilities.find((capability) => capability.id === 'heuristic-detectors')?.status).toBe('available');
    expect(clojure?.indexing.status).toBe('partial');
    expect(clojure?.sourceFacts.status).toBe('available');
    expect(clojure?.detectors.status).toBe('available');
  });
});
