/**
 * Single source of truth for the published query surface.
 *
 * One name list drives all three artifacts that previously had to be
 * hand-synchronized: the tsup build entries (tsup.config.ts), the
 * package.json `./queries/*` subpath exports, and the contract test that
 * checks them (tests/cli-contract.test.ts). The contract test also verifies
 * this manifest against the real files in src/queries/, so adding a query
 * module without classifying it here fails the build.
 */

/** Query modules published as `scip-query/queries/<name>` subpath exports. */
export const PUBLIC_QUERY_ENTRIES = [
  'affected',
  'bottlenecks',
  'by-kind',
  'call-graph',
  'change-surface',
  'cleanup-plan',
  'co-change',
  'code',
  'complexity',
  'complexity-hotspots',
  'convergence',
  'coupling',
  'cycles',
  'dataflow',
  'dead',
  'deep-chains',
  'deps',
  'diff-gate',
  'diff-impact',
  'doc-drift',
  'drift',
  'extract-candidates',
  'fan',
  'files',
  'health',
  'hierarchy',
  'hotspots',
  'imports',
  'index',
  'isolated',
  'members',
  'methods',
  'outline',
  'passthrough-candidates',
  'plan-context',
  'recent-duplicates',
  'redundant-reexports',
  'refs',
  'self-audit',
  'similar',
  'similar-chains',
  'similar-files',
  'similar-signatures',
  'slice',
  'stale-abstractions',
  'stats',
  'surface',
  'symbols',
  'system',
  'trace',
  'unused-params',
  'wrapper-candidates',
] as const;

/** Query-directory helper modules that must NOT be published. */
export const PRIVATE_QUERY_MODULES = [
  'dead-exclusions',
  'drift-policy',
  'health-baseline',
  'health-cache-control',
  'health-report',
  'health-types',
  'public-query-entries',
  'query-utils',
] as const;
