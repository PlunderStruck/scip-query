import { program } from 'commander';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cliVersion, renderHeuristicNotice } from './cli-support.js';
import { commandDescriptors } from './commands/command-descriptors.js';
import { registerCommandDescriptors } from './commands/command-registry.js';
import { loadProjectConfig, resolveIndexStoragePaths } from './config.js';
import { prepareWorktreeIndex, resolveProjectRoot, sharedCachePreparationEligible, withDb } from './cli-context.js';
import { maybePrintUpdateNotice } from './update-notice.js';
import { ensureWatchServiceForCommand, watchServiceAutoStartEligible } from './watch-service.js';
import {
  initializeProfileWorkloadIdentity,
  profileCommand,
  profileEnabled,
  profileRunId,
  profileWorkloadIdentity,
} from '../instrumentation/profile.js';
import { projectEvidenceFingerprint } from '../storage/evidence-cache.js';
import { maybeSweepRepositoryCache } from './repository-cache-lifecycle.js';

program
  .name('scip-query')
  .description('Language-agnostic code intelligence CLI powered by SCIP indexes')
  .version(cliVersion);

registerCommandDescriptors(program, commandDescriptors);
program.hook('preAction', async (_thisCommand, actionCommand) => {
  initializeProfileContext();
  const commandName = actionCommand.name();
  await maybePrintUpdateNotice({ commandName });
  const prepareSharedCache = sharedCachePreparationEligible(commandName);
  const startWatchService = watchServiceAutoStartEligible(commandName);
  if (!prepareSharedCache && !startWatchService) return;
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexStoragePaths(projectRoot, config);
  if (prepareSharedCache) {
    const action = prepareWorktreeIndex(projectRoot, config, paths);
    if (action.kind === 'failed' && process.env['SCIP_QUERY_DEBUG']) {
      console.error(`shared-cache: ${action.reason}`);
    }
  }
  maybeSweepRepositoryCache(projectRoot, cliVersion);
  if (!startWatchService) return;
  const service = ensureWatchServiceForCommand({
    commandName,
    projectRoot,
    cacheDir: paths.cacheDir,
    cliVersion,
    config,
  });
  if (service.kind === 'failed') {
    console.error(`warning: scip-query watch service did not start: ${service.message}`);
  }
});

function initializeProfileContext(): void {
  profileRunId();
  if (!profileEnabled() || profileWorkloadIdentity()) return;
  let projectFingerprint: string | null = null;
  try {
    projectFingerprint = withDb((db) => projectEvidenceFingerprint(db));
  } catch {
    // Setup, init, and first reindex can legitimately run before an index exists.
  }
  initializeProfileWorkloadIdentity({
    command: profileCommand() ?? `scip-query ${process.argv.slice(2).join(' ')}`,
    toolVersion: cliVersion,
    projectFingerprint,
  });
}

export { program, renderHeuristicNotice };

if (isCliEntrypoint()) {
  await program.parseAsync();
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  const thisFile = fileURLToPath(import.meta.url);
  try {
    return realpathSync(thisFile) === realpathSync(process.argv[1]);
  } catch {
    return thisFile === process.argv[1];
  }
}
