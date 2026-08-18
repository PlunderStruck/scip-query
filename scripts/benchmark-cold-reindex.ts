import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { ProjectConfig } from '../src/domain/config-types.js';
import type { ReindexResult } from '../src/reindex/index.js';
import { detectLanguages } from '../src/reindex/detect.js';
import { reindex } from '../src/reindex/index.js';
import { loadProjectConfig } from '../src/runtime/config.js';
import { sampleProcessTreeMemory } from '../src/platform/process-tree.js';

interface BenchmarkOptions {
  projectRoot: string;
  iterations: number;
  maxHeapMb: number;
  profile: boolean;
  keepArtifacts: boolean;
  processTreeMemory: boolean;
  indexerConcurrency?: number;
  jsonlPath?: string;
}

interface ArtifactIdentity {
  bytes: number;
  sha256: string;
}

interface ReindexMeasurement {
  state: 'isolated-cold' | 'unchanged-warm';
  iteration: number;
  wallMs: number;
  reportedMs: number;
  coordinatorPeakRssMb: number;
  processTreePeakRssMb?: number;
  processTreeProcessCountAtPeak?: number;
  processTreeMemorySamples?: number;
  reused: boolean;
  languages: readonly string[];
  skipped: ReindexResult['skipped'];
  index: ArtifactIdentity;
  database: ArtifactIdentity;
  profilePath?: string;
  profileSpans?: readonly ProfileSpanSummary[];
  statusTail: readonly string[];
}

interface ProfileSpanSummary {
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
}

const options = parseOptions(process.argv.slice(2));
const config = loadProjectConfig(options.projectRoot);
const languages = config.languages ?? detectLanguages(options.projectRoot);

if (languages.length === 0) {
  throw new Error(`No supported languages detected under ${options.projectRoot}.`);
}

const startedAt = new Date().toISOString();
const measurements: ReindexMeasurement[] = [];

for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'scip-query-cold-reindex-'));
  const outputScip = join(cacheDir, 'index.scip');
  const outputDb = join(cacheDir, 'index.db');
  const profilePath = join(cacheDir, 'profile.jsonl');

  try {
    const coldMeasurement = await measureReindex({
      state: 'isolated-cold',
      iteration,
      outputScip,
      outputDb,
      profilePath,
      skipIfUnchanged: false,
      config,
    });
    const warmMeasurement = await measureReindex({
      state: 'unchanged-warm',
      iteration,
      outputScip,
      outputDb,
      profilePath,
      skipIfUnchanged: true,
      config,
    });
    if (
      coldMeasurement.index.sha256 !== warmMeasurement.index.sha256 ||
      coldMeasurement.database.sha256 !== warmMeasurement.database.sha256
    ) {
      throw new Error(`Unchanged warm iteration ${iteration} mutated the accepted cold artifacts.`);
    }
    measurements.push(coldMeasurement, warmMeasurement);
  } finally {
    if (!options.keepArtifacts) rmSync(cacheDir, { recursive: true, force: true });
  }
}

const cold = summarize(measurements.filter((measurement) => measurement.state === 'isolated-cold'));
const warm = summarize(measurements.filter((measurement) => measurement.state === 'unchanged-warm'));
const result = {
  schemaVersion: 2,
  startedAt,
  projectRoot: options.projectRoot,
  corpus: basename(options.projectRoot),
  languages,
  iterations: options.iterations,
  coldState:
    'fresh isolated output directory: no accepted SQLite generation, language shards, reindex metadata, or shared-generation attachment; operating-system and package caches are not cleared',
  warmState: 'immediate unchanged reindex against the isolated cold result',
  memoryScope: options.processTreeMemory
    ? 'coordinatorPeakRssMb samples this Node.js process; processTreePeakRssMb samples it plus all live descendants from a POSIX process-table snapshot every 100ms'
    : 'coordinatorPeakRssMb samples this Node.js process only; pass --process-tree-memory to include language indexer and SCIP converter children on POSIX',
  indexerConcurrency: options.indexerConcurrency ?? config.indexerConcurrency ?? 1,
  profileEnabled: options.profile,
  coldWarmArtifactIdentityPreserved: true,
  cold,
  warm,
  measurements,
};

if (options.jsonlPath) {
  const { appendFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(dirname(options.jsonlPath), { recursive: true });
  appendFileSync(options.jsonlPath, `${JSON.stringify(result)}\n`);
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function measureReindex(input: {
  state: ReindexMeasurement['state'];
  iteration: number;
  outputScip: string;
  outputDb: string;
  profilePath: string;
  skipIfUnchanged: boolean;
  config: ProjectConfig;
}): Promise<ReindexMeasurement> {
  const status: string[] = [];
  const previousProfile = process.env.SCIP_QUERY_PROFILE;
  const previousProfileOut = process.env.SCIP_QUERY_PROFILE_OUT;
  const previousCacheState = process.env.SCIP_QUERY_PROFILE_CACHE_STATE;
  if (options.profile) {
    process.env.SCIP_QUERY_PROFILE = '1';
    process.env.SCIP_QUERY_PROFILE_OUT = input.profilePath;
    process.env.SCIP_QUERY_PROFILE_CACHE_STATE = input.state;
  } else {
    delete process.env.SCIP_QUERY_PROFILE;
    delete process.env.SCIP_QUERY_PROFILE_OUT;
    delete process.env.SCIP_QUERY_PROFILE_CACHE_STATE;
  }

  let peakRss = process.memoryUsage().rss;
  let processTreePeakRss = 0;
  let processTreeProcessCountAtPeak = 0;
  let processTreeMemorySamples = 0;
  const sampleMemory = (): void => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (!options.processTreeMemory) return;
    const sample = sampleProcessTreeMemory();
    if (!sample) return;
    processTreeMemorySamples += 1;
    if (sample.rssBytes > processTreePeakRss) {
      processTreePeakRss = sample.rssBytes;
      processTreeProcessCountAtPeak = sample.processCount;
    }
  };
  sampleMemory();
  const memorySampler = setInterval(
    () => {
      sampleMemory();
    },
    options.processTreeMemory ? 100 : 10,
  );
  memorySampler.unref();
  const started = performance.now();

  try {
    const typeScript = input.config.indexer?.typescript;
    const result = await reindex({
      projectRoot: options.projectRoot,
      languages,
      outputScip: input.outputScip,
      outputDb: input.outputDb,
      maxHeapMb: options.maxHeapMb,
      pnpmWorkspaces: typeScript?.pnpmWorkspaces,
      typescriptProjectMode: typeScript?.projectMode,
      typescriptProjects: typeScript?.projects,
      clojureConfigPath: input.config.indexer?.clojure?.configPath,
      indexerConcurrency: options.indexerConcurrency ?? input.config.indexerConcurrency,
      skipAutoInstall: true,
      skipIfUnchanged: input.skipIfUnchanged,
      onStatus: (message) => status.push(message),
      trigger: 'manual',
    });
    const wallMs = performance.now() - started;
    clearInterval(memorySampler);
    sampleMemory();
    const [index, database] = await Promise.all([hashArtifact(input.outputScip), hashArtifact(input.outputDb)]);
    return {
      state: input.state,
      iteration: input.iteration,
      wallMs: rounded(wallMs),
      reportedMs: rounded(result.durationMs),
      coordinatorPeakRssMb: rounded(peakRss / (1024 * 1024)),
      ...(processTreeMemorySamples > 0
        ? {
            processTreePeakRssMb: rounded(processTreePeakRss / (1024 * 1024)),
            processTreeProcessCountAtPeak,
            processTreeMemorySamples,
          }
        : {}),
      reused: result.reused,
      languages: result.languages,
      skipped: result.skipped,
      index,
      database,
      ...(options.profile
        ? { profilePath: input.profilePath, profileSpans: summarizeProfile(input.profilePath, input.state) }
        : {}),
      statusTail: status.slice(-8),
    };
  } finally {
    clearInterval(memorySampler);
    restoreEnvironment('SCIP_QUERY_PROFILE', previousProfile);
    restoreEnvironment('SCIP_QUERY_PROFILE_OUT', previousProfileOut);
    restoreEnvironment('SCIP_QUERY_PROFILE_CACHE_STATE', previousCacheState);
  }
}

async function hashArtifact(path: string): Promise<ArtifactIdentity> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: statSync(path).size, sha256: hash.digest('hex') };
}

function summarize(values: readonly ReindexMeasurement[]): {
  wallMs: ReturnType<typeof summarizeNumbers>;
  reportedMs: ReturnType<typeof summarizeNumbers>;
  coordinatorPeakRssMb: ReturnType<typeof summarizeNumbers>;
  processTreePeakRssMb?: ReturnType<typeof summarizeNumbers>;
  indexByteIdentityStable: boolean;
  databaseByteIdentityStable: boolean;
} {
  const processTreeValues = values.flatMap((value) =>
    value.processTreePeakRssMb === undefined ? [] : [value.processTreePeakRssMb],
  );
  return {
    wallMs: summarizeNumbers(values.map((value) => value.wallMs)),
    reportedMs: summarizeNumbers(values.map((value) => value.reportedMs)),
    coordinatorPeakRssMb: summarizeNumbers(values.map((value) => value.coordinatorPeakRssMb)),
    ...(processTreeValues.length > 0 ? { processTreePeakRssMb: summarizeNumbers(processTreeValues) } : {}),
    indexByteIdentityStable: new Set(values.map((value) => value.index.sha256)).size <= 1,
    databaseByteIdentityStable: new Set(values.map((value) => value.database.sha256)).size <= 1,
  };
}

function summarizeProfile(path: string, cacheState: ReindexMeasurement['state']): ProfileSpanSummary[] {
  const grouped = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    const event = JSON.parse(line) as { type?: string; name?: string; durationMs?: number; cacheState?: string };
    if (event.type !== 'span' || !event.name || event.cacheState !== cacheState) continue;
    const durationMs = event.durationMs ?? 0;
    const current = grouped.get(event.name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs += durationMs;
    current.maxMs = Math.max(current.maxMs, durationMs);
    grouped.set(event.name, current);
  }
  return [...grouped]
    .map(([name, summary]) => ({ name, ...summary }))
    .sort((left, right) => right.totalMs - left.totalMs || left.name.localeCompare(right.name));
}

function summarizeNumbers(values: readonly number[]): { min: number; median: number; max: number } {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: rounded(sorted[0] ?? 0),
    median: rounded(sorted[Math.floor(sorted.length / 2)] ?? 0),
    max: rounded(sorted.at(-1) ?? 0),
  };
}

function parseOptions(args: readonly string[]): BenchmarkOptions {
  let projectRoot = process.cwd();
  let iterations = 3;
  let maxHeapMb = 4096;
  let profile = false;
  let keepArtifacts = false;
  let processTreeMemory = false;
  let indexerConcurrency: number | undefined;
  let jsonlPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--profile') profile = true;
    else if (argument === '--keep-artifacts') keepArtifacts = true;
    else if (argument === '--process-tree-memory') processTreeMemory = true;
    else if (argument === '--project') projectRoot = requiredValue(args, ++index, argument);
    else if (argument === '--iterations')
      iterations = positiveInteger(requiredValue(args, ++index, argument), argument);
    else if (argument === '--max-heap-mb')
      maxHeapMb = positiveInteger(requiredValue(args, ++index, argument), argument);
    else if (argument === '--indexer-concurrency')
      indexerConcurrency = positiveInteger(requiredValue(args, ++index, argument), argument);
    else if (argument === '--jsonl') jsonlPath = resolve(requiredValue(args, ++index, argument));
    else throw new Error(`Unknown benchmark argument: ${argument}`);
  }

  if (profile && !keepArtifacts) {
    throw new Error('--profile requires --keep-artifacts so the reported JSONL paths remain readable.');
  }
  return {
    projectRoot: resolve(projectRoot),
    iterations,
    maxHeapMb,
    profile,
    keepArtifacts,
    processTreeMemory,
    indexerConcurrency,
    jsonlPath,
  };
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}
