import {
  sourceSystemReport,
  type SourceModuleEvidence,
  type SourceSystemReport,
} from '../../queries/service-queries.js';
import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';
import {
  booleanOptionValue,
  numberOptionValue,
  printJsonEnvelope,
  splitCommanderActionArgs,
  stringArg,
} from '../command-kit/command-execution.js';
import {
  parsePositiveInteger,
  fieldClaimFamily,
  fixedClaimFamily,
  mixedClaimContract,
  withJsonOption,
} from '../command-kit/command-spec-builders.js';
import { resolveProjectRoot } from '../cli-context.js';

/** Preserve indexed system consumers while adding an explicit current-source path before any database access. */
export function withSourceSystem(descriptor: CommandDescriptor): CommandDescriptor {
  return {
    ...descriptor,
    command: 'system [module]',
    description:
      'Module files and dependencies; --source adds a first-use inventory, exports, policy and findings without an index',
    agent: descriptor.agent
      ? {
          ...descriptor.agent,
          coverage: 'bounded',
          scope: 'repository',
          answers: [
            ...descriptor.agent.answers,
            'With --source, which current module groups, imports, export declarations, policy constraints and candidates are observed without an index?',
          ],
          returns: [
            ...descriptor.agent.returns,
            'current-source module inventory including groups without findings; explicit coverage and grammar-level export declarations',
          ],
        }
      : undefined,
    claims: mixedClaimContract(
      ['index-generation', 'live-workspace'],
      [
        fixedClaimFamily('indexed-symbols', 'symbols[]', 'compiler-graph'),
        fixedClaimFamily('indexed-dependencies', 'dependsOn[]', 'compiler-graph'),
        fixedClaimFamily('indexed-consumers', 'dependedOnBy[]', 'compiler-graph'),
        fixedClaimFamily('source-modules', 'modules[]', 'repository-source'),
        fixedClaimFamily('source-dependencies', 'edges[]', 'repository-source'),
        fixedClaimFamily('source-imports', 'imports[]', 'repository-source'),
        fieldClaimFamily('source-findings', 'findings[]', 'evidence', {
          derived: 'repository-source',
          candidate: 'heuristic',
        }),
        fixedClaimFamily('source-coverage', 'coverage', 'repository-source'),
      ],
    ),
    options: withJsonOption([
      ...(descriptor.options ?? []),
      {
        flags: '--source',
        description: 'Inspect current TS/JS module evidence; omit module for a repository inventory',
      },
      { flags: '--include-tests', description: 'Include tests, fixtures and benchmarks in source mode' },
      { flags: '--include-references', description: 'Include reference/vendor source in source mode' },
      { flags: '--include-generated', description: 'Include generated source in source mode' },
      { flags: '--max-files <n>', description: 'Source file limit (default: 10000)', parser: parsePositiveInteger },
      {
        flags: '-n, --limit <n>',
        description: 'Source groups and relationship rows to display (default: 20)',
        parser: parsePositiveInteger,
      },
      { flags: '--full', description: 'Display all source groups, export declarations, imports and findings' },
    ]),
    handler: (...rawArgs) => {
      const { args, opts } = splitCommanderActionArgs(rawArgs);
      if (!booleanOptionValue(opts, 'source')) {
        if (!args[0])
          throw new Error(
            'Choose system <module> for indexed evidence or system --source for a current-source inventory.',
          );
        for (const name of ['includeTests', 'includeReferences', 'includeGenerated', 'maxFiles', 'limit', 'full'])
          if (opts[name] !== undefined && opts[name] !== false) throw new Error(`${name} requires system --source.`);
        return descriptor.handler(...rawArgs);
      }
      runSourceSystem(args, opts);
    },
  };
}

function runSourceSystem(args: readonly unknown[], opts: Readonly<Record<string, unknown>>): void {
  const selector = typeof args[0] === 'string' ? stringArg(args, 0) : undefined;
  const report = sourceSystemReport(resolveProjectRoot(), selector, {
    includeTests: booleanOptionValue(opts, 'includeTests'),
    includeReferences: booleanOptionValue(opts, 'includeReferences'),
    includeGenerated: booleanOptionValue(opts, 'includeGenerated'),
    maxFiles: numberOptionValue(opts, 'maxFiles'),
  });
  if (booleanOptionValue(opts, 'json'))
    printJsonEnvelope('system', selector ? [selector] : [], opts, report, {
      coverage:
        report.coverage.status === 'incomplete'
          ? { complete: false, totalKnown: false, returned: 1 }
          : { complete: true, totalKnown: true, returned: 1, total: 1, omitted: 0 },
    });
  else {
    const recovery = sourceSystemRecovery(selector, opts);
    renderSourceSystem(
      report,
      booleanOptionValue(opts, 'full') ? Infinity : (numberOptionValue(opts, 'limit') ?? 20),
      recovery,
      (id) => sourceSystemRecovery(id, opts),
    );
  }
}

function quoteArgument(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function sourceSystemRecovery(selector: string | undefined, opts: Readonly<Record<string, unknown>>): string {
  const flags = ['--source'];
  if (selector) flags.push(quoteArgument(selector));
  for (const [key, flag] of [
    ['includeTests', '--include-tests'],
    ['includeReferences', '--include-references'],
    ['includeGenerated', '--include-generated'],
  ] as const)
    if (booleanOptionValue(opts, key)) flags.push(flag);
  const maxFiles = numberOptionValue(opts, 'maxFiles');
  if (maxFiles !== undefined) flags.push('--max-files', String(maxFiles));
  return 'scip-query system ' + flags.join(' ');
}

export function renderSourceSystem(
  report: SourceSystemReport,
  limit: number,
  recovery: string,
  groupRecovery: (id: string) => string,
): void {
  console.log(
    `Module evidence — current source: ${report.coverage.capturedFiles}/${report.coverage.eligibleFiles} eligible files; ${report.modules.length}/${report.totalModules} groups selected.`,
  );
  console.log(
    `Coverage: ${report.coverage.status}; ${report.coverage.excludedFiles} excluded files. Groups include files without findings; responsibility remains unverified.`,
  );
  console.log(
    `Exclusions: ${
      Object.entries(report.coverage.exclusions)
        .map(([kind, count]) => `${kind} ${count}`)
        .join('; ') || 'none'
    }.`,
  );
  const policy = report.architecture;
  console.log(
    policy.configured
      ? `Architecture: ${policy.coverage.mappedFiles}/${policy.coverage.totalFiles} files mapped; ${policy.policyCoverage.declaredRows}/${policy.policyCoverage.totalBoundaries} dependency rows declared. Missing rows: ${policy.policyCoverage.missingRows.join(', ') || 'none'}.`
      : 'Architecture: no configured boundaries or dependency policy; directory groups are provisional.',
  );
  console.log(`\nModule groups (${Math.min(limit, report.modules.length)}/${report.modules.length} shown):`);
  for (const group of report.modules.slice(0, limit)) renderSourceModule(group, report.imports, limit, groupRecovery);
  renderModuleEdges(report, limit);
  renderModuleFindings(report, limit);
  console.log(`\nRecovery for every selected row: ${recovery} --full`);
  console.log(
    'For exhaustive machine output add --json --json-output <path>. --full removes display limits, not source scan limits.',
  );
  for (const problem of report.coverage.problems) console.log(`Unresolved: ${problem}`);
  for (const unresolved of report.coverage.dependencies.unresolved.slice(0, limit))
    console.log(`Unresolved import: ${importLabel(unresolved)}`);
  for (const limitation of report.coverage.limits) console.log(`Limit: ${limitation}`);
}

function renderModuleEdges(report: SourceSystemReport, limit: number): void {
  console.log(
    `\nCross-group production dependencies (${Math.min(limit, report.edges.length)}/${report.edges.length} shown):`,
  );
  for (const edge of report.edges.slice(0, limit)) {
    console.log(`  ${edge.from} -> ${edge.to}: ${edge.importIds.length} import sites`);
    for (const id of edge.importIds.slice(0, limit === Infinity ? Infinity : 2))
      console.log(`    ${importLabel(report.imports[id]!)}`);
  }
}

function renderModuleFindings(report: SourceSystemReport, limit: number): void {
  console.log(
    `\nRelated findings (${Math.min(limit, report.findings.length)}/${report.findings.length} shown; candidates require review):`,
  );
  for (const finding of report.findings.slice(0, limit)) {
    console.log(`  [${finding.evidence}] ${finding.rule}: ${finding.summary}`);
    if (limit === Infinity) for (const site of finding.sites) console.log(`    ${site.file}:${site.line}`);
  }
}

function renderSourceModule(
  group: SourceModuleEvidence,
  imports: SourceSystemReport['imports'],
  limit: number,
  recovery: (id: string) => string,
): void {
  const detailLimit = limit === Infinity ? Infinity : 3;
  console.log(
    `  ${group.id} [${group.basis}]: ${group.files.length} files; ${group.exports.length} export declarations; ${group.dependencies.length} production dependency files; ${group.consumers.length} production consumer files; ${group.findingIds.length} findings.`,
  );
  console.log(
    `    Files (${Math.min(detailLimit, group.files.length)}/${group.files.length}): ${group.files.slice(0, detailLimit).join(', ')}`,
  );
  console.log(
    `    Source exports (${Math.min(detailLimit, group.exports.length)}/${group.exports.length}; symbol consumers require indexed surface):`,
  );
  for (const item of group.exports.slice(0, detailLimit))
    console.log(
      `      ${item.file}:${item.startLine} ${item.syntax}: ${item.names.join(', ')}${item.from ? ` from ${JSON.stringify(item.from)}` : ''}`,
    );
  console.log(`    Imports (${Math.min(detailLimit, group.importIds.length)}/${group.importIds.length}):`);
  for (const id of group.importIds.slice(0, detailLimit)) console.log(`      ${importLabel(imports[id]!)}`);
  console.log(
    `    Incoming imports (${Math.min(detailLimit, group.incomingImportIds.length)}/${group.incomingImportIds.length}):`,
  );
  for (const id of group.incomingImportIds.slice(0, detailLimit)) console.log(`      ${importLabel(imports[id]!)}`);
  console.log(`    Group: ${recovery(group.id)} --full`);
}

function importLabel(item: SourceSystemReport['imports'][number]): string {
  return `${item.file}:${item.line} -> ${item.target ?? item.specifier} [${item.syntax}; ${item.kind}; ${item.role}; ${item.resolution}]`;
}
