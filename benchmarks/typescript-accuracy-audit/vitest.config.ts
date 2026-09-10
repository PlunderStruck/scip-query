import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['benchmarks/typescript-accuracy-audit/*.audit.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
