/**
 * Legacy local-package verification entry point.
 *
 * Despite the historical filename and package-script alias, this entry point
 * has no registry capability. npm-release.ts is the only publishing CLI.
 */
import { createWindowsSidecarReleaseRuntime, runWindowsSidecarRelease } from './scip-windows-release.js';

try {
  runWindowsSidecarRelease(createWindowsSidecarReleaseRuntime());
} catch (error) {
  console.error(
    `Windows sidecar release check FAILED:\n  - ${error instanceof Error ? error.message : String(error)}\n` +
      `  - Run npm run build:scip-windows, review and commit provenance.json, then retry.`,
  );
  process.exitCode = 1;
}
