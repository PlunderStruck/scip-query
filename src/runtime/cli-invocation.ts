import { basename } from 'node:path';

export function cliInvocationPrefix(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): string[] {
  const scriptPath = argv[1];
  if (!scriptPath || basename(scriptPath) === 'scip-query') return ['scip-query'];
  return [execPath, scriptPath];
}
