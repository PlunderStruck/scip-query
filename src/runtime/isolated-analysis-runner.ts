import { spawn, spawnSync } from 'node:child_process';

interface IsolatedJsonProcessOptions {
  cliPath: string;
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  label: string;
  maxBuffer?: number;
  timeoutMs?: number;
}

export class IsolatedProcessTimeoutError extends Error {
  readonly timedOut = true;

  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} timed out after ${timeoutMs}ms.`);
  }
}

// scip-query: ignore-wrapper — subprocess JSON handoff boundary shared by
// health phases and diff-impact batches.
export function runIsolatedJsonProcess<T>(opts: IsolatedJsonProcessOptions): T {
  const result = spawnSync(process.execPath, [...process.execArgv, opts.cliPath, opts.command, ...(opts.args ?? [])], {
    cwd: process.cwd(),
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`${opts.label} failed${stderr ? `:\n${stderr}` : ''}`);
  }
  return JSON.parse(result.stdout) as T;
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
  return new Promise((resolve, reject) => {
    const maxBuffer = opts.maxBuffer ?? 10 * 1024 * 1024;
    const child = spawn(process.execPath, [...process.execArgv, opts.cliPath, opts.command, ...(opts.args ?? [])], {
      cwd: process.cwd(),
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timeout =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => fail(new IsolatedProcessTimeoutError(opts.label, opts.timeoutMs!)), opts.timeoutMs)
        : null;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      child.kill();
      reject(error);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        fail(new Error(`${opts.label} exceeded stdout buffer limit (${maxBuffer} bytes).`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        fail(new Error(`${opts.label} exceeded stderr buffer limit (${maxBuffer} bytes).`));
        return;
      }
      stderr.push(chunk);
    });
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(`${opts.label} failed${stderrText ? `:\n${stderrText}` : ''}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')) as T);
      } catch (error) {
        reject(new Error(`${opts.label} returned invalid JSON: ${error instanceof Error ? error.message : error}`));
      }
    });
  });
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
