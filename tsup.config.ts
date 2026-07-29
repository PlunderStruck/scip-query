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
    target: 'node22',
  },
  {
    entry: { cli: 'src/runtime/cli.ts' },
    format: ['esm'],
    sourcemap: true,
    minify: true,
    target: 'node22',
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    entry: {
      'reindex-worker': 'src/reindex/worker.ts',
      'augment-vue-worker': 'src/reindex/vue/augment-vue-worker.ts',
      'rust-semantic-worker': 'src/semantic/rust/lsp-batch-worker.ts',
      'rust-semantic-session-worker': 'src/semantic/rust/lsp-session-worker.ts',
      'rust-semantic-session-server': 'src/semantic/rust/durable-session-server.ts',
      'typescript-mailbox-worker': 'src/runtime/typescript-mailbox-worker.ts',
      'watch-server': 'src/runtime/watch-server.ts',
      postinstall: 'src/runtime/postinstall.ts',
    },
    format: ['esm'],
    sourcemap: true,
    minify: true,
    target: 'node22',
  },
]);
