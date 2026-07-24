import { execFileSync } from 'node:child_process';
import { rustScipOccurrenceReferenceMode } from './scip-occurrence-references.js';
import { getRustSemanticStatus } from './status.js';

const VERSION_CACHE = new Map<string, string>();

// scip-query: ignore-stale — reviewed S1 owned contract; this identity binds cached evidence to one compiler engine.
export interface RustCompilerEngineIdentity {
  engine: 'rust-analyzer';
  resolvedBinary: string | null;
  version: string;
}

export interface RustSemanticEngineIdentity extends RustCompilerEngineIdentity {
  scipOccurrenceReferenceMode: string;
}

export function rustCompilerEngineIdentity(projectRoot: string): RustCompilerEngineIdentity {
  const status = getRustSemanticStatus(projectRoot);
  const resolvedBinary = status.resolvedBinary ?? null;
  return {
    engine: 'rust-analyzer',
    resolvedBinary,
    version: resolvedBinary ? rustAnalyzerVersion(projectRoot, resolvedBinary) : 'unavailable',
  };
}

export function rustSemanticEngineIdentity(projectRoot: string): RustSemanticEngineIdentity {
  return {
    ...rustCompilerEngineIdentity(projectRoot),
    scipOccurrenceReferenceMode: rustScipOccurrenceReferenceMode(),
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
