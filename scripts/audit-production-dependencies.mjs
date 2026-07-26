import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function npmAuditEnvironment(source) {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'npm_config_allow_scripts') {
      delete environment[key];
    }
  }
  return environment;
}

export function runProductionDependencyAudit({
  environment = process.env,
  platform = process.platform,
  spawn = spawnSync,
} = {}) {
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawn(npm, ['audit', '--omit=dev', '--audit-level=high'], {
    env: npmAuditEnvironment(environment),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`npm audit terminated by ${result.signal}`);
  }
  return result.status ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runProductionDependencyAudit();
}
