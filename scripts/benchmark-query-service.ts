import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const projectRoot = resolve(process.argv[2] ?? process.cwd());
const benchmarkCommand = parseBenchmarkCommand(process.env.SCIP_QUERY_BENCH_COMMAND);
const operand = process.argv[3] ?? defaultOperand(benchmarkCommand);
const cliPath = resolve(projectRoot, 'dist/cli.js');
const configuredPoolSize = process.env.SCIP_QUERY_QUERY_SERVICE_POOL_SIZE;
const poolSize = configuredPoolSize === undefined ? 'default' : Number.parseInt(configuredPoolSize, 10);
const concurrencyLevels = parseConcurrencyLevels(process.env.SCIP_QUERY_BENCH_CONCURRENCY);
const serviceModes = process.env.SCIP_QUERY_BENCH_SERVICE_ONLY === '1' ? [true] : [false, true];
const scenarios = [];

for (const service of serviceModes) {
  for (const concurrency of concurrencyLevels) scenarios.push(await runScenario(service, concurrency));
}

const directIdentities = new Map(
  scenarios.filter((scenario) => !scenario.service).map((scenario) => [scenario.concurrency, scenario.identitySha256]),
);
for (const scenario of scenarios) {
  const directIdentity = directIdentities.get(scenario.concurrency);
  if (scenario.service && directIdentity !== undefined && scenario.identitySha256 !== directIdentity) {
    throw new Error(`Query service output differs at concurrency ${scenario.concurrency}.`);
  }
}

process.stdout.write(
  `${JSON.stringify({
    benchmark: 'persistent-query-service-cli',
    projectRoot,
    command: benchmarkCommand,
    operand,
    ...(benchmarkCommand === 'search' ? { pattern: operand } : {}),
    poolSize,
    scenarios,
  })}\n`,
);

async function runScenario(service: boolean, concurrency: number) {
  const clients = Array.from({ length: concurrency }, () => startClient(service));
  const clientPids = new Set(clients.map((client) => client.pid));
  const clientPeakRssKiB = new Map<number, number>();
  let alignedPeakRssKiB = 0;
  let serverPeakRssKiB = 0;
  let samples = 0;
  const startedAt = performance.now();
  const sample = (): void => {
    const snapshot = processSnapshot();
    let clientRssKiB = 0;
    let serverRssKiB = 0;
    for (const process of snapshot) {
      if (clientPids.has(process.pid)) {
        clientRssKiB += process.rssKiB;
        clientPeakRssKiB.set(process.pid, Math.max(clientPeakRssKiB.get(process.pid) ?? 0, process.rssKiB));
      }
      if (service && isQueryServiceProcess(process.command)) serverRssKiB += process.rssKiB;
    }
    alignedPeakRssKiB = Math.max(alignedPeakRssKiB, clientRssKiB + serverRssKiB);
    serverPeakRssKiB = Math.max(serverPeakRssKiB, serverRssKiB);
    samples += 1;
  };
  const sampler = setInterval(sample, 20);

  try {
    const runs = await Promise.all(clients.map((client) => client.result));
    sample();
    const wallMs = performance.now() - startedAt;
    const identities = new Set(runs.map((run) => sha256(run.stdout)));
    if (identities.size !== 1) throw new Error('Concurrent CLI results were not byte-identical.');
    return {
      service,
      concurrency,
      wallMs: round(wallMs),
      clientMs: summarize(runs.map((run) => run.elapsedMs)),
      alignedPeakRssBytes: alignedPeakRssKiB * 1024,
      serverPeakRssBytes: serverPeakRssKiB * 1024,
      clientPeakRssBytes: [...clientPeakRssKiB.values()].reduce((sum, rssKiB) => sum + rssKiB * 1024, 0),
      samples,
      identitySha256: [...identities][0],
    };
  } finally {
    clearInterval(sampler);
  }
}

function startClient(service: boolean): {
  pid: number;
  result: Promise<{ stdout: string; elapsedMs: number }>;
} {
  const startedAt = performance.now();
  const env = {
    ...process.env,
    SCIP_QUERY_QUERY_SERVICE_IDLE_MS: process.env.SCIP_QUERY_QUERY_SERVICE_IDLE_MS ?? '10000',
  };
  if (configuredPoolSize === undefined) delete env.SCIP_QUERY_QUERY_SERVICE_POOL_SIZE;
  else env.SCIP_QUERY_QUERY_SERVICE_POOL_SIZE = configuredPoolSize;
  if (service) delete env.SCIP_QUERY_QUERY_SERVICE;
  else env.SCIP_QUERY_QUERY_SERVICE = '0';
  const child = spawn(process.execPath, [cliPath, ...benchmarkArguments()], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid === undefined) throw new Error('CLI benchmark child did not receive a pid.');
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return {
    pid: child.pid,
    result: new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.on('error', reject);
      child.on('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolvePromise({ stdout, elapsedMs: performance.now() - startedAt });
        else reject(new Error(`CLI benchmark child exited ${code}: ${stderr.trim()}`));
      });
    }),
  };
}

function benchmarkArguments(): string[] {
  if (benchmarkCommand === 'search') {
    return ['search', operand, '--limit', '1', '--context', '0', '--json', '--result-only', '--compact'];
  }
  if (benchmarkCommand === 'outline') return ['outline', operand, '--json', '--result-only', '--compact'];
  if (benchmarkCommand === 'entrypoints') return ['entrypoints', operand, '--json', '--result-only', '--compact'];
  if (benchmarkCommand === 'files') return ['files', operand, '--json', '--result-only', '--compact'];
  if (benchmarkCommand === 'stats') return ['stats', '--json', '--result-only', '--compact'];
  if (benchmarkCommand === 'members') return ['members', operand, '--json', '--result-only', '--compact'];
  if (benchmarkCommand === 'methods') return ['methods', operand, '--json', '--result-only', '--compact'];
  if (benchmarkCommand === 'kind-counts') return ['kind-counts', '--json', '--result-only', '--compact'];
  if (
    benchmarkCommand === 'imported-by' ||
    benchmarkCommand === 'hierarchy' ||
    benchmarkCommand === 'by-kind' ||
    benchmarkCommand === 'refs' ||
    benchmarkCommand === 'trace' ||
    benchmarkCommand === 'call-graph' ||
    benchmarkCommand === 'slice' ||
    benchmarkCommand === 'reference-reachability' ||
    benchmarkCommand === 'reference-neighborhood' ||
    benchmarkCommand === 'dataflow' ||
    benchmarkCommand === 'value-flow' ||
    benchmarkCommand === 'imports' ||
    benchmarkCommand === 'unused-imports' ||
    benchmarkCommand === 'system' ||
    benchmarkCommand === 'surface'
  ) {
    return [benchmarkCommand, operand, '--json', '--result-only', '--compact'];
  }
  if (benchmarkCommand === 'deps' || benchmarkCommand === 'rdeps') {
    return [benchmarkCommand, operand, '--json', '--result-only', '--compact'];
  }
  return ['code', operand, '--json', '--result-only', '--compact', '--no-session'];
}

function processSnapshot(): Array<{ pid: number; rssKiB: number; command: string }> {
  const output = execFileSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8' });
  const processes = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    processes.push({ pid: Number(match[1]), rssKiB: Number(match[2]), command: match[3] });
  }
  return processes;
}

function isQueryServiceProcess(command: string): boolean {
  return (
    command.includes(`${resolve(projectRoot, 'dist/query-service-server.js')} `) && command.endsWith(` ${projectRoot}`)
  );
}

function summarize(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: round(sorted[0] ?? 0),
    median: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
    p95: round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0),
    max: round(sorted.at(-1) ?? 0),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function parseConcurrencyLevels(configured: string | undefined): number[] {
  const levels = (configured ?? '1,8,32').split(',').map((value) => Number.parseInt(value, 10));
  if (levels.length === 0 || levels.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 256)) {
    throw new Error('SCIP_QUERY_BENCH_CONCURRENCY must contain comma-separated integers between 1 and 256.');
  }
  return levels;
}

type BenchmarkCommand =
  | 'search'
  | 'outline'
  | 'code'
  | 'entrypoints'
  | 'files'
  | 'stats'
  | 'members'
  | 'methods'
  | 'deps'
  | 'rdeps'
  | 'imported-by'
  | 'hierarchy'
  | 'by-kind'
  | 'kind-counts'
  | 'refs'
  | 'trace'
  | 'call-graph'
  | 'slice'
  | 'reference-reachability'
  | 'reference-neighborhood'
  | 'dataflow'
  | 'value-flow'
  | 'imports'
  | 'unused-imports'
  | 'system'
  | 'surface';

function defaultOperand(command: BenchmarkCommand): string {
  if (command === 'outline') return 'src/runtime/cli.ts';
  if (command === 'files') return 'src/runtime';
  if (command === 'members' || command === 'methods') return 'ScipDatabase';
  if (command === 'deps' || command === 'rdeps') return 'src/runtime/query-service.ts';
  if (command === 'imports' || command === 'unused-imports') return 'src/runtime/query-service.ts';
  if (command === 'system' || command === 'surface') return 'src/runtime';
  if (command === 'by-kind') return 'function';
  if (command === 'kind-counts') return '';
  return 'queryServiceSessionIdentity';
}

function parseBenchmarkCommand(configured: string | undefined): BenchmarkCommand {
  if (configured === undefined || configured === 'search') return 'search';
  if (
    configured === 'outline' ||
    configured === 'code' ||
    configured === 'entrypoints' ||
    configured === 'files' ||
    configured === 'stats' ||
    configured === 'members' ||
    configured === 'methods' ||
    configured === 'deps' ||
    configured === 'rdeps' ||
    configured === 'imported-by' ||
    configured === 'hierarchy' ||
    configured === 'by-kind' ||
    configured === 'kind-counts' ||
    configured === 'refs' ||
    configured === 'trace' ||
    configured === 'call-graph' ||
    configured === 'reference-neighborhood' ||
    configured === 'reference-reachability' ||
    configured === 'slice' ||
    configured === 'dataflow' ||
    configured === 'value-flow' ||
    configured === 'imports' ||
    configured === 'unused-imports' ||
    configured === 'system' ||
    configured === 'surface'
  ) {
    return configured;
  }
  throw new Error(
    'SCIP_QUERY_BENCH_COMMAND must be search, outline, code, entrypoints, files, stats, members, methods, deps, rdeps, imported-by, hierarchy, by-kind, kind-counts, refs, trace, call-graph, reference-neighborhood, reference-reachability, slice, dataflow, value-flow, imports, unused-imports, system, or surface.',
  );
}
