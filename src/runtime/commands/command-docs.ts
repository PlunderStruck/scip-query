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

// scip-query: ignore-extract — the generated-reference renderer is one
// formatting pipeline; its sections have no other consumers.
export function renderCommandReferenceMarkdown(descriptors: readonly CommandDescriptor[]): string {
  const entries = commandDocEntries(descriptors);
  const categories = unique(entries.map((entry) => entry.category));
  const lines: string[] = [
    '<!-- BEGIN GENERATED COMMAND REFERENCE -->',
    '',
    'This syntax summary is generated from the CLI command descriptors. Keep workflow guidance hand-authored, but keep command syntax, descriptions, and option flags descriptor-owned.',
    '',
  ];

  for (const category of categories) {
    const categoryEntries = entries.filter((entry) => entry.category === category);
    lines.push(`### ${escapeMarkdown(category)}`, '');
    lines.push('| Command | Description | Options |');
    lines.push('|---|---|---|');
    for (const entry of categoryEntries) {
      lines.push(
        `| \`${escapeCode(entry.command)}\` | ${escapeTableCell(entry.description)} | ${formatOptions(entry.options)} |`,
      );
    }
    lines.push('');
  }

  lines.push('<!-- END GENERATED COMMAND REFERENCE -->');
  return lines.join('\n');
}

function formatOptions(options: readonly string[]): string {
  return options.length > 0 ? options.map((option) => `\`${escapeCode(option)}\``).join('<br>') : '-';
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function escapeCode(value: string): string {
  return value.replaceAll('`', '\\`');
}

function escapeMarkdown(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('`', '\\`');
}

function escapeTableCell(value: string): string {
  return escapeMarkdown(value).replaceAll('|', '\\|');
}
