import { createRequire } from 'node:module';
import { discoverTypeScriptTsconfigsForProject } from './tsconfig-discovery.js';

const require = createRequire(import.meta.url);

export type TypeScriptSemanticStatus =
  | {
      available: true;
      dependencyAvailable: boolean;
      tsconfigPath?: string;
      tsconfigPaths?: string[];
      reason?: never;
    }
  | {
      available: false;
      dependencyAvailable: boolean;
      tsconfigPath?: string;
      tsconfigPaths?: string[];
      reason: string;
    };

export function getTypeScriptSemanticStatus(
  projectRoot: string,
  configuredTsconfigs: readonly string[] = [],
): TypeScriptSemanticStatus {
  const dependencyAvailable = canResolveTsMorph();
  const tsconfigPaths = discoverTypeScriptTsconfigsForProject(projectRoot, configuredTsconfigs);
  const tsconfigPath = tsconfigPaths[0];

  if (!dependencyAvailable) {
    return {
      available: false,
      dependencyAvailable,
      tsconfigPath,
      tsconfigPaths,
      reason: 'ts-morph is not installed',
    };
  }

  if (tsconfigPaths.length === 0) {
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
    tsconfigPaths,
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
