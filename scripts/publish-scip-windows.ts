/**
 * Main-package prepublish hook for the ordered Windows sidecar workflow.
 *
 * This entry point verifies the optional-dependency pin and complete local
 * binary provenance before making any registry decision. Registry identity
 * is proven here; REL-03 adds the cross-package preflight and recovery record.
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
