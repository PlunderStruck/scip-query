import { defineConfig } from 'tsup';
import { PUBLIC_QUERY_ENTRIES, PUBLIC_QUERY_SOURCE_PATHS } from './src/queries/public-query-entries.js';

const queryEntries = Object.fromEntries(
  PUBLIC_QUERY_ENTRIES.map((entry) => [`queries/${entry}`, PUBLIC_QUERY_SOURCE_PATHS[entry]]),
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
