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
