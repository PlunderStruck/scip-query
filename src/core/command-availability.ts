import { spawnSync } from 'node:child_process';

export type CommandAvailabilitySpawn = typeof spawnSync;

export function binaryAvailable(binary: string, spawn: CommandAvailabilitySpawn = spawnSync): boolean {
  try {
    return spawn(binary, ['--version'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}
