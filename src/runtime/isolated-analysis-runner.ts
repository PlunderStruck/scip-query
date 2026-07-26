import { spawnSync } from 'node:child_process';
import { BoundedProcessError, PROCESS_TIMEOUT_MS, runBoundedProcess } from '../platform/bounded-process.js';
import { cliVersion } from '../platform/cli-version.js';
import { isRecordObject } from '../domain/record-validation.js';
import { writeSerializedJson } from '../platform/terminal-output.js';

export const ISOLATED_ANALYSIS_PROTOCOL = 'scip-query-isolated-analysis' as const;
export const ISOLATED_ANALYSIS_SCHEMA_VERSION = 1 as const;

interface IsolatedAnalysisEnvelope<T> {
  protocol: typeof ISOLATED_ANALYSIS_PROTOCOL;
  schemaVersion: typeof ISOLATED_ANALYSIS_SCHEMA_VERSION;
  producer: { name: 'scip-query'; version: string };
  command: string;
  result: T;
}

interface IsolatedJsonProcessOptions {
  cliPath: string;
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  label: string;
  maxBuffer?: number;
  timeoutMs?: number;
}

function isolatedJsonArgs(args: readonly string[] | undefined): string[] {
  const values = [...(args ?? [])];
  return values.includes('--json') ? values : ['--json', ...values];
}

export class IsolatedProcessTimeoutError extends Error {
  readonly timedOut = true;

  constructor(
    readonly label: string,
    readonly timeoutMs: number,
    readonly reaped = true,
  ) {
    super(`${label} timed out after ${timeoutMs}ms.`);
    this.name = 'IsolatedProcessTimeoutError';
  }
}

export function printIsolatedAnalysisResult(command: string, result: unknown): void {
  const envelope: IsolatedAnalysisEnvelope<unknown> = {
    protocol: ISOLATED_ANALYSIS_PROTOCOL,
    schemaVersion: ISOLATED_ANALYSIS_SCHEMA_VERSION,
    producer: { name: 'scip-query', version: cliVersion },
    command,
    result,
  };
  writeSerializedJson(JSON.stringify(envelope));
}

// scip-query: ignore-wrapper — subprocess JSON handoff boundary shared by
// health phases and diff-impact batches.
export function runIsolatedJsonProcess<T>(opts: IsolatedJsonProcessOptions): T {
  const timeoutMs = opts.timeoutMs ?? PROCESS_TIMEOUT_MS.analysis;
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, opts.cliPath, opts.command, ...isolatedJsonArgs(opts.args)],
    {
      cwd: process.cwd(),
      env: opts.env ?? process.env,
      encoding: 'utf8',
      maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    },
  );
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    throw new IsolatedProcessTimeoutError(opts.label, timeoutMs);
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`${opts.label} failed${stderr ? `:\n${stderr}` : ''}`);
  }
  return parseIsolatedAnalysisResult<T>(result.stdout, opts);
}

// scip-query: ignore-wrapper — batch helper owned by the isolated analysis
// runner so callers do not duplicate subprocess batch slicing.
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push(items.slice(offset, offset + size));
  }
  return chunks;
}

export function runIsolatedJsonProcessAsync<T>(opts: IsolatedJsonProcessOptions): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? PROCESS_TIMEOUT_MS.analysis;
  const maxBuffer = opts.maxBuffer ?? 10 * 1024 * 1024;
  return runBoundedProcess({
    command: process.execPath,
    args: [...process.execArgv, opts.cliPath, opts.command, ...isolatedJsonArgs(opts.args)],
    cwd: process.cwd(),
    env: opts.env ?? process.env,
    label: opts.label,
    timeoutMs,
    maxStdoutBytes: maxBuffer,
    maxStderrBytes: maxBuffer,
  })
    .catch((error: unknown) => {
      if (error instanceof BoundedProcessError && error.kind === 'timeout') {
        throw new IsolatedProcessTimeoutError(opts.label, timeoutMs, error.reaped);
      }
      throw error;
    })
    .then((result): T => {
      const stderrText = result.stderr.trim();
      if (result.status !== 0) {
        throw new Error(`${opts.label} failed${stderrText ? `:\n${stderrText}` : ''}`);
      }
      return parseIsolatedAnalysisResult<T>(result.stdout, opts);
    });
}

function parseIsolatedAnalysisResult<T>(stdout: string, opts: IsolatedJsonProcessOptions): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${opts.label} returned invalid JSON: ${error instanceof Error ? error.message : error}`, {
      cause: error,
    });
  }
  if (!isRecordObject(parsed)) {
    throw new Error(`${opts.label} returned a non-object isolated-analysis message.`);
  }
  if (parsed['protocol'] !== ISOLATED_ANALYSIS_PROTOCOL) {
    throw new Error(
      `${opts.label} returned protocol ${describeValue(parsed['protocol'])}; expected ${ISOLATED_ANALYSIS_PROTOCOL}.`,
    );
  }
  if (parsed['schemaVersion'] !== ISOLATED_ANALYSIS_SCHEMA_VERSION) {
    throw new Error(
      `${opts.label} returned unsupported isolated-analysis schemaVersion ${describeValue(parsed['schemaVersion'])}; expected ${ISOLATED_ANALYSIS_SCHEMA_VERSION}.`,
    );
  }
  if (!isScipQueryProducer(parsed['producer'])) {
    throw new Error(`${opts.label} did not identify a scip-query producer version.`);
  }
  if (parsed['command'] !== opts.command) {
    throw new Error(
      `${opts.label} returned result for command ${describeValue(parsed['command'])}; expected ${opts.command}.`,
    );
  }
  if (!Object.hasOwn(parsed, 'result')) {
    throw new Error(`${opts.label} omitted the isolated-analysis result.`);
  }
  return parsed['result'] as T;
}

function isScipQueryProducer(value: unknown): boolean {
  return (
    isRecordObject(value) &&
    value['name'] === 'scip-query' &&
    typeof value['version'] === 'string' &&
    value['version'].length > 0
  );
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

export async function runAnalysisTasks<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await run(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export function groupAnalysisTasks<T>(items: readonly T[], groupedSets: readonly ReadonlySet<T>[]): T[][] {
  const handled = new Set<T>();
  const tasks: T[][] = [];

  for (const item of items) {
    if (handled.has(item)) continue;
    const group = groupedSets.find((set) => set.has(item));
    if (!group) {
      handled.add(item);
      tasks.push([item]);
      continue;
    }

    const groupedItems = items.filter((candidate) => group.has(candidate));
    groupedItems.forEach((candidate) => handled.add(candidate));
    tasks.push(groupedItems);
  }

  return tasks;
}
