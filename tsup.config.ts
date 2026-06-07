import { defineConfig } from 'tsup';

const publicQueryEntries = [
  'affected',
  'bottlenecks',
  'by-kind',
  'call-graph',
  'change-surface',
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
  'diff-impact',
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
  'redundant-reexports',
  'refs',
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
  'wrapper-candidates',
] as const;

const queryEntries = Object.fromEntries(
  publicQueryEntries.map((entry) => [`queries/${entry}`, `src/queries/${entry}.ts`]),
);

// Minify JS to keep the published tarball compact. Sourcemaps are generated
// for local debugging but excluded from the tarball via package.json `files`.
export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      reindex: 'src/reindex/index.ts',
      runtime: 'src/runtime/index.ts',
      ...queryEntries,
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: true,
    target: 'node18',
  },
  {
    entry: { cli: 'src/runtime/cli.ts' },
    format: ['esm'],
    sourcemap: true,
    minify: true,
    target: 'node18',
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    entry: {
      'reindex-worker': 'src/reindex/worker.ts',
      'augment-vue-worker': 'src/reindex/augment-vue-worker.ts',
      postinstall: 'src/runtime/postinstall.ts',
    },
    format: ['esm'],
    sourcemap: true,
    minify: true,
    target: 'node18',
  },
]);
