import { execFileSync } from 'node:child_process';
import { platform as hostPlatform } from 'node:os';
import type { ProcessIdentity } from '../domain/process-identity.js';
import { readTextStreamPathWithinLimit } from './bounded-file.js';

export { parseProcessIdentity, sameProcessIdentity, type ProcessIdentity } from '../domain/process-identity.js';

export interface ProcessIdentityRuntime {
  platform: NodeJS.Platform;
  readFile(path: string): string;
  run(binary: string, args: readonly string[]): string;
}

const PROCESS_IDENTITY_COMMAND_TIMEOUT_MS = 1_000;
const PROCESS_IDENTITY_MAX_OUTPUT_BYTES = 16 * 1024;
let cachedCurrentProcessIdentity: ProcessIdentity | undefined;
export function readProcessIdentity(
  pid: number,
  runtime: ProcessIdentityRuntime = DEFAULT_PROCESS_IDENTITY_RUNTIME,
): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const isCurrentHostProcess = pid === process.pid && runtime === DEFAULT_PROCESS_IDENTITY_RUNTIME;
  if (isCurrentHostProcess && cachedCurrentProcessIdentity) return { ...cachedCurrentProcessIdentity };
  try {
    const startToken = processStartToken(pid, runtime);
    if (!startToken) return null;
    const identity: ProcessIdentity = { version: 1, pid, platform: runtime.platform, startToken };
    // A process's start token cannot change during that process's lifetime. Cache only our own
    // successful host lookup: other PIDs may be reused, and injected runtimes may model change.
    if (isCurrentHostProcess) cachedCurrentProcessIdentity = identity;
    return { ...identity };
  } catch {
    return null;
  }
}

function processStartToken(pid: number, runtime: ProcessIdentityRuntime): string | null {
  if (runtime.platform === 'linux' || runtime.platform === 'android') {
    return linuxProcessStartToken(runtime.readFile(`/proc/${pid}/stat`));
  }
  if (runtime.platform === 'win32') {
    const script = `([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`;
    return nonEmptyToken(runtime.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
  }
  if (
    runtime.platform === 'darwin' ||
    runtime.platform === 'freebsd' ||
    runtime.platform === 'openbsd' ||
    runtime.platform === 'netbsd'
  ) {
    return nonEmptyToken(runtime.run('ps', ['-p', String(pid), '-o', 'lstart=']));
  }
  return null;
}

function linuxProcessStartToken(stat: string): string | null {
  // The command name is parenthesized and may itself contain spaces or `)`.
  // Fields after the final `)` begin at proc(5)'s field 3 (`state`);
  // `starttime` is field 22, therefore offset 19 in this tail.
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) return null;
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const startToken = fields[19];
  return startToken && /^\d+$/.test(startToken) ? startToken : null;
}

function nonEmptyToken(value: string): string | null {
  const token = value.trim();
  return token === '' ? null : token;
}

const DEFAULT_PROCESS_IDENTITY_RUNTIME: ProcessIdentityRuntime = {
  platform: hostPlatform(),
  readFile(path) {
    return readTextStreamPathWithinLimit(path, {
      maxBytes: PROCESS_IDENTITY_MAX_OUTPUT_BYTES,
      inputKind: 'process identity pseudo-file',
    });
  },
  run(binary, args) {
    return execFileSync(binary, [...args], {
      encoding: 'utf8',
      timeout: PROCESS_IDENTITY_COMMAND_TIMEOUT_MS,
      maxBuffer: PROCESS_IDENTITY_MAX_OUTPUT_BYTES,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  },
};
