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

  it('keeps query package subpaths explicit and helper modules private', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    const exportKeys = Object.keys(packageJson.exports);
    const publicQuerySubpaths = [
      './queries/affected',
      './queries/bottlenecks',
      './queries/by-kind',
      './queries/call-graph',
      './queries/change-surface',
      './queries/code',
      './queries/complexity',
      './queries/complexity-hotspots',
      './queries/convergence',
      './queries/coupling',
      './queries/cycles',
      './queries/dataflow',
      './queries/dead',
      './queries/deep-chains',
      './queries/deps',
      './queries/diff-impact',
      './queries/drift',
      './queries/extract-candidates',
      './queries/fan',
      './queries/files',
      './queries/health',
      './queries/hierarchy',
      './queries/hotspots',
      './queries/imports',
      './queries/index',
      './queries/isolated',
      './queries/members',
      './queries/methods',
      './queries/outline',
      './queries/passthrough-candidates',
      './queries/redundant-reexports',
      './queries/refs',
      './queries/similar',
      './queries/similar-chains',
      './queries/similar-files',
      './queries/similar-signatures',
      './queries/slice',
      './queries/stale-abstractions',
      './queries/stats',
      './queries/surface',
      './queries/symbols',
      './queries/system',
      './queries/trace',
      './queries/wrapper-candidates',
    ];

    expect(exportKeys).not.toContain('./queries/*');
    for (const subpath of publicQuerySubpaths) {
      expect(Object.hasOwn(packageJson.exports, subpath), `missing query export: ${subpath}`).toBe(true);
    }
    for (const privateSubpath of [
      './queries/dead-exclusions',
      './queries/drift-policy',
      './queries/health-cache-control',
      './queries/health-report',
      './queries/health-types',
      './queries/query-utils',
    ]) {
      expect(Object.hasOwn(packageJson.exports, privateSubpath), `helper module should not be exported: ${privateSubpath}`).toBe(false);
    }
  });
});

function readDocumentedCommands(path: string): string[] {
  const content = readFileSync(join(process.cwd(), path), 'utf8');
  const matches = content.matchAll(/\bscip-query\s+([a-z][a-z0-9-]*)\b/g);
  return [...matches].map((match) => match[1]!);
}
