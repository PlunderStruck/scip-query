import { summarizeTimings as summarize, rounded } from './benchmark-statistics.js';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';

import { resolveIndexStoragePaths } from '../src/platform/cache-layout.js';
import { graphEvidence } from '../src/queries/graph/graph-evidence.js';
import { loadProjectConfig } from '../src/runtime/config.js';
import { ScipDatabase } from '../src/storage/db.js';

const projectRoot = resolve(process.argv[2] ?? process.cwd());
const pattern = process.argv[3] ?? 'producedOutputBytes';
const iterations = 15;
const paths = resolveIndexStoragePaths(projectRoot, loadProjectConfig(projectRoot));
const db = new ScipDatabase({ projectRoot, dbPath: paths.dbPath, indexPath: paths.indexPath });
const options = {
  families: ['execution'] as const,
  direction: 'outgoing' as const,
  maxDepth: 1,
  maxEdges: 40,
};

try {
  const initialStartedAt = performance.now();
  const warmup = graphEvidence(db, { searches: [pattern] }, options);
  const initialMs = rounded(performance.now() - initialStartedAt);
  const expectedIdentity = resultIdentity(warmup);
  const durations: number[] = [];
  let maxObservedRssBytes = process.memoryUsage().rss;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    const result = graphEvidence(db, { searches: [pattern] }, options);
    durations.push(performance.now() - startedAt);
    maxObservedRssBytes = Math.max(maxObservedRssBytes, process.memoryUsage().rss);
    if (resultIdentity(result) !== expectedIdentity) {
      throw new Error('Graph-literal output identity changed between benchmark repetitions.');
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      benchmark: 'graph-literal',
      projectRoot,
      pattern,
      cacheState: 'warm-in-process',
      initialMs,
      timingMs: summarize(durations),
      maxObservedRssBytes,
      output: {
        targets: warmup.targets.length,
        edges: warmup.edges.length,
        coverageStatus: warmup.coverage.status,
        identitySha256: expectedIdentity,
      },
    })}\n`,
  );
} finally {
  db.close();
}

function resultIdentity(result: ReturnType<typeof graphEvidence>): string {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}
