import { program } from 'commander';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cliVersion, renderHeuristicNotice } from './cli-support.js';
import { commandDescriptors } from './command-descriptors.js';
import { registerCommandDescriptors } from './command-registry.js';
import { maybePrintUpdateNotice } from './update-notice.js';

program
  .name('scip-query')
  .description('Language-agnostic code intelligence CLI powered by SCIP indexes')
  .version(cliVersion);

registerCommandDescriptors(program, commandDescriptors);
program.hook('preAction', async () => {
  await maybePrintUpdateNotice();
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
