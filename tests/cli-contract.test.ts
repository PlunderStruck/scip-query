import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { program, renderHeuristicNotice } from '../src/runtime/cli.js';
import { commandDescriptors } from '../src/runtime/command-descriptors.js';
import { commandDocEntries } from '../src/runtime/command-docs.js';

function command(name: string) {
  const cmd = program.commands.find((entry) => entry.name() === name);
  expect(cmd, `missing command: ${name}`).toBeDefined();
  return cmd!;
}

function optionFlags(name: string): string[] {
  return command(name).options.map((option) => option.flags);
}

describe('CLI contract', () => {
  it('registers every descriptor-backed command in descriptor order', () => {
    const names = program.commands.map((entry) => entry.name());

    expect(names).toEqual(commandDescriptors.map((descriptor) => descriptor.id));
  });

  it('registers command descriptions and option flags from descriptors', () => {
    for (const descriptor of commandDescriptors.filter((entry) => !entry.hidden)) {
      expect(command(descriptor.id).description()).toBe(descriptor.description);
      expect(optionFlags(descriptor.id)).toEqual((descriptor.options ?? []).map((option) => option.flags));
    }
  });

  it('keeps heuristic classification descriptor-owned', () => {
    for (const descriptor of commandDescriptors.filter((entry) => entry.heuristic)) {
      expect(command(descriptor.id).description().toLowerCase()).toContain('candidate');
    }
  });

  it('keeps public command docs derived from descriptors', () => {
    const docs = commandDocEntries(commandDescriptors);
    expect(docs.map((entry) => entry.id)).toEqual(commandDescriptors.filter((descriptor) => !descriptor.hidden).map((descriptor) => descriptor.id));
    expect(docs.find((entry) => entry.id === 'health')?.options).toEqual([
      '-s, --scope <path>',
      '--full',
      '--json',
    ]);
  });

  it('keeps README and agent guide command references descriptor-backed', () => {
    const publicCommandIds = new Set(commandDescriptors.filter((descriptor) => !descriptor.hidden).map((descriptor) => descriptor.id));
    const documentedCommands = [
      ...readDocumentedCommands('README.md'),
      ...readDocumentedCommands('docs/AGENT_GUIDE.md'),
    ];

    expect(documentedCommands).not.toHaveLength(0);
    for (const documentedCommand of documentedCommands) {
      expect(publicCommandIds.has(documentedCommand), `documented command is not descriptor-backed: ${documentedCommand}`).toBe(true);
    }
  });

  it('prints an explicit heuristic disclaimer for candidate output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    renderHeuristicNotice('stale abstraction candidates');

    expect(log).toHaveBeenCalledWith(
      'Heuristic stale abstraction candidates: review before acting; these are candidates, not exact compiler facts.\n',
    );
  });
});

function readDocumentedCommands(path: string): string[] {
  const content = readFileSync(join(process.cwd(), path), 'utf8');
  const matches = content.matchAll(/\bscip-query\s+([a-z][a-z0-9-]*)\b/g);
  return [...matches].map((match) => match[1]!);
}
