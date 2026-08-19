import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (isCliEntrypoint()) {
  const argv = process.argv.slice(2);
  let handled = false;
  if (mayUseQueryServiceFastPath(argv)) {
    const { tryRunQueryServiceFastPath } = await import('./query-service-fastpath.js');
    handled = tryRunQueryServiceFastPath(argv);
  }
  if (!handled) {
    const { runCli } = await import('./cli-main.js');
    await runCli();
  }
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
    (argv[0] === 'search' ||
      argv[0] === 'outline' ||
      argv[0] === 'code' ||
      argv[0] === 'entrypoints' ||
      argv[0] === 'files' ||
      argv[0] === 'stats' ||
      argv[0] === 'members' ||
      argv[0] === 'methods' ||
      argv[0] === 'deps' ||
      argv[0] === 'rdeps' ||
      argv[0] === 'imported-by' ||
      argv[0] === 'hierarchy' ||
      argv[0] === 'by-kind' ||
      argv[0] === 'kind-counts' ||
      argv[0] === 'refs' ||
      argv[0] === 'imports' ||
      argv[0] === 'unused-imports' ||
      argv[0] === 'surface') &&
    argv.includes('--json') &&
    argv.includes('--result-only') &&
    argv.includes('--compact') &&
    process.env['SCIP_QUERY_PROFILE'] !== '1' &&
    process.env['SCIP_QUERY_PROFILE'] !== 'true'
  );
}
