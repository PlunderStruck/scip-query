import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node18',
  },
  {
    entry: { cli: 'src/cli.ts', 'reindex-worker': 'src/reindex-worker.ts' },
    format: ['esm'],
    sourcemap: true,
    target: 'node18',
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);
