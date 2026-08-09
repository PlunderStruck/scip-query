import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';

const DIRECT_NAVIGATION_COMMANDS = new Set(['code', 'outline', 'refs']);
const GRAPH_EVIDENCE_FLAGS = [
  '--symbol',
  '--at',
  '--search',
  '--view',
  '--edge',
  '--direction',
  '--subtype',
  '--connecting',
  '--inventory-only',
  '--fold',
  '--depth',
  '--max-edges',
] as const;

/**
 * Preserve pre-0.20 positional evidence invocations without exposing two
 * meanings through the canonical command. Positional graph roots become an
 * explicit --symbol selector; source-evidence calls route to a hidden alias.
 */
export function normalizeLegacyEvidenceInvocation(argv: string[]): void {
  if (argv[2] !== 'evidence') return;
  const positional = argv[3];
  if (!positional || positional.startsWith('-')) return;
  const remaining = argv.slice(4);
  const graphRequested = remaining.some((token) =>
    GRAPH_EVIDENCE_FLAGS.some((flag) => token === flag || token.startsWith(`${flag}=`)),
  );
  if (graphRequested) {
    argv.splice(3, 1, '--symbol', positional);
    return;
  }
  argv[2] = 'evidence-source';
}

export function directNavigationCommandEligible(commandName: string | undefined): boolean {
  return commandName !== undefined && DIRECT_NAVIGATION_COMMANDS.has(commandName);
}

export async function loadInvocationCommandDescriptors(
  commandName: string | undefined,
): Promise<readonly CommandDescriptor[]> {
  if (commandName === 'continue') {
    const { outputContinuationCommandDescriptor } = await import('./output-continuation-command.js');
    return [outputContinuationCommandDescriptor];
  }
  if (directNavigationCommandEligible(commandName)) {
    const { directNavigationQueryCommandDescriptors } = await import('../query-commands/direct-navigation.js');
    const descriptor = directNavigationQueryCommandDescriptors.find((candidate) => candidate.id === commandName);
    if (!descriptor) throw new Error(`Direct navigation command descriptor is unavailable: ${commandName}`);
    return [descriptor];
  }
  const { commandDescriptors } = await import('./command-descriptors.js');
  return commandDescriptors;
}
