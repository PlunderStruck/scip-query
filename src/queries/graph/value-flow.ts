import type { ScipDatabase } from '../../storage/db.js';
import {
  graphEvidence,
  type GraphEvidenceCoverage,
  type GraphEvidenceEdge,
  type GraphEvidenceTarget,
} from './graph-evidence.js';

/** Coverage of the conservative value-flow relationships actually proved. */
export interface ValueFlowCoverage {
  status: GraphEvidenceCoverage['status'];
  basis: 'proved-bounded-static-value-flow';
  analysisBasis: 'partial-system-definition-use';
  providers: readonly ['bounded-static-value-flow', 'typescript-local-dependence'];
  supportedRelations: string[];
  unsupportedRelations: string[];
  graph: GraphEvidenceCoverage;
}

export interface ValueFlowResult {
  kind: 'value-flow';
  targets: GraphEvidenceTarget[];
  edges: GraphEvidenceEdge[];
  coverage: ValueFlowCoverage;
}

/**
 * Project proved value transfers around exact symbol or source-location roots.
 *
 * This is intentionally narrower than a whole-program dataflow claim. The
 * providers prove TypeScript local reaching definitions and right-hand-side
 * assignment flow, compiler-resolved argument-to-parameter forwarding,
 * bounded static argument values, and a callee-return-to-call-result transfer
 * when the call result is consumed. Unsupported heap, exception, and dynamic
 * flow remains in graph coverage rather than being relabeled as proved flow.
 */
export function valueFlow(
  db: ScipDatabase,
  selectors: { symbols?: readonly string[]; locations?: readonly string[]; searches?: readonly string[] },
  options: { maxDepth?: number; maxEdges?: number } = {},
): ValueFlowResult {
  const graph = graphEvidence(db, selectors, {
    families: ['dataflow'],
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    ...(options.maxEdges !== undefined ? { maxEdges: options.maxEdges } : {}),
  });
  return {
    kind: 'value-flow',
    targets: graph.targets,
    edges: graph.edges,
    coverage: {
      status: graph.coverage.status,
      basis: 'proved-bounded-static-value-flow',
      analysisBasis: 'partial-system-definition-use',
      providers: ['bounded-static-value-flow', 'typescript-local-dependence'],
      supportedRelations: [
        'compiler-identified local definitions reaching local reads through a TypeScript control-flow graph',
        'right-hand-side local reads supplying assignments and declarations',
        'candidate closure captures and bounded same-owner field flow with explicit evidence strength',
        'direct argument-to-parameter forwarding at compiler-resolved calls',
        'bounded mechanically derived static arguments',
        'callee return value to a consumed compiler-resolved call result',
      ],
      unsupportedRelations: [
        'general heap alias and cross-instance field points-to flow',
        'exceptional control and value flow',
        'closure invocation order',
        'downstream local definition-use after a call result',
        'dynamic calls not resolved by the semantic provider',
      ],
      graph: graph.coverage,
    },
  };
}
