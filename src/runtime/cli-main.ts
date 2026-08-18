import { Help, program } from 'commander';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cliVersion, renderHeuristicNotice } from './cli-support.js';
import {
  loadInvocationCommandDescriptors,
  normalizeLegacyEvidenceInvocation,
} from './commands/invocation-command-descriptors.js';
import { registerCommandDescriptors } from './commands/command-registry.js';
import { renderRootCommandHelp } from './commands/command-panels.js';
import {
  activateCliProjectContext,
  resolveCliProjectContext,
  resolveProjectRoot,
  sharedCachePreparationEligible,
  withDb,
} from './cli-context.js';
import { maybePrintUpdateNotice } from './update-notice.js';
import { ensureWatchServiceForCommand, watchServiceAutoStartEligible } from './watch-service.js';
import { ensureEvidenceCommandFreshness } from './evidence-command-freshness.js';
import {
  initializeProfileWorkloadIdentity,
  profileCommand,
  profileEnabled,
  profileRunId,
  profileWorkloadIdentity,
} from '../instrumentation/profile.js';
import { projectEvidenceFingerprint } from '../storage/evidence-cache.js';
import { maybeSweepRepositoryCache } from './repository-cache-lifecycle.js';
import { resolveGitWorktreeContext } from '../platform/git-worktree.js';
import { installTerminalConsoleSanitizer, sanitizeTerminalText } from '../platform/terminal-output.js';
import { parseOutputPageSize } from './output-pagination.js';

const cliEntrypoint = isCliEntrypoint();
if (cliEntrypoint) {
  installTerminalConsoleSanitizer();
  program.configureOutput({
    writeOut: (value) => process.stdout.write(sanitizeTerminalText(value)),
    writeErr: (value) => process.stderr.write(sanitizeTerminalText(value)),
  });
}

program
  .name('scip-query')
  .description('Language-agnostic code intelligence CLI powered by SCIP indexes')
  .version(cliVersion)
  .option(
    '--output-page-size <characters>',
    'Return bounded output pages with an exact continuation command',
    parseOutputPageSize,
  )
  .option('--output-cursor <cursor>', 'Continue a bounded output page')
  .option('--no-session', 'Disable the explicit exploration evidence ledger')
  .option('--reemit', 'Recovery only: render source and graph evidence again instead of citing session receipts')
  .option('--help-all', 'Display every command, including compatibility and deprecated controls');

if (cliEntrypoint) normalizeLegacyEvidenceInvocation(process.argv);
const commandDescriptors = await loadInvocationCommandDescriptors(cliEntrypoint ? process.argv[2] : undefined);
registerCommandDescriptors(program, commandDescriptors);
const defaultHelp = new Help();
program.configureHelp({
  formatHelp: (command, helper) =>
    command === program ? renderRootCommandHelp(program, commandDescriptors) : defaultHelp.formatHelp(command, helper),
});
program.hook('preAction', async (_thisCommand, actionCommand) => {
  const commandName = actionCommand.name();
  const prepareSharedCache = sharedCachePreparationEligible(commandName);
  const startWatchService = watchServiceAutoStartEligible(commandName);
  if (!prepareSharedCache && !startWatchService) {
    initializeProfileContext();
    await maybePrintUpdateNotice({ commandName });
    return;
  }
  const projectRoot = resolveProjectRoot();
  const gitContext = resolveGitWorktreeContext(projectRoot);
  const projectContext = resolveCliProjectContext(projectRoot, gitContext);
  activateCliProjectContext(projectContext);
  initializeProfileContext();
  await maybePrintUpdateNotice({ commandName });
  const { config, paths } = projectContext;
  if (prepareSharedCache) {
    const freshness = await ensureEvidenceCommandFreshness({
      commandName,
      projectRoot,
      config,
      paths,
      dbPathSource: projectContext.dbPathSource,
      gitContext,
    });
    if (process.env['SCIP_QUERY_DEBUG']) {
      console.error(`evidence-freshness: ${freshness.source}`);
    }
    if (freshness.service.kind === 'failed') {
      console.error(`warning: scip-query watch service did not start: ${freshness.service.message}`);
    }
    if (freshness.service.kind === 'failed' || freshness.service.kind === 'skipped') {
      maybeSweepRepositoryCache(projectRoot, cliVersion);
    }
    return;
  }
  if (!startWatchService) {
    maybeSweepRepositoryCache(projectRoot, cliVersion);
    return;
  }
  const service = ensureWatchServiceForCommand({
    commandName,
    projectRoot,
    cacheDir: paths.cacheDir,
    cliVersion,
    config,
    gitContext,
  });
  if (service.kind === 'failed') {
    console.error(`warning: scip-query watch service did not start: ${service.message}`);
  }
  if (service.kind === 'failed' || service.kind === 'skipped') {
    maybeSweepRepositoryCache(projectRoot, cliVersion);
  }
});
program.hook('postAction', () => activateCliProjectContext(undefined));

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

export async function runCli(): Promise<void> {
  if (process.argv.includes('--help-all')) {
    process.stdout.write(renderRootCommandHelp(program, commandDescriptors, { includeCompatibility: true }));
  } else {
    await program.parseAsync();
  }
}

if (cliEntrypoint) await runCli();

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
