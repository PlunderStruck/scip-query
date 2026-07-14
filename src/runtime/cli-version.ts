import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The installed scip-query package version that produced persistent artifacts. */
export const cliVersion = loadCliPackageInfo().version;

function loadCliPackageInfo(): { version: string } {
  for (const path of ['../package.json', '../../package.json']) {
    try {
      return require(path) as { version: string };
    } catch {
      // Source runs from src/runtime; bundled entrypoints run from dist.
    }
  }
  return { version: '0.0.0' };
}
