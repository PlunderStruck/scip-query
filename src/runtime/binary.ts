import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

const IS_WINDOWS = platform() === 'win32';

export function isBinaryAvailable(name: string): boolean {
  const cmd = IS_WINDOWS ? 'where' : 'which';
  try {
    execFileSync(cmd, [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
