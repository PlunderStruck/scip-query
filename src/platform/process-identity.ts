import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform as hostPlatform } from 'node:os';

/**
 * One operating-system process instance. A PID alone names a reusable slot;
 * the start token distinguishes successive processes that occupy that slot.
 */
export interface ProcessIdentity {
  version: 1;
  pid: number;
  platform: NodeJS.Platform;
  startToken: string;
}

export interface ProcessIdentityRuntime {
  platform: NodeJS.Platform;
  readFile(path: string): string;
  run(binary: string, args: readonly string[]): string;
}

const PROCESS_IDENTITY_COMMAND_TIMEOUT_MS = 1_000;
const PROCESS_IDENTITY_MAX_OUTPUT_BYTES = 16 * 1024;
const NODE_PLATFORMS = new Set<NodeJS.Platform>([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd',
]);

export function readProcessIdentity(
  pid: number,
  runtime: ProcessIdentityRuntime = DEFAULT_PROCESS_IDENTITY_RUNTIME,
): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const startToken = processStartToken(pid, runtime);
    return startToken ? { version: 1, pid, platform: runtime.platform, startToken } : null;
  } catch {
    return null;
  }
}

export function parseProcessIdentity(value: unknown): ProcessIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = value as Partial<ProcessIdentity>;
  if (
    identity.version !== 1 ||
    typeof identity.pid !== 'number' ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    typeof identity.platform !== 'string' ||
    !NODE_PLATFORMS.has(identity.platform as NodeJS.Platform) ||
    typeof identity.startToken !== 'string' ||
    identity.startToken.trim() === ''
  ) {
    return null;
  }
  return {
    version: 1,
    pid: identity.pid,
    platform: identity.platform as NodeJS.Platform,
    startToken: identity.startToken,
  };
}

export function sameProcessIdentity(expected: ProcessIdentity, actual: ProcessIdentity): boolean {
  return (
    expected.version === actual.version &&
    expected.pid === actual.pid &&
    expected.platform === actual.platform &&
    expected.startToken === actual.startToken
  );
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
    return readFileSync(path, 'utf8');
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
