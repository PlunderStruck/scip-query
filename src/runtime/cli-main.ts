import { Help, program } from 'commander';
import { existsSync, realpathSync } from 'node:fs';
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
  existingIndexFallbackEligible,
  openProjectDb,
  resolveCliProjectContext,
  resolveProjectRoot,
  sharedCachePreparationEligible,
} from './cli-context.js';
import { observeGitWorktreeContextWithCache } from './git-worktree-context-cache.js';
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
import { installTerminalConsoleSanitizer, sanitizeTerminalText } from '../platform/terminal-output.js';
import { enterProjectFileListingCache } from '../platform/project-file-inventory-context.js';
import { parseOutputPageSize } from './output-pagination.js';
import { runCliWithErrorBoundary } from './cli-error-boundary.js';

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
  .option('--agent-output', 'Emit a bounded JSON projection for model-facing clients (requires --json)')
  .option('--json-output <path>', 'Atomically write the complete JSON result and print a small receipt')
  .option('--raw-json', 'Explicitly retain the legacy unpaged JSON stream (requires --json)')
  .option('--no-session', 'Disable the explicit exploration evidence ledger')
  .option('--reemit', 'Recovery only: render source and graph evidence again instead of citing session receipts')
  .option('--help-all', 'Display every command, including compatibility and deprecated controls');

if (cliEntrypoint) normalizeLegacyEvidenceInvocation(process.argv);
const commandDescriptors = await loadInvocationCommandDescriptors(cliEntrypoint ? process.argv[2] : undefined);
registerCommandDescriptors(program, commandDescriptors);
let releaseProjectFileListingCache: (() => void) | undefined;
const defaultHelp = new Help();
program.configureHelp({
  formatHelp: (command, helper) =>
    command === program ? renderRootCommandHelp(program, commandDescriptors) : defaultHelp.formatHelp(command, helper),
});
program.hook('preAction', async (_thisCommand, actionCommand) => {
  const commandName = actionCommand.name();
  if (commandName === 'continue') {
    initializeProfileContext();
    return;
  }
  const prepareSharedCache = sharedCachePreparationEligible(commandName);
  const startWatchService = watchServiceAutoStartEligible(commandName);
  if (prepareSharedCache) releaseProjectFileListingCache = enterProjectFileListingCache();
  if (!prepareSharedCache && !startWatchService) {
    initializeProfileContext();
    await maybePrintUpdateNotice({ commandName });
    return;
  }
  const projectRoot = resolveProjectRoot();
  let projectContext = resolveCliProjectContext(projectRoot);
  activateCliProjectContext(projectContext);
  initializeProfileContext();
  await maybePrintUpdateNotice({ commandName });
  const gitObservation = observeGitWorktreeContextWithCache(projectRoot, projectContext.paths.cacheDir);
  const gitContext = gitObservation?.context;
  projectContext = { ...projectContext, gitContext };
  activateCliProjectContext(projectContext);
  const { config, paths } = projectContext;
  if (prepareSharedCache) {
    let freshness;
    try {
      freshness = await ensureEvidenceCommandFreshness({
        commandName,
        projectRoot,
        config,
        paths,
        dbPathSource: projectContext.dbPathSource,
        gitContext,
        gitObservation,
      });
    } catch (error) {
      if (!existingIndexFallbackEligible(commandName) || !existsSync(projectContext.dbPath)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `warning: index refresh failed; ${commandName} is using the existing index. Current file text remains exact, but index-derived symbols and relationships may be stale. ${message}`,
      );
      maybeSweepRepositoryCache(projectRoot, cliVersion, { repositoryId: gitContext?.repositoryId ?? null });
      return;
    }
    if (process.env['SCIP_QUERY_DEBUG']) {
      console.error(`evidence-freshness: ${freshness.source}`);
    }
    if (freshness.service.kind === 'failed') {
      console.error(`warning: scip-query watch service did not start: ${freshness.service.message}`);
    }
    if (freshness.service.kind === 'failed' || freshness.service.kind === 'skipped') {
      maybeSweepRepositoryCache(projectRoot, cliVersion, { repositoryId: gitContext?.repositoryId ?? null });
    }
    return;
  }
  if (!startWatchService) {
    maybeSweepRepositoryCache(projectRoot, cliVersion, { repositoryId: gitContext?.repositoryId ?? null });
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
    maybeSweepRepositoryCache(projectRoot, cliVersion, { repositoryId: gitContext?.repositoryId ?? null });
  }
});
program.hook('postAction', () => {
  activateCliProjectContext(undefined);
  releaseProjectFileListingCache?.();
  releaseProjectFileListingCache = undefined;
});

function initializeProfileContext(): void {
  profileRunId();
  if (!profileEnabled() || profileWorkloadIdentity()) return;
  let projectFingerprint: string | null = null;
  let db: ReturnType<typeof openProjectDb> | null = null;
  try {
    db = openProjectDb(resolveProjectRoot());
    projectFingerprint = projectEvidenceFingerprint(db);
  } catch {
    // Setup, init, and first reindex can legitimately run before an index exists.
  } finally {
    db?.close();
  }
  initializeProfileWorkloadIdentity({
    command: profileCommand() ?? `scip-query ${process.argv.slice(2).join(' ')}`,
    toolVersion: cliVersion,
    projectFingerprint,
  });
}

export { program, renderHeuristicNotice };

export async function runCli(): Promise<void> {
  try {
    if (process.argv.includes('--help-all')) {
      process.stdout.write(renderRootCommandHelp(program, commandDescriptors, { includeCompatibility: true }));
    } else {
      await program.parseAsync();
    }
  } finally {
    releaseProjectFileListingCache?.();
    releaseProjectFileListingCache = undefined;
  }
}

if (cliEntrypoint) await runCliWithErrorBoundary(runCli);

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
