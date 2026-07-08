import { execFileSync } from 'node:child_process';
import { getRustSemanticStatus } from './status.js';

const VERSION_CACHE = new Map<string, string>();

export interface RustSemanticEngineIdentity {
  engine: 'rust-analyzer';
  resolvedBinary: string | null;
  version: string;
}

export function rustSemanticEngineIdentity(projectRoot: string): RustSemanticEngineIdentity {
  const status = getRustSemanticStatus(projectRoot);
  const resolvedBinary = status.resolvedBinary ?? null;
  return {
    engine: 'rust-analyzer',
    resolvedBinary,
    version: resolvedBinary ? rustAnalyzerVersion(projectRoot, resolvedBinary) : 'unavailable',
  };
}

function rustAnalyzerVersion(projectRoot: string, resolvedBinary: string): string {
  const cacheKey = `${projectRoot}\0${resolvedBinary}`;
  const cached = VERSION_CACHE.get(cacheKey);
  if (cached) return cached;

  let version: string;
  try {
    version = execFileSync(resolvedBinary, ['--version'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
  } catch {
    version = 'unknown';
  }
  VERSION_CACHE.set(cacheKey, version);
  return version;
}
