import { createRequire } from 'node:module';
import { findNearestTsconfig } from './tsconfig-discovery.js';

const require = createRequire(import.meta.url);

export interface TypeScriptSemanticStatus {
  available: boolean;
  dependencyAvailable: boolean;
  tsconfigPath?: string;
  reason?: string;
}

export function getTypeScriptSemanticStatus(
  projectRoot: string,
  relativePath?: string,
): TypeScriptSemanticStatus {
  const dependencyAvailable = canResolveTsMorph();
  const tsconfigPath = findNearestTsconfig(projectRoot, relativePath) ?? undefined;

  if (!dependencyAvailable) {
    return {
      available: false,
      dependencyAvailable,
      tsconfigPath,
      reason: 'ts-morph is not installed',
    };
  }

  if (!tsconfigPath) {
    return {
      available: false,
      dependencyAvailable,
      reason: 'no tsconfig found',
    };
  }

  return {
    available: true,
    dependencyAvailable,
    tsconfigPath,
  };
}

function canResolveTsMorph(): boolean {
  try {
    require.resolve('ts-morph');
    return true;
  } catch {
    return false;
  }
}
