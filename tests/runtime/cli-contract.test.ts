import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { program, renderHeuristicNotice } from '../../src/runtime/cli.js';
import { commandDescriptors } from '../../src/runtime/commands/command-descriptors.js';
import { commandDocEntries, renderCommandReferenceMarkdown } from '../../src/runtime/commands/command-docs.js';
import { commandOptions, definedLimitOption, printJsonEnvelope } from '../../src/runtime/commands/command-execution.js';
import {
  PRIVATE_QUERY_MODULES,
  PUBLIC_QUERY_ENTRIES,
  QUERY_SOURCE_PATHS,
} from '../../src/queries/public-query-entries.js';

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
    expect(names).not.toContain('symbols');
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
    expect(docs.map((entry) => entry.id)).toEqual(
      commandDescriptors.filter((descriptor) => !descriptor.hidden).map((descriptor) => descriptor.id),
    );
    expect(docs.find((entry) => entry.id === 'health')?.options).toEqual([
      '-s, --scope <path>',
      '--full',
      '--json',
      '--baseline',
      '--write-baseline',
    ]);
    expect(docs.find((entry) => entry.id === 'diff-gate')?.options).toContain('--json');
    expect(docs.find((entry) => entry.id === 'plan-context')).toMatchObject({
      command: 'plan-context <target>',
      category: 'Planning',
    });
  });

  it('keeps public command references descriptor-backed', () => {
    const publicCommandIds = new Set(
      commandDescriptors.filter((descriptor) => !descriptor.hidden).map((descriptor) => descriptor.id),
    );
    const skillDocs = readdirSync(join(process.cwd(), 'skills')).map((skill) => `skills/${skill}/SKILL.md`);
    const documentedCommands = ['README.md', 'docs/AGENT_GUIDE.md', 'docs/COMMAND_REFERENCE.md', ...skillDocs].flatMap(
      (path) => readDocumentedCommands(path).map((command) => ({ path, command })),
    );

    expect(documentedCommands).not.toHaveLength(0);
    for (const { path, command } of documentedCommands) {
      expect(publicCommandIds.has(command), `documented command is not descriptor-backed: ${command} (${path})`).toBe(
        true,
      );
    }
  });

  it('keeps command reference syntax generated from descriptors', () => {
    const commandReference = readFileSync(join(process.cwd(), 'docs/COMMAND_REFERENCE.md'), 'utf8');

    expect(extractGeneratedCommandReference(commandReference)).toBe(renderCommandReferenceMarkdown(commandDescriptors));
    expect(commandReference).toContain('### Planning');
    expect(commandReference).toContain('`plan-context <target>`');
  });

  it('registers plan-context as a semantic custom query command', () => {
    expect(commandDescriptors.find((descriptor) => descriptor.id === 'plan-context')).toMatchObject({
      command: 'plan-context <target>',
      budget: 'semantic',
      renderShape: 'custom',
    });
  });

  it('prints an explicit heuristic disclaimer for candidate output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    renderHeuristicNotice('stale abstraction candidates');

    expect(log).toHaveBeenCalledWith(
      'Heuristic stale abstraction candidates: review before acting; these are candidates, not exact compiler facts.\n',
    );
  });

  it('prints stable JSON envelopes with only scalar positional args', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    printJsonEnvelope('fan-in', ['symbolName', { json: true }], { json: true }, { rows: [] });

    const payload = JSON.parse(log.mock.calls[0]![0] as string) as {
      command: string;
      args: unknown[];
      options: Record<string, unknown>;
      result: unknown;
    };
    expect(payload).toEqual({
      command: 'fan-in',
      args: ['symbolName'],
      options: { json: true },
      result: { rows: [] },
    });
  });

  it('treats --full as an unbounded result limit unless --limit is explicit', () => {
    expect(definedLimitOption({}, 'limit', 30)).toBe(30);
    expect(definedLimitOption({ full: true }, 'limit', 30)).toBe(Number.POSITIVE_INFINITY);
    expect(() => definedLimitOption({ full: true, limit: 7 }, 'limit', 30)).toThrow(
      '--full cannot be combined with --limit',
    );

    const defaultedOpts = commandOptions({
      opts: () => ({ full: true, limit: 30 }),
      getOptionValueSource: (key: string) => (key === 'limit' ? 'default' : 'cli'),
    });
    const explicitOpts = commandOptions({
      opts: () => ({ full: true, limit: 7 }),
      getOptionValueSource: (key: string) => (key === 'limit' ? 'cli' : 'cli'),
    });

    expect(definedLimitOption(defaultedOpts, 'limit', 30)).toBe(Number.POSITIVE_INFINITY);
    expect(() => definedLimitOption(explicitOpts, 'limit', 30)).toThrow('--full cannot be combined with --limit');
  });

  it('keeps default result limits full-aware', () => {
    const limitedDescriptors = commandDescriptors.filter((descriptor) =>
      descriptor.options?.some((option) => option.flags.includes('--limit ')),
    );

    expect(limitedDescriptors.map((descriptor) => descriptor.id)).not.toEqual([]);
    for (const descriptor of limitedDescriptors) {
      expect(
        descriptor.options?.some((option) => option.flags === '--full'),
        `${descriptor.id} exposes --limit without --full`,
      ).toBe(true);
    }

    const commandSources = readdirSync(join(process.cwd(), 'src/runtime/query-commands'))
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => readFileSync(join(process.cwd(), 'src/runtime/query-commands', entry), 'utf8'))
      .join('\n');
    expect(commandSources).not.toContain("definedNumberOption(opts, 'limit'");
  });

  it('runs the visible health command in full mode by default', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/commands/command-handlers.ts'), 'utf8');

    expect(source).toContain('const report = runIsolatedHealthReport({');
    expect(source).toMatch(/runIsolatedHealthReport\(\{\s*scope: stringOptionValue\(opts, 'scope'\),\s*full: true,/);
  });

  it('parses graph top-mode limits before targeted-mode branches', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/query-commands/graph.ts'), 'utf8');

    expect(source).toMatch(
      /const handleFanIn[\s\S]*?const symbol = optionalStringArg\(args, 0\);[\s\S]*?const limit = definedLimitOption\(opts, 'limit', 30\);[\s\S]*?if \(symbol\)/,
    );
    expect(source).toMatch(
      /const handleFanOut[\s\S]*?const file = optionalStringArg\(args, 0\);[\s\S]*?const limit = definedLimitOption\(opts, 'limit', 30\);[\s\S]*?if \(file\)/,
    );
    expect(source).toMatch(
      /const handleCoupling[\s\S]*?const file1 = optionalStringArg\(args, 0\);[\s\S]*?const file2 = optionalStringArg\(args, 1\);[\s\S]*?const limit = definedLimitOption\(opts, 'limit', 20\);[\s\S]*?if \(file1 && file2\)/,
    );
  });

  it('keeps package.json query subpaths in lockstep with the public-query manifest', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    const exportKeys = Object.keys(packageJson.exports);

    expect(exportKeys).not.toContain('./queries/*');
    // Bidirectional: every manifest entry is exported, and every exported
    // query subpath is in the manifest — neither list can drift.
    const exportedQuerySubpaths = exportKeys.filter((key) => key.startsWith('./queries/')).sort();
    const manifestSubpaths = PUBLIC_QUERY_ENTRIES.map((entry) => `./queries/${entry}`).sort();
    expect(exportedQuerySubpaths).toEqual(manifestSubpaths);
    for (const entry of PUBLIC_QUERY_ENTRIES) {
      expect(packageJson.exports[`./queries/${entry}`]).toEqual({
        import: `./dist/queries/${entry}.js`,
        types: `./dist/queries/${entry}.d.ts`,
      });
    }

    for (const privateModule of PRIVATE_QUERY_MODULES) {
      expect(
        Object.hasOwn(packageJson.exports, `./queries/${privateModule}`),
        `helper module should not be exported: ${privateModule}`,
      ).toBe(false);
    }
  });

  it('keeps command-level query aliases published in the public-query manifest', () => {
    const commandQueryAliases = new Map([
      ['fan-in', 'fan'],
      ['fan-out', 'fan'],
      ['imported-by', 'imports'],
      ['kind-counts', 'by-kind'],
      ['unused-imports', 'unused-imports'],
    ]);
    const commandIds = new Set(commandDescriptors.map((descriptor) => descriptor.id));

    for (const [commandId, queryEntry] of commandQueryAliases) {
      expect(commandIds.has(commandId), `missing command descriptor: ${commandId}`).toBe(true);
      expect(PUBLIC_QUERY_ENTRIES).toContain(queryEntry);
      expect(QUERY_SOURCE_PATHS[queryEntry as keyof typeof QUERY_SOURCE_PATHS]).toMatch(/^src\/queries\//);
    }
  });

  it('classifies every query source file in the manifest as public or private', () => {
    const queryModules = querySourceFiles('src/queries')
      .filter((entry) => !entry.startsWith('src/queries/internal/'))
      .sort();
    const classified = [...new Set(Object.values(QUERY_SOURCE_PATHS))].sort();

    expect(queryModules).toEqual(classified);
  });

  it('keeps root package exports focused on core library helpers', () => {
    const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');

    expect(source).toContain('export { ScipDatabase }');
    expect(source).toContain('export { ProjectIndex }');
    expect(source).not.toContain("export * from './queries/index.js'");
    expect(source).not.toContain("from './reindex/index.js'");
    expect(source).not.toContain("from './runtime/");
  });
});

function readDocumentedCommands(path: string): string[] {
  const content = readFileSync(join(process.cwd(), path), 'utf8');
  const matches = content.matchAll(/^\s*scip-query\s+([a-z][a-z0-9-]*)\b/gm);
  return [...matches].map((match) => match[1]!);
}

function querySourceFiles(relativeDir: string): string[] {
  return readdirSync(join(process.cwd(), relativeDir), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      return querySourceFiles(relativePath);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [relativePath] : [];
  });
}

function extractGeneratedCommandReference(content: string): string {
  const match = content.match(
    /<!-- BEGIN GENERATED COMMAND REFERENCE -->[\s\S]*?<!-- END GENERATED COMMAND REFERENCE -->/,
  );
  expect(match, 'command reference is missing generated command reference block').not.toBeNull();
  return match![0];
}
