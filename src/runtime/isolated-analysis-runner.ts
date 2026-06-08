import { spawnSync } from 'node:child_process';

interface IsolatedJsonProcessOptions {
  cliPath: string;
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  label: string;
  maxBuffer?: number;
}

// scip-query: ignore-wrapper — subprocess JSON handoff boundary shared by
// health phases and diff-impact batches.
export function runIsolatedJsonProcess<T>(opts: IsolatedJsonProcessOptions): T {
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, opts.cliPath, opts.command, ...(opts.args ?? [])],
    {
      cwd: process.cwd(),
      env: opts.env ?? process.env,
      encoding: 'utf8',
      maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
    },
  );
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
