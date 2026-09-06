import type { Command } from 'commander';
import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';
import { PRIMARY_EXPLORATION_COMMAND_IDS } from '../command-kit/exploration-manual.js';

export type CommandPanelId =
  | 'primary-exploration'
  | 'specialized-analysis'
  | 'quality-cleanup'
  | 'maintenance'
  | 'compatibility';

export interface CommandPanel {
  id: CommandPanelId;
  title: string;
  purpose: string;
  commands: readonly CommandDescriptor[];
}

const PRIMARY_IDS = new Set<string>(PRIMARY_EXPLORATION_COMMAND_IDS);
const PRIMARY_ORDER = new Map<string, number>(PRIMARY_EXPLORATION_COMMAND_IDS.map((id, index) => [id, index]));
const SPECIALIZED_CATEGORIES = new Set(['Navigation', 'Graph', 'Impact', 'Exploration']);
const QUALITY_CATEGORIES = new Set(['Cleanup', 'Health']);
const MAINTENANCE_CATEGORIES = new Set(['Indexing', 'Core', 'Maintenance']);

export function commandPanelId(descriptor: CommandDescriptor): CommandPanelId {
  if (descriptor.hidden || descriptor.agent?.semantic?.compatibility === 'deprecated') return 'compatibility';
  if (PRIMARY_IDS.has(descriptor.id)) return 'primary-exploration';
  if (['health', 'review', 'context'].includes(descriptor.id)) return 'maintenance';
  const category = descriptor.docs?.category;
  if (category && SPECIALIZED_CATEGORIES.has(category)) return 'specialized-analysis';
  if (category && QUALITY_CATEGORIES.has(category)) return 'quality-cleanup';
  if (category && MAINTENANCE_CATEGORIES.has(category)) return 'maintenance';
  throw new Error(`Visible command ${descriptor.id} has no cockpit panel (docs category: ${category ?? 'missing'}).`);
}

export function commandPanels(
  descriptors: readonly CommandDescriptor[],
  options: { includeCompatibility?: boolean } = {},
): readonly CommandPanel[] {
  const definitions: ReadonlyArray<Omit<CommandPanel, 'commands'>> = [
    {
      id: 'primary-exploration',
      title: 'Primary exploration',
      purpose: 'Locate exact referents, project chosen relationships, and read only named implementation gaps.',
    },
    {
      id: 'specialized-analysis',
      title: 'Specialized analysis',
      purpose: 'Run a named graph, impact, or structural analysis when that exact analysis answers the task.',
    },
    {
      id: 'quality-cleanup',
      title: 'Quality and cleanup',
      purpose: 'Evaluate repository quality, cleanup candidates, and configured architecture findings.',
    },
    {
      id: 'maintenance',
      title: 'Maintenance',
      purpose: 'Scan current source, plan changes, review diffs, and maintain the index and local integrations.',
    },
    {
      id: 'compatibility',
      title: 'Compatibility and deprecated controls',
      purpose: 'Preserved invocation surfaces for existing consumers; do not choose these for new workflows.',
    },
  ];
  const panels = definitions.map((definition) => ({
    ...definition,
    commands: descriptors
      .filter((descriptor) => commandPanelId(descriptor) === definition.id)
      .sort((left, right) =>
        definition.id === 'primary-exploration'
          ? (PRIMARY_ORDER.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
            (PRIMARY_ORDER.get(right.id) ?? Number.MAX_SAFE_INTEGER)
          : 0,
      ),
  }));
  const defaultPanelIds = new Set<CommandPanelId>(['primary-exploration', 'maintenance']);
  return panels.filter(
    (panel) => panel.commands.length > 0 && (options.includeCompatibility || defaultPanelIds.has(panel.id)),
  );
}

export function renderRootCommandHelp(
  program: Command,
  descriptors: readonly CommandDescriptor[],
  options: { includeCompatibility?: boolean } = {},
): string {
  const lines = [`Usage: ${program.name()} [options] [command]`, '', program.description(), '', 'Options:'];
  const optionTerms = program.options.map((option) => option.flags);
  const optionWidth = Math.max(...optionTerms.map((term) => term.length), 0);
  for (const option of program.options) {
    lines.push(`  ${option.flags.padEnd(optionWidth)}  ${option.description}`);
  }
  lines.push(`  ${'-h, --help'.padEnd(optionWidth)}  Display this grouped command help`);
  for (const panel of commandPanels(descriptors, options)) {
    lines.push('', `${panel.title}:`, `  ${panel.purpose}`);
    const width = Math.max(...panel.commands.map((descriptor) => descriptor.command.length), 0);
    for (const descriptor of panel.commands) {
      lines.push(`  ${descriptor.command.padEnd(width)}  ${descriptor.description}`);
    }
  }
  if (!options.includeCompatibility) {
    lines.push('', 'Run `scip-query --help-all` to include advanced, compatibility, and deprecated controls.');
  }
  lines.push("Run `scip-query <command> --help` for one control's options and examples.", '');
  return lines.join('\n');
}
