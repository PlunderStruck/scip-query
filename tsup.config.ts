import { readdirSync } from 'node:fs';
import { defineConfig } from 'tsup';

const queryEntries = Object.fromEntries(
  readdirSync('src/queries', { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => [
      `queries/${entry.name.replace(/\.ts$/, '')}`,
      `src/queries/${entry.name}`,
    ]),
);

// Minify JS to keep the published tarball compact. Sourcemaps are generated
// for local debugging but excluded from the tarball via package.json `files`.
export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
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
