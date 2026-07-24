import { execFileSync, spawnSync } from 'node:child_process';
import { platform } from 'node:os';

const IS_WINDOWS = platform() === 'win32';

export type CommandAvailabilitySpawn = typeof spawnSync;

/**
 * Prove that a binary can start and report its version, rather than only
 * proving that a matching path exists.
 */
export function binaryAvailable(binary: string, spawn: CommandAvailabilitySpawn = spawnSync): boolean {
  try {
    return spawn(binary, ['--version'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

export function isBinaryAvailable(name: string): boolean {
  const cmd = IS_WINDOWS ? 'where' : 'which';
  try {
    execFileSync(cmd, [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export interface PortableCommand {
  binary: string;
  args: string[];
}

const SCRIPT_BIN_PATTERN = /\.(?:c|m)?js$/i;
const WINDOWS_NATIVE_EXECUTABLE = /\.(?:exe|com)$/i;

/**
 * Rewrite a resolved command so `execFile` can spawn it without a shell on
 * every platform. A .js/.cjs/.mjs target (an npm package `bin` file) runs
 * through the current Node executable: Windows cannot execute script files
 * directly (`spawn EFTYPE`), and POSIX execution would otherwise depend on a
 * shebang plus an exec bit that path-resolved package bins do not guarantee.
 */
export function toPortableCommand(binary: string, args: readonly string[]): PortableCommand {
  if (SCRIPT_BIN_PATTERN.test(binary)) {
    return { binary: process.execPath, args: [binary, ...args] };
  }
  return { binary, args: [...args] };
}

export interface ResolveSpawnableOptions {
  lookup?: (cmd: string, args: string[]) => string;
  isWindows?: boolean;
}

function defaultLookup(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
}

/**
 * Resolve a command name to a path `execFile` can spawn without a shell.
 * On POSIX every `which` hit qualifies. On Windows only real executables
 * (.exe/.com) qualify: `where` also reports npm's `.cmd` and extensionless
 * shim scripts, which a shell-less spawn rejects with EFTYPE/EINVAL — when
 * this returns null, callers should fall back to a script-file strategy that
 * `toPortableCommand` can rewrite (for npm indexers, the bundled package bin).
 */
export function resolveSpawnableExecutable(name: string, options: ResolveSpawnableOptions = {}): string | null {
  const isWindows = options.isWindows ?? IS_WINDOWS;
  const lookup = options.lookup ?? defaultLookup;
  let output: string;
  try {
    output = lookup(isWindows ? 'where' : 'which', [name]);
  } catch {
    return null;
  }
  const matches = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!isWindows) return matches[0] ?? null;
  return matches.find((match) => WINDOWS_NATIVE_EXECUTABLE.test(match)) ?? null;
}
