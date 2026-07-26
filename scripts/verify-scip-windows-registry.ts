import { createWindowsSidecarReleaseRuntime, runWindowsSidecarRelease } from './scip-windows-release.js';

const runtime = createWindowsSidecarReleaseRuntime();
runtime.env = {
  ...runtime.env,
  npm_lifecycle_event: 'prepublishOnly',
};

try {
  runWindowsSidecarRelease(runtime, { registryMode: 'verify-only' });
} catch (error) {
  console.error(
    `Windows sidecar registry identity check FAILED:\n  - ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
