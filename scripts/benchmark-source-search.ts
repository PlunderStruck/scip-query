import { summarizeTimings as summarize } from './benchmark-statistics.js';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';

import { resolveIndexStoragePaths } from '../src/platform/cache-layout.js';
import { searchSource } from '../src/queries/navigation/source-search.js';
import { loadProjectConfig } from '../src/runtime/config.js';
import { ScipDatabase } from '../src/storage/db.js';

const projectRoot = resolve(process.argv[2] ?? process.cwd());
const pattern = process.argv[3] ?? 'producedOutputBytes';
const iterations = 5;
const paths = resolveIndexStoragePaths(projectRoot, loadProjectConfig(projectRoot));
const db = new ScipDatabase({ projectRoot, dbPath: paths.dbPath, indexPath: paths.indexPath });

try {
  const warmup = searchSource(db, pattern);
  const expectedIdentity = resultIdentity(warmup);
  const durations: number[] = [];
  let maxObservedRssBytes = process.memoryUsage().rss;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    const result = searchSource(db, pattern);
    durations.push(performance.now() - startedAt);
    maxObservedRssBytes = Math.max(maxObservedRssBytes, process.memoryUsage().rss);
    if (resultIdentity(result) !== expectedIdentity) {
      throw new Error('Source-search output identity changed between benchmark repetitions.');
    }
  }

  const timing = summarize(durations);
  process.stdout.write(
    `${JSON.stringify({
      benchmark: 'source-search',
      projectRoot,
      pattern,
      cacheState: 'warm-in-process',
      timingMs: timing,
      maxObservedRssBytes,
      output: {
        matchingLines: warmup.matchingLines,
        matchingFiles: warmup.matchingFiles,
        scannedFiles: warmup.scannedFiles,
        scannedBytes: warmup.textCoverage?.scannedBytes,
        identitySha256: expectedIdentity,
      },
    })}\n`,
  );
} finally {
  db.close();
}

function resultIdentity(result: ReturnType<typeof searchSource>): string {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}
