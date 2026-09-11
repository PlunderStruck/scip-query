import { maybeSweepRepositoryCache } from './repository-cache-lifecycle.js';

// This finite worker keeps synchronous filesystem cleanup and its process-owned
// cache locks off the watcher's event loop. The parent owns its deadline and exit.
const [projectRoot, cliVersion] = process.argv.slice(2);
if (!projectRoot || !cliVersion) {
  console.error('repository-cache-worker: expected <project-root> <cli-version>');
  process.exitCode = 1;
} else {
  try {
    maybeSweepRepositoryCache(projectRoot, cliVersion);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
