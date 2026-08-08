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
    expect(report.relations.map((relation) => relation.family)).toEqual([
      'execution',
      'runtime',
      'dataflow',
      'state',
      'temporal',
      'contract',
      'identity',
      'ownership',
      'dependencies',
    ]);
    expect(report.relations.find((relation) => relation.family === 'identity')?.status).toBe('exact');
    expect(report.relations.find((relation) => relation.family === 'execution')?.status).toBe('partial');
    expect(report.relations.find((relation) => relation.family === 'dataflow')?.nonClaims).toContain(
      'Current partial providers do not establish general interprocedural definition-use coverage.',
    );
    const dataflow = report.relations.find((relation) => relation.family === 'dataflow');
    expect(dataflow?.providerCapabilities.map((provider) => provider.id)).toEqual([
      'runtime-boundary-join',
      'bounded-static-value-flow',
      'typescript-local-dependence',
      'parser-state-temporal',
    ]);
    expect(
      dataflow?.providerCapabilities.every(
        (provider) => provider.subtypes.length > 0 && provider.languages.length === report.matrix.length,
      ),
    ).toBe(true);
    const localDependence = dataflow?.providerCapabilities.find(
      (provider) => provider.id === 'typescript-local-dependence',
    );
    expect(localDependence?.languages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ language: 'typescript', status: 'partial' }),
        expect.objectContaining({ language: 'python', status: 'unsupported' }),
      ]),
    );
  });

  it('reports syntax-only validation as partial at language and project level', () => {
    const readiness: ProjectReadiness = {
      languages: ['typescript', 'python'],
      indexers: [
        { language: 'typescript', binaryLabel: 'scip-typescript', installed: true, runnable: true },
        { language: 'python', binaryLabel: 'scip-python', installed: true, runnable: true },
      ],
      checkers: [
        {
          label: 'tsc --noEmit',
          coversExtensions: ['.ts', '.tsx'],
          strength: 'reference-aware',
        },
        {
          label: 'python3 -m compileall (syntax only)',
          coversExtensions: ['.py'],
          strength: 'syntax-only',
        },
      ],
      gitAvailable: true,
    };

    const report = getProjectCapabilities(readiness);

    expect(report.matrix.find((row) => row.language === 'typescript')?.cleanupVerification.status).toBe('available');
    expect(report.matrix.find((row) => row.language === 'python')?.cleanupVerification.status).toBe('partial');
    expect(report.capabilities.find((capability) => capability.id === 'cleanup-verification')).toMatchObject({
      label: 'Project cleanup verification',
      status: 'partial',
      evidence: 'checker',
    });
  });

  it('reports registered Rust semantic support separately from implemented semantic facts', () => {
    const readiness: ProjectReadiness = {
      languages: ['rust'],
      indexers: [
        {
          language: 'rust',
          binaryLabel: 'rust-analyzer',
          installed: true,
          runnable: true,
          resolvedBinary: 'rust-analyzer',
        },
      ],
      semantics: [
        {
          language: 'rust',
          available: false,
          dependencyAvailable: true,
          resolvedBinary: 'rust-analyzer',
          reason: 'Rust semantic provider is registered, but rust-analyzer reference queries are not implemented yet.',
        },
      ],
      checkers: [{ label: 'cargo check', coversExtensions: ['.rs'] }],
      gitAvailable: true,
    };

    const report = getProjectCapabilities(readiness);
    const rust = report.matrix[0];

    expect(rust?.language).toBe('rust');
    expect(rust?.semantic.status).toBe('partial');
    expect(rust?.semantic.reason).toContain('registered');
    expect(rust?.semantic.reason).toContain('not implemented yet');
    expect(rust?.cleanupVerification.status).toBe('available');

    const rustSemantic = report.capabilities.find((capability) => capability.id === 'semantic-rust');
    expect(rustSemantic?.label).toBe('Rust semantic provider');
    expect(rustSemantic?.status).toBe('partial');
    expect(rustSemantic?.reason).toContain('registered');
  });

  it('reports TypeScript and Rust semantic providers in the top-level capability summary', () => {
    const readiness: ProjectReadiness = {
      languages: ['rust', 'typescript'],
      indexers: [
        {
          language: 'rust',
          binaryLabel: 'rust-analyzer',
          installed: true,
          runnable: true,
          resolvedBinary: 'rust-analyzer',
        },
        {
          language: 'typescript',
          binaryLabel: 'scip-typescript',
          installed: true,
          runnable: true,
        },
      ],
      semantics: [
        {
          language: 'rust',
          available: true,
          dependencyAvailable: true,
          resolvedBinary: 'rust-analyzer',
        },
        {
          language: 'typescript',
          available: true,
          dependencyAvailable: true,
          tsconfigPath: 'tsconfig.json',
        },
      ],
      checkers: [
        { label: 'cargo check', coversExtensions: ['.rs'] },
        { label: 'tsc --noEmit', coversExtensions: ['.ts', '.tsx', '.js', '.jsx', '.vue'] },
      ],
      gitAvailable: true,
    };

    const report = getProjectCapabilities(readiness);
    const semanticCapabilities = report.capabilities.filter((capability) => capability.id.startsWith('semantic-'));

    expect(semanticCapabilities.map((capability) => capability.id)).toEqual(['semantic-typescript', 'semantic-rust']);
    expect(semanticCapabilities.map((capability) => capability.status)).toEqual(['available', 'available']);
    expect(semanticCapabilities[0]?.reason).toContain('ts-morph');
    expect(semanticCapabilities[1]?.reason).toContain('rust-analyzer');
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
    expect(report.relations.every((relation) => relation.status === 'unsupported')).toBe(true);
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

  it('derives Clojure source-fact status from the runtime probe instead of asserting it (followup #9)', () => {
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

    const available = getProjectCapabilities(readiness, { runtimeProbe: () => 'reader' });
    expect(available.matrix[0]?.sourceFacts.status).toBe('available');

    const unavailable = getProjectCapabilities(readiness, { runtimeProbe: () => 'unavailable' });
    expect(unavailable.matrix[0]?.sourceFacts.status).toBe('unavailable');
  });
});
