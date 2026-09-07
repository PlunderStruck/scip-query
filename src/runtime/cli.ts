import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCliWithErrorBoundary } from './cli-error-boundary.js';

const QUERY_SERVICE_FAST_PATH_COMMANDS = new Set([
  'search',
  'outline',
  'code',
  'entrypoints',
  'files',
  'stats',
  'members',
  'methods',
  'deps',
  'rdeps',
  'imported-by',
  'hierarchy',
  'by-kind',
  'kind-counts',
  'refs',
  'trace',
  'value-flow',
  'dependence-slice',
  'call-graph',
  'imports',
  'unused-imports',
  'system',
  'surface',
]);

if (isCliEntrypoint()) {
  await runCliWithErrorBoundary(async () => {
    const argv = process.argv.slice(2);
    let handled = false;
    if (mayUseQueryServiceFastPath(argv)) {
      const { tryRunQueryServiceFastPath } = await import('./query-service-fastpath.js');
      handled = await tryRunQueryServiceFastPath(argv);
    }
    if (!handled) {
      const { runCli } = await import('./cli-main.js');
      await runCli();
    }
  });
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  const thisFile = fileURLToPath(import.meta.url);
  try {
    return realpathSync(thisFile) === realpathSync(process.argv[1]);
  } catch {
    return thisFile === process.argv[1];
  }
}

function mayUseQueryServiceFastPath(argv: readonly string[]): boolean {
  return (
    QUERY_SERVICE_FAST_PATH_COMMANDS.has(argv[0] ?? '') &&
    argv.includes('--json') &&
    argv.includes('--result-only') &&
    argv.includes('--compact') &&
    process.env['SCIP_QUERY_PROFILE'] !== '1' &&
    process.env['SCIP_QUERY_PROFILE'] !== 'true'
  );
}
