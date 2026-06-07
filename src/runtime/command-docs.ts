import type { CommandDescriptor } from './command-descriptor-types.js';

export interface CommandDocEntry {
  id: string;
  command: string;
  description: string;
  category: string;
  options: readonly string[];
  hidden: boolean;
  heuristic: boolean;
}

export function commandDocEntries(descriptors: readonly CommandDescriptor[]): CommandDocEntry[] {
  return descriptors
    .filter((descriptor) => !descriptor.hidden)
    .map((descriptor) => ({
      id: descriptor.id,
      command: descriptor.command,
      description: descriptor.description,
      category: descriptor.docs?.category ?? 'Uncategorized',
      options: (descriptor.options ?? []).map((option) => option.flags),
      hidden: Boolean(descriptor.hidden),
      heuristic: Boolean(descriptor.heuristic),
    }));
}
