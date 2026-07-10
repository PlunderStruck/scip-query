import { program } from 'commander';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cliVersion, renderHeuristicNotice } from './cli-support.js';
import { commandDescriptors } from './commands/command-descriptors.js';
import { registerCommandDescriptors } from './commands/command-registry.js';
import { loadProjectConfig, resolveIndexStoragePaths } from './config.js';
import { resolveProjectRoot } from './cli-context.js';
import { maybePrintUpdateNotice } from './update-notice.js';
import { ensureWatchServiceForCommand, watchServiceAutoStartEligible } from './watch-service.js';
import { profileRunId } from '../instrumentation/profile.js';

program
  .name('scip-query')
  .description('Language-agnostic code intelligence CLI powered by SCIP indexes')
  .version(cliVersion);

registerCommandDescriptors(program, commandDescriptors);
program.hook('preAction', async (_thisCommand, actionCommand) => {
  profileRunId();
  const commandName = actionCommand.name();
  await maybePrintUpdateNotice({ commandName });
  if (!watchServiceAutoStartEligible(commandName)) return;
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexStoragePaths(projectRoot, config);
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
