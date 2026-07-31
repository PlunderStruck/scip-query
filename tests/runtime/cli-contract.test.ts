import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { program, renderHeuristicNotice } from '../../src/runtime/cli.js';
import { commandDescriptors } from '../../src/runtime/commands/command-descriptors.js';
import { commandResultUnitPolicy } from '../../src/runtime/commands/command-registry.js';
import { commandDocEntries, renderCommandReferenceMarkdown } from '../../src/runtime/command-kit/command-docs.js';
import { renderAgentContractCatalogMarkdown } from '../../scripts/render-command-reference.js';
import { BUILTIN_SKILLS } from '../../src/runtime/setup.js';
import {
  commandOptions,
  definedLimitOption,
  printJsonEnvelope,
  runWithCommandOperationRole,
  validateInvocationCoverage,
} from '../../src/runtime/command-kit/command-execution.js';
import type { InvocationCoverage } from '../../src/runtime/command-kit/command-descriptor-types.js';
import { PUBLIC_QUERY_ENTRIES, PUBLIC_QUERY_SOURCE_PATHS } from '../../src/queries/public-query-entries.js';
import { watchServiceAutoStartEligible } from '../../src/runtime/watch-service.js';
import {
  COMMAND_OPERATION_ROLES,
  commandOperationRoles,
  resolveCommandOperationRole,
} from '../../src/runtime/command-operation.js';

const PRIVATE_QUERY_MODULES = [
  'boundary-evidence',
  'callable-contracts',
  'coverage-contracts',
  'dead-exclusions',
  'diff-gate-baseline-policy',
  'diff-gate-doc-policy',
  'doc-citation-context',
  'doc-terms',
  'effectiveness',
  'finding-outcome-ledger',
  'health-baseline',
  'health-cache-control',
  'health-report',
  'health-types',
  'newly-unreferenced-residue',
  'public-query-entries',
  'query-utils',
  'architecture-baseline',
  'architecture-finding-evidence',
  'test-boundary-policy',
] as const;

const PRIVATE_QUERY_SOURCE_PATHS = {
  'boundary-evidence': 'src/queries/cleanup/boundary-evidence.ts',
  'callable-contracts': 'src/queries/cleanup/callable-contracts.ts',
  'coverage-contracts': 'src/queries/cleanup/coverage-contracts.ts',
  'dead-exclusions': 'src/queries/cleanup/dead-exclusions.ts',
  'diff-gate-baseline-policy': 'src/queries/impact/diff-gate-baseline-policy.ts',
  'diff-gate-doc-policy': 'src/queries/cleanup/diff-gate-doc-policy.ts',
  'doc-citation-context': 'src/queries/cleanup/doc-citation-context.ts',
  'doc-terms': 'src/queries/cleanup/doc-terms.ts',
  effectiveness: 'src/queries/health/effectiveness.ts',
  'finding-outcome-ledger': 'src/queries/health/finding-outcome-ledger.ts',
  'health-baseline': 'src/queries/health/health-baseline.ts',
  'health-cache-control': 'src/queries/health/health-cache-control.ts',
  'health-report': 'src/queries/health/health-report.ts',
  'health-types': 'src/queries/health/health-types.ts',
  'newly-unreferenced-residue': 'src/queries/impact/newly-unreferenced-residue.ts',
  'public-query-entries': 'src/queries/public-query-entries.ts',
  'query-utils': 'src/queries/query-utils.ts',
  'architecture-baseline': 'src/queries/graph/architecture-baseline.ts',
  'architecture-finding-evidence': 'src/queries/graph/architecture-finding-evidence.ts',
  'test-boundary-policy': 'src/queries/graph/test-boundary-policy.ts',
} as const satisfies Record<(typeof PRIVATE_QUERY_MODULES)[number], string>;

const QUERY_SOURCE_PATHS = {
  ...PUBLIC_QUERY_SOURCE_PATHS,
  ...PRIVATE_QUERY_SOURCE_PATHS,
} as const;

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

  it('keeps passive registered commands out of demand-started watcher policy', () => {
    const commandIds = new Set(commandDescriptors.map((descriptor) => descriptor.id));
    const passiveCommands = ['doctor', 'effectiveness', 'install-skills', 'status'];

    expect(passiveCommands.every((commandName) => commandIds.has(commandName))).toBe(true);
    for (const commandName of passiveCommands) {
      expect(watchServiceAutoStartEligible(commandName, {}), commandName).toBe(false);
    }
    for (const commandName of ['refs', 'health', 'plan-context']) {
      expect(commandIds.has(commandName), commandName).toBe(true);
      expect(watchServiceAutoStartEligible(commandName, {}), commandName).toBe(true);
    }
  });

  it('registers command descriptions and option flags from descriptors', () => {
    for (const descriptor of commandDescriptors.filter((entry) => !entry.hidden)) {
      expect(command(descriptor.id).description()).toBe(descriptor.description);
      expect(optionFlags(descriptor.id)).toEqual((descriptor.options ?? []).map((option) => option.flags));
    }
  });

  it('registers universal resumable output options at the program boundary', () => {
    expect(program.options.map((option) => option.flags)).toEqual(
      expect.arrayContaining(['--output-page-size <characters>', '--output-cursor <cursor>']),
    );
  });

  it('gives every JSON-capable command the same JSON presentation options', () => {
    const jsonDescriptors = commandDescriptors.filter(
      (descriptor) => !descriptor.hidden && descriptor.options?.some((option) => option.flags === '--json'),
    );

    expect(jsonDescriptors.length).toBeGreaterThan(50);
    for (const descriptor of jsonDescriptors) {
      expect(descriptor.options?.map((option) => option.flags).slice(-3), descriptor.id).toEqual([
        '--json',
        '--result-only',
        '--compact',
      ]);
    }
  });

  it('marks private JSON workers so transport pagination cannot wrap their envelopes', () => {
    for (const name of ['__diff-gate-run', '__diff-impact-batch', '__health-phase']) {
      expect(optionFlags(name), name).toContain('--json');
    }
  });

  it('requires an agent contract on every public command', () => {
    const missing = commandDescriptors
      .filter((descriptor) => !descriptor.hidden && !descriptor.agent)
      .map((descriptor) => descriptor.id);

    expect(missing, `${missing.length} public command(s) have no \`agent\` contract: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('keeps every declared agent contract well-formed', () => {
    const coveragePolicies = new Set(['complete', 'bounded', 'sampled', 'unknown']);
    const inputKinds = new Set(['symbol', 'file', 'module', 'pattern', 'path', 'action', 'finding', 'record']);
    const scopes = new Set(['diff', 'repository']);
    const operationRoles = new Set(COMMAND_OPERATION_ROLES);
    const commandIds = new Set(commandDescriptors.map((descriptor) => descriptor.id));

    for (const descriptor of commandDescriptors) {
      const contract = descriptor.agent;
      if (!contract) continue;
      const where = `agent contract for ${descriptor.id}`;

      expect(contract.answers.length, `${where}: needs at least one answerable question`).toBeGreaterThan(0);
      expect(contract.returns.length, `${where}: needs at least one returned unit`).toBeGreaterThan(0);
      expect(coveragePolicies.has(contract.coverage), `${where}: bad coverage "${contract.coverage}"`).toBe(true);
      expect(commandResultUnitPolicy(descriptor), `${where}: missing result-unit policy`).toMatchObject({
        kind: expect.stringMatching(/^(rows|report|field)$/),
      });
      expect(commandOperationRoles(contract.operation).length, `${where}: needs an operation role`).toBeGreaterThan(0);
      expect(operationRoles.has(contract.operation.defaultRole), `${where}: bad default operation role`).toBe(true);
      for (const rule of contract.operation.rules ?? []) {
        expect(operationRoles.has(rule.role), `${where}: bad selected operation role`).toBe(true);
        if (rule.when.kind === 'argument') {
          expect(Number.isSafeInteger(rule.when.index) && rule.when.index >= 0, `${where}: bad argument selector`).toBe(
            true,
          );
          expect(rule.when.index, `${where}: selector exceeds positional arity`).toBeLessThan(contract.inputs.length);
        } else {
          const optionNames = new Set(
            (descriptor.options ?? []).flatMap((option) => {
              const longFlag = option.flags.match(/--([a-z][a-z0-9-]*)/u)?.[1];
              return longFlag ? [longFlag.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())] : [];
            }),
          );
          expect(optionNames.has(rule.when.name), `${where}: selector names unknown option "${rule.when.name}"`).toBe(
            true,
          );
        }
      }

      for (const slot of contract.inputs) {
        for (const kind of Array.isArray(slot) ? slot : [slot]) {
          expect(inputKinds.has(kind as string), `${where}: bad input kind "${kind}"`).toBe(true);
        }
      }

      // Arity lives in `command` (`<required>` vs `[optional]`); the contract
      // declares kinds only. Slot count must still match the arity declared
      // there, or the two descriptions of the same signature can drift.
      const positionals = descriptor.command.match(/[<[][^>\]]+[>\]]/g) ?? [];
      expect(contract.inputs.length, `${where}: ${contract.inputs.length} slot(s) for "${descriptor.command}"`).toBe(
        positionals.length,
      );

      if (contract.scope !== undefined) {
        expect(scopes.has(contract.scope), `${where}: bad scope "${contract.scope}"`).toBe(true);
      }
      // A command with no positional target must say what it reads instead,
      // or an agent cannot tell repository-wide from diff-scoped.
      const hasOptionalTarget = positionals.some((positional) => positional.startsWith('['));
      if (contract.inputs.length === 0 || hasOptionalTarget) {
        expect(contract.scope, `${where}: no positional target, so scope is required`).toBeDefined();
      }

      for (const contrast of contract.contrasts ?? []) {
        expect(commandIds.has(contrast.command), `${where}: contrasts unknown command "${contrast.command}"`).toBe(
          true,
        );
        expect(contrast.command, `${where}: contrasts itself`).not.toBe(descriptor.id);
      }
    }
  });

  it('selects operation roles from parsed invocation values before execution', () => {
    const health = commandDescriptors.find((descriptor) => descriptor.id === 'health')!.agent!.operation;
    const bench = commandDescriptors.find((descriptor) => descriptor.id === 'bench')!.agent!.operation;
    const setup = commandDescriptors.find((descriptor) => descriptor.id === 'setup')!.agent!.operation;
    const suppress = commandDescriptors.find((descriptor) => descriptor.id === 'suppress')!.agent!.operation;
    const setupHooks = commandDescriptors.find((descriptor) => descriptor.id === 'setup-hooks')!.agent!.operation;
    const tla = commandDescriptors.find((descriptor) => descriptor.id === 'tla')!.agent!.operation;

    expect(resolveCommandOperationRole(health, { args: [], options: {} })).toBe('repository-observation');
    expect(resolveCommandOperationRole(health, { args: [], options: { writeBaseline: true } })).toBe('composite');
    expect(resolveCommandOperationRole(bench, { args: [], options: { profileOut: 'bench.cpuprofile' } })).toBe(
      'composite',
    );
    expect(resolveCommandOperationRole(setup, { args: [], options: {} })).toBe('composite');
    expect(resolveCommandOperationRole(suppress, { args: ['finding-id'], options: {} })).toBe('mutation');
    expect(resolveCommandOperationRole(setupHooks, { args: [], options: { dryRun: true } })).toBe('repository-preview');
    expect(resolveCommandOperationRole(tla, { args: ['scaffold', 'src/a.ts'], options: {} })).toBe('mutation');
    expect(resolveCommandOperationRole(tla, { args: ['verify', 'specs/A.tla'], options: {} })).toBe(
      'repository-observation',
    );
  });

  it('rejects a role that changes between pre-execution selection and result rendering', () => {
    expect(() =>
      runWithCommandOperationRole('mutation', () =>
        printJsonEnvelope('fan-in', ['symbolName'], { json: true }, { rows: [] }),
      ),
    ).toThrow(/changed operation role.*selected mutation.*rendered repository-observation/);
  });

  it('emits mutation results without inheriting repository observation context', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    runWithCommandOperationRole('mutation', () =>
      printJsonEnvelope('suppress', ['finding-id'], { json: true, compact: true }, { path: 'suppression.json' }),
    );

    const payload = JSON.parse(writes[0]!) as Record<string, unknown>;
    expect(payload.operationRole).toBe('mutation');
    expect(payload).not.toHaveProperty('evidenceContext');
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
      '--baseline',
      '--write-baseline',
      '--json',
      '--result-only',
      '--compact',
    ]);
    expect(docs.find((entry) => entry.id === 'setup')?.options).toEqual([
      '--guided',
      '--yes',
      '--git-hook',
      '--no-hooks',
      '--no-skills',
      '--no-parsers',
      '--install-missing',
      '--no-health',
      '--dossier-dir <path>',
      '--json',
      '--result-only',
      '--compact',
    ]);
    expect(docs.find((entry) => entry.id === 'setup-hooks')?.options).toEqual([
      '--shared',
      '--remove',
      '--force',
      '--dry-run',
      '--json',
      '--result-only',
      '--compact',
    ]);
    expect(docs.find((entry) => entry.id === 'suppress')?.options).toEqual([
      '--reason <text>',
      '--reason-code <code>',
      '--evidence <kind:referent>',
      '--check <check>',
      '--file <path>',
      '--expires-at <iso>',
      '--replace <revision>',
      '--json',
      '--result-only',
      '--compact',
    ]);
    expect(docs.find((entry) => entry.id === 'watch')?.options).toEqual([
      '--daemon',
      '--status',
      '--stop',
      '--debounce <ms>',
      '--cooldown <ms>',
      '--git-poll <ms>',
      '--idle-timeout <ms>',
      '--json',
      '--result-only',
      '--compact',
    ]);
    expect(docs.find((entry) => entry.id === 'diff-impact')?.options).toEqual([
      '--base <ref>',
      '--json',
      '--result-only',
      '--compact',
    ]);
    expect(docs.find((entry) => entry.id === 'diff-gate')?.options).toContain('--json');
    expect(docs.find((entry) => entry.id === 'plan-context')).toMatchObject({
      command: 'plan-context <target>',
      category: 'Planning',
    });
    const mixed = docs.filter((entry) => entry.claims.origin === 'mixed');
    expect(mixed.map((entry) => entry.id).sort()).toEqual([
      'architecture',
      'co-change',
      'diff-gate',
      'diff-impact',
      'health',
      'plan-context',
      'work-audit',
    ]);
    expect(mixed.every((entry) => (entry.claims.families?.length ?? 0) > 0)).toBe(true);
  });

  it('keeps public command references descriptor-backed', () => {
    const publicCommandIds = new Set(
      commandDescriptors.filter((descriptor) => !descriptor.hidden).map((descriptor) => descriptor.id),
    );
    const skillDocs = markdownFiles('skills');
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

  it('keeps public commands covered by bundled skills', () => {
    const publicCommandIds = commandDescriptors
      .filter((descriptor) => !descriptor.hidden)
      .map((descriptor) => descriptor.id);
    const skillMentionedCommands = readSkillMentionedCommands();

    expect(publicCommandIds.filter((command) => !skillMentionedCommands.has(command))).toEqual([]);
  });

  it('keeps the descriptor-owned skill command contract catalog generated', () => {
    const catalog = readFileSync(join(process.cwd(), 'skills/_shared/references/agent-contract-catalog.md'), 'utf8');

    expect(extractGeneratedAgentContractCatalog(catalog)).toBe(renderAgentContractCatalogMarkdown(commandDescriptors));
  });

  it('routes every consolidated workflow skill exactly once', () => {
    const router = readFileSync(join(process.cwd(), 'skills/scip-query/SKILL.md'), 'utf8');
    const routes = router.match(/## Routes\n([\s\S]*?)\n## Disambiguation/)?.[1] ?? '';
    const routed = [...routes.matchAll(/^\|[^|\n]+\|\s*`(scip-[a-z0-9-]+)`\s*\|/gm)].map((match) => match[1]!).sort();
    const expected = BUILTIN_SKILLS.filter((skill) => skill !== '_shared' && skill !== 'scip-query').sort();

    expect(routed).toEqual(expected);
    const preview = extractGeneratedRouterCommandPreview(router);
    for (const skill of expected) {
      expect(preview, `router preview missing ${skill}`).toContain(`| \`${skill}\` |`);
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
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    printJsonEnvelope('fan-in', ['symbolName', { json: true }], { json: true }, { rows: [] });

    const payload = JSON.parse(writes[0]!) as {
      command: string;
      args: unknown[];
      options: Record<string, unknown>;
      result: unknown;
    };
    expect(payload).toEqual({
      kind: 'scip-query-result',
      schemaVersion: 1,
      producer: { name: 'scip-query', version: expect.any(String) },
      resultSchemaVersion: 1,
      command: 'fan-in',
      operationRole: 'repository-observation',
      evidence: 'graph-fact',
      args: ['symbolName'],
      options: { json: true },
      result: { rows: [] },
      coverage: { complete: null, totalKnown: false, returned: 0 },
    });
  });

  it('counts descriptor-owned semantic units without summing unrelated arrays', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    printJsonEnvelope(
      'code',
      ['Thing'],
      { json: true },
      {
        matched: true,
        resolved: { symbol: 'exact', relativePath: 'src/a.ts' },
        otherMatches: [{ relativePath: 'src/b.ts' }, { relativePath: 'src/c.ts' }],
        totalMatches: 3,
        code: { relativePath: 'src/a.ts', startLine: 0, endLine: 1, source: 'x' },
      },
    );
    printJsonEnvelope('code', ['Missing'], { json: true }, { matched: false, suggestions: [], code: null });

    expect(JSON.parse(writes[0]!).coverage).toEqual({
      complete: true,
      totalKnown: true,
      returned: 1,
      total: 1,
      omitted: 0,
      resolution: { state: 'ambiguous', totalCandidates: 3 },
    });
    expect(JSON.parse(writes[1]!).coverage).toEqual({
      complete: true,
      totalKnown: true,
      returned: 0,
      total: 0,
      omitted: 0,
      resolution: { state: 'missing', totalCandidates: 0 },
    });
  });

  it('stamps descriptor evidence tiers into JSON envelopes', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    printJsonEnvelope('recent-duplicates', [], { json: true }, { rows: [] });
    printJsonEnvelope('diff-gate', [], { json: true }, { rows: [] });

    expect(JSON.parse(writes[0]!)).toMatchObject({ evidence: 'heuristic' });
    expect(JSON.parse(writes[1]!)).toMatchObject({ evidence: 'mixed' });
  });

  it('omits analysisBudget when uncapped, and stamps it at the envelope top level when supplied', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    printJsonEnvelope('recent-duplicates', [], { json: true }, { rows: [] });
    printJsonEnvelope(
      'recent-duplicates',
      [],
      { json: true },
      { rows: [] },
      { analysisBudget: { scanLimit: 2500, semanticEnrichment: false, reason: 'large index default budget' } },
    );

    const uncapped = JSON.parse(writes[0]!) as Record<string, unknown>;
    expect(Object.hasOwn(uncapped, 'analysisBudget')).toBe(false);

    const capped = JSON.parse(writes[1]!) as Record<string, unknown>;
    expect(capped['analysisBudget']).toEqual({
      scanLimit: 2500,
      semanticEnrichment: false,
      reason: 'large index default budget',
    });
    // Same field the sibling `result` key sits at — not nested inside result,
    // so it survives regardless of whether `result` is an array or object.
    expect(Object.keys(capped)).toEqual([
      'kind',
      'schemaVersion',
      'producer',
      'resultSchemaVersion',
      'command',
      'operationRole',
      'evidence',
      'analysisBudget',
      'args',
      'options',
      'result',
      'coverage',
    ]);
  });

  it('rejects internally inconsistent invocation coverage', () => {
    const dynamicCoverage = (value: unknown) => value as InvocationCoverage;

    expect(() =>
      validateInvocationCoverage(
        dynamicCoverage({ complete: false, totalKnown: true, returned: 3, total: 7, omitted: 3 }),
      ),
    ).toThrow(/total minus returned/);
    expect(() =>
      validateInvocationCoverage(
        dynamicCoverage({
          complete: false,
          totalKnown: true,
          returned: 3,
          total: 7,
          omitted: 4,
          omittedIdentities: ['one'],
        }),
      ),
    ).toThrow(/identity count/);
    expect(() =>
      validateInvocationCoverage(
        dynamicCoverage({ complete: true, totalKnown: true, returned: 3, total: 4, omitted: 1 }),
      ),
    ).toThrow(/total must equal returned/);
    expect(() =>
      validateInvocationCoverage(
        dynamicCoverage({
          complete: true,
          totalKnown: true,
          returned: 3,
          total: 3,
          omitted: 0,
          continuation: { cursor: 'next', indexGeneration: 'generation' },
        }),
      ),
    ).toThrow(/cannot provide a continuation/);
    expect(() =>
      validateInvocationCoverage(
        dynamicCoverage({
          complete: true,
          totalKnown: true,
          returned: 3,
          total: 3,
          omitted: 0,
          omittedIdentities: [],
        }),
      ),
    ).toThrow(/cannot name omitted identities/);
    expect(() =>
      validateInvocationCoverage(
        dynamicCoverage({ complete: false, totalKnown: true, returned: 3, total: 3, omitted: 0 }),
      ),
    ).toThrow(/must omit at least one/);
    expect(() =>
      validateInvocationCoverage(
        dynamicCoverage({
          complete: false,
          totalKnown: false,
          returned: 3,
          omittedIdentities: ['unknown'],
        }),
      ),
    ).toThrow(/cannot claim omitted identities/);
    expect(() =>
      validateInvocationCoverage(
        dynamicCoverage({
          complete: false,
          totalKnown: false,
          returned: 3,
          continuation: { cursor: '', indexGeneration: 'generation' },
        }),
      ),
    ).toThrow(/requires a cursor and index generation/);
  });

  it('accepts every valid invocation coverage state', () => {
    expect(() =>
      validateInvocationCoverage({ complete: true, totalKnown: true, returned: 3, total: 3, omitted: 0 }),
    ).not.toThrow();
    expect(() =>
      validateInvocationCoverage({
        complete: false,
        totalKnown: true,
        returned: 3,
        total: 7,
        omitted: 4,
        omittedIdentities: ['a', 'b', 'c', 'd'],
        continuation: { cursor: 'next', indexGeneration: 'generation' },
      }),
    ).not.toThrow();
    expect(() =>
      validateInvocationCoverage({
        complete: false,
        totalKnown: false,
        returned: 3,
        continuation: { cursor: 'next', indexGeneration: 'generation' },
      }),
    ).not.toThrow();
    expect(() => validateInvocationCoverage({ complete: null, totalKnown: false, returned: 0 })).not.toThrow();
  });

  it('treats --full as an unbounded result limit unless --limit is explicit', () => {
    expect(definedLimitOption({}, 'limit', 30)).toBe(30);
    expect(definedLimitOption({ full: true }, 'limit', 30)).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(definedLimitOption({ full: true }, 'limit', 30))).toBe(true);
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

    expect(definedLimitOption(defaultedOpts, 'limit', 30)).toBe(Number.MAX_SAFE_INTEGER);
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

  it('runs the visible health command in full mode only when --full is supplied', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/commands/command-handlers.ts'), 'utf8');

    expect(source).toContain('const analysis = await runIsolatedHealthReportWithEvidence({');
    expect(source).toMatch(
      /runIsolatedHealthReportWithEvidence\(\{\s*scope: stringOptionValue\(opts, 'scope'\),\s*full: booleanOptionValue\(opts, 'full'\),/,
    );
    expect(source).toMatch(
      /printJsonEnvelope\('health', \[\], opts, disclosedReport, \{\s*observationReceipt: analysis\.observationReceipt,/,
    );
    expect(source).toMatch(
      /printJsonEnvelope\('diff-impact', \[\], opts, analysis\.result, \{\s*observationReceipt: analysis\.observationReceipt,/,
    );
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
  const commands = new Set<string>();
  for (const match of content.matchAll(/`scip-query\s+([a-z][a-z0-9-]*)\b/g)) {
    commands.add(match[1]!);
  }
  let inFence = false;
  for (const line of content.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const match = line.match(/^\s*scip-query\s+([a-z][a-z0-9-]*)\b/);
    if (match?.[1]) commands.add(match[1]);
  }
  return [...commands];
}

function readSkillMentionedCommands(): Set<string> {
  const commands = new Set<string>();
  for (const path of markdownFiles('skills')) {
    const content = readFileSync(join(process.cwd(), path), 'utf8');
    for (const match of content.matchAll(/\bscip-query\s+([a-z][a-z0-9-]*)\b/g)) {
      commands.add(match[1]!);
    }
  }
  return commands;
}

function markdownFiles(relativeDir: string): string[] {
  return readdirSync(join(process.cwd(), relativeDir), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) return markdownFiles(relativePath);
    return entry.isFile() && entry.name.endsWith('.md') ? [relativePath] : [];
  });
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

function extractGeneratedAgentContractCatalog(content: string): string {
  const match = content.match(
    /<!-- BEGIN GENERATED AGENT CONTRACT CATALOG -->[\s\S]*?<!-- END GENERATED AGENT CONTRACT CATALOG -->/,
  );
  expect(match, 'agent contract catalog is missing its generated block').not.toBeNull();
  return match![0];
}

function extractGeneratedRouterCommandPreview(content: string): string {
  const match = content.match(
    /<!-- BEGIN GENERATED ROUTER COMMAND PREVIEW -->[\s\S]*?<!-- END GENERATED ROUTER COMMAND PREVIEW -->/,
  );
  expect(match, 'router skill is missing its generated command preview').not.toBeNull();
  return match![0];
}
