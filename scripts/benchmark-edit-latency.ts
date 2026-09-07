import { summarizeTimings as summarize } from './benchmark-statistics.js';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';

import { classifyProjectInputPath } from '../src/domain/project-input.js';
import {
  buildProjectInputFingerprint,
  buildProjectInputFingerprintFromJournal,
} from '../src/platform/project-files.js';
import { detectLanguages } from '../src/reindex/detect.js';
import { loadProjectConfig } from '../src/runtime/config.js';

const projectRoot = resolve(process.argv[2] ?? process.cwd());
const config = loadProjectConfig(projectRoot);
const languages = config.languages ?? detectLanguages(projectRoot);
const typeScript = config.indexer?.typescript;
const options = {
  pnpmWorkspaces: typeScript?.pnpmWorkspaces,
  typescriptProjectMode: typeScript?.projectMode,
  typescriptProjects: typeScript?.projects,
  clojureConfigPath: config.indexer?.clojure?.configPath,
};
const configuredMarkers = [
  ...(typeScript?.projects ?? []),
  ...(options.clojureConfigPath ? [options.clojureConfigPath] : []),
];
const previous = buildProjectInputFingerprint(projectRoot, languages, options);
const sourceFiles = previous.files.filter(
  (file) => classifyProjectInputPath(file.path, languages, configuredMarkers) === 'source',
);
const changedPath =
  sourceFiles.find((file) => /(?:^|\/)src\/.*\.(?:ts|tsx|mts|cts)$/.test(file.path))?.path ?? sourceFiles[0]?.path;
if (!changedPath) throw new Error('The benchmark needs at least one indexed source file.');

const deltaJournal = {
  version: 1 as const,
  baseGeneration: 'benchmark-generation',
  complete: true,
  entries: [{ path: changedPath, kind: 'change' as const }],
};

// Warm both filesystem/stat caches before measuring steady-state edit latency.
buildProjectInputFingerprint(projectRoot, languages, options);
buildProjectInputFingerprintFromJournal(
  projectRoot,
  languages,
  options,
  previous,
  deltaJournal,
  'benchmark-generation',
);

const fullDurations = measure(5, () => buildProjectInputFingerprint(projectRoot, languages, options));
const deltaDurations = measure(25, () => {
  const result = buildProjectInputFingerprintFromJournal(
    projectRoot,
    languages,
    options,
    previous,
    deltaJournal,
    'benchmark-generation',
  );
  if (result.mode !== 'delta') throw new Error(`Delta benchmark fell back to a full scan: ${result.reason}`);
  if (JSON.stringify(result.fingerprint) !== JSON.stringify(previous)) {
    throw new Error('Delta fingerprint differs from a clean full fingerprint.');
  }
});

const full = summarize(fullDurations);
const delta = summarize(deltaDurations);
process.stdout.write(
  `${JSON.stringify(
    {
      projectRoot,
      languages,
      acceptedInputEntries: previous.files.length,
      changedPath,
      work: {
        fullAcceptedEntriesVisited: previous.files.length,
        deltaPathsRevalidated: 1,
        acceptedFingerprintsReused: Math.max(0, previous.files.length - 1),
      },
      fullMs: full,
      deltaMs: delta,
      medianSpeedup: Number((full.median / Math.max(delta.median, 0.001)).toFixed(1)),
    },
    null,
    2,
  )}\n`,
);

function measure(iterations: number, action: () => unknown): number[] {
  const durations: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    action();
    durations.push(performance.now() - startedAt);
  }
  return durations;
}
