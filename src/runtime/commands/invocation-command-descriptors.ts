import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';

const DIRECT_NAVIGATION_COMMANDS = new Set(['code', 'outline', 'refs']);

export function directNavigationCommandEligible(commandName: string | undefined): boolean {
  return commandName !== undefined && DIRECT_NAVIGATION_COMMANDS.has(commandName);
}

export async function loadInvocationCommandDescriptors(
  commandName: string | undefined,
): Promise<readonly CommandDescriptor[]> {
  if (directNavigationCommandEligible(commandName)) {
    const { directNavigationQueryCommandDescriptors } = await import('../query-commands/direct-navigation.js');
    const descriptor = directNavigationQueryCommandDescriptors.find((candidate) => candidate.id === commandName);
    if (!descriptor) throw new Error(`Direct navigation command descriptor is unavailable: ${commandName}`);
    return [descriptor];
  }
  const { commandDescriptors } = await import('./command-descriptors.js');
  return commandDescriptors;
}
