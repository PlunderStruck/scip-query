import * as queries from '../../queries/index.js';
import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';
import { doc, option, parseInteger, withJsonOption } from '../command-kit/command-spec-builders.js';
import {
  booleanOptionValue,
  budgetedDbCommand,
  budgetedListCommand,
  definedLimitOption,
  definedNumberOption,
  printJsonEnvelope,
  stringArg,
  stringOptionValue,
} from '../command-kit/command-execution.js';
import {
  budgetedSectionedQueryCommand,
  listQueryCommand,
  sectionedQueryCommand,
  tableQueryCommand,
} from '../command-kit/query-command-builders.js';
import { displayLine, displayPathRange, displayRange, render } from '../render.js';
import type { ReportSection } from '../render.js';
import {
  symbolResolutionJson,
  symbolResolutionBefore,
  symbolResolutionEmptyMessage,
  withSymbolResolutionJson,
} from './symbol-resolution.js';
import { directNavigationQueryCommandDescriptors } from './direct-navigation.js';

function traceSections(result: ReturnType<typeof queries.trace>): ReportSection[] {
  const definitionRows: string[] = [];
  for (const d of result.definitions) {
    const sig = d.signature ? `  — ${d.signature}` : '';
    definitionRows.push(`  ${displayPathRange(d.relativePath, d.startLine, d.endLine)}${sig}`);
    if (d.source) {
      definitionRows.push(
        d.source
          .split('\n')
          .map((line, index) => `    ${displayLine(d.startLine + index)}  ${line}`)
          .join('\n'),
      );
    }
  }

  const refRows: string[] = [];
  let prevFile = '';
  for (const ref of result.referencedBy) {
    if (ref.relativePath !== prevFile) {
      if (prevFile) refRows.push('');
      refRows.push(`  ${ref.relativePath}`);
      prevFile = ref.relativePath;
    }
    refRows.push(`    line ${displayLine(ref.line)}  in ${ref.enclosingShort}`);
  }

  return [
    { title: 'DEFINITION', rows: definitionRows },
    { title: 'REFERENCED BY', rows: refRows },
  ];
}

const handleImports = budgetedListCommand('imports', {
  query: ({ db, args, budget }) => queries.imports(db, stringArg(args, 0), { semantic: budget.semantic }),
  format: (r) => `  ${r.shortName}  ← ${r.fromFile}`,
  emptyMessage: () => 'No imports found (indexer may not emit role=2 for this language).',
});

const handleDataflow = budgetedDbCommand('dataflow', ({ db, args, opts, budget }) => {
  const query = stringArg(args, 0);
  const result = queries.dataflow(db, query, { semantic: budget.semantic });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('dataflow', args, opts, withSymbolResolutionJson(db, query, result, 'dataflow'), {
      analysisBudget: budget.analysisBudget,
    });
    return;
  }
  if (!result) return render.empty(symbolResolutionEmptyMessage(db, query, 'No dataflow found.'));
  symbolResolutionBefore(db, query);
  console.log(`${result.shortName}  (${result.relativePath})\n`);
  if (result.definitionSites.length > 0) {
    console.log('  ═══ DEFINED AT ═══');
    for (const s of result.definitionSites) console.log(`    ${s.file}:${displayLine(s.line)}`);
  }
  if (result.usageSites.length > 0) {
    console.log('\n  ═══ USED AT ═══');
    for (const s of result.usageSites) console.log(`    ${s.file}:${displayLine(s.line)}  in ${s.enclosingShort}`);
  }
  if (result.producers.length > 0) {
    console.log('\n  ═══ PRODUCERS (feeds into this) ═══');
    for (const p of result.producers) console.log(`    ${p.file}  ${p.shortName}`);
  }
  if (result.consumers.length > 0) {
    console.log('\n  ═══ CONSUMERS (this feeds into) ═══');
    for (const c of result.consumers) console.log(`    ${c.file}  ${c.shortName}`);
  }
});

const handleSlice = budgetedDbCommand('slice', ({ db, args, opts, budget }) => {
  const query = stringArg(args, 0);
  const direction = booleanOptionValue(opts, 'forward') ? 'forward' : 'backward';
  const result = queries.slice(db, query, {
    direction,
    maxDepth: definedNumberOption(opts, 'depth', 3),
    semantic: budget.semantic,
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('slice', args, opts, withSymbolResolutionJson(db, query, result, 'slice'), {
      analysisBudget: budget.analysisBudget,
    });
    return;
  }
  if (!result) return render.empty(symbolResolutionEmptyMessage(db, query, 'No slice found.'));
  symbolResolutionBefore(db, query);
  console.log(`${result.direction} slice of ${result.shortName}\n`);
  if (result.connectedSymbols.length === 0) {
    console.log('  No connected symbols found.');
    return;
  }
  render.list(result.connectedSymbols, (s) => `  ${s.file}  ${s.shortName}\n    ${s.relationship}`);
  console.log(`\n${result.connectedSymbols.length} connected symbol(s).`);
});

export const navigationQueryCommandDescriptors: CommandDescriptor[] = [
  ...directNavigationQueryCommandDescriptors,
  listQueryCommand({
    id: 'files',
    command: 'files <pattern>',
    description: 'Find files matching a pattern',
    docs: doc('Navigation', ['scip-query files auth']),
    query: ({ db, args }) => queries.files(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  listQueryCommand({
    id: 'methods',
    command: 'methods <className>',
    description: 'List methods of a class (with line ranges)',
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.methods(db, stringArg(args, 0)),
    format: (r) => `  ${displayRange(r.startLine, r.endLine)}  ${r.name}`,
  }),
  budgetedSectionedQueryCommand({
    id: 'trace',
    command: 'trace <symbol>',
    description: 'Trace a symbol: definition + all references',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    docs: doc('Navigation', ['scip-query trace parseSymbol']),
    query: ({ db, args, budget }) => queries.trace(db, stringArg(args, 0), { semantic: budget.semantic }),
    emptyMessage: (result, { db, args }) =>
      result.definitions.length === 0 && result.referencedBy.length === 0
        ? symbolResolutionEmptyMessage(db, stringArg(args, 0), 'No trace rows found.')
        : undefined,
    before: (_result, { db, args }) => symbolResolutionBefore(db, stringArg(args, 0)),
    toJson: (result, { db, args }) => ({ ...symbolResolutionJson(db, stringArg(args, 0)), ...result }),
    sections: traceSections,
  }),
  listQueryCommand({
    id: 'deps',
    command: 'deps <file>',
    description: 'Files this file depends on (internal)',
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.deps(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  listQueryCommand({
    id: 'rdeps',
    command: 'rdeps <file>',
    description: 'Files that depend on this file/module',
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.rdeps(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  sectionedQueryCommand({
    id: 'system',
    command: 'system <module>',
    description: 'Full module map: files, symbols, deps in/out',
    docs: doc('Navigation', ['scip-query system queries']),
    query: ({ db, args }) => queries.system(db, stringArg(args, 0)),
    sections: (result) => [
      { title: 'FILES', rows: result.files },
      {
        title: 'EXPORTED SYMBOLS',
        rows: result.symbols.map((s) => `  ${displayRange(s.startLine, s.endLine)}  ${s.shortName}`),
      },
      { title: 'DEPENDS ON (internal)', rows: result.dependsOn.map((d) => `  ${d}`) },
      { title: 'DEPENDED ON BY', rows: result.dependedOnBy.map((d) => `  ${d}`) },
    ],
  }),
  listQueryCommand({
    id: 'surface',
    command: 'surface <module>',
    description: 'What symbols consumers actually use from this module',
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.surface(db, stringArg(args, 0)),
    format: (r) => `  ${r.consumer} → ${r.shortName}`,
  }),
  {
    id: 'imports',
    command: 'imports <file>',
    description: 'What symbols does this file import?',
    options: [
      option('--full', 'Run unbounded semantic analysis on large indexes'),
      option('--json', 'Output as JSON for programmatic consumption'),
    ],
    budget: 'semantic',
    renderShape: 'list',
    docs: doc('Navigation'),
    handler: handleImports,
  },
  listQueryCommand({
    id: 'imported-by',
    command: 'imported-by <symbol>',
    description: 'Which files import this symbol?',
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.importedBy(db, stringArg(args, 0)),
    format: (r) => `  ${r.fromFile}`,
  }),
  listQueryCommand({
    id: 'members',
    command: 'members <symbol>',
    description: 'All children of a symbol (methods, fields, nested types)',
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.members(db, stringArg(args, 0)),
    format: (r) => `  ${displayRange(r.startLine, r.endLine)}  [${r.kind}]  ${r.shortName}`,
    before: (_rows, { db, args }) => symbolResolutionBefore(db, stringArg(args, 0)),
    emptyMessage: ({ db, args }) => symbolResolutionEmptyMessage(db, stringArg(args, 0), 'No child symbols found.'),
    toJson: (rows, { db, args }) => withSymbolResolutionJson(db, stringArg(args, 0), rows, 'members'),
  }),
  listQueryCommand({
    id: 'by-kind',
    command: 'by-kind <kind>',
    description: 'Find symbols by SCIP kind (class, interface, enum, function, etc.)',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('-n, --limit <n>', 'Number of results', parseInteger, 100),
      option('--full', 'Run unbounded analysis on large indexes'),
    ],
    docs: doc('Navigation'),
    query: ({ db, args, opts }) =>
      queries.byKind(db, stringArg(args, 0), {
        scope: stringOptionValue(opts, 'scope'),
        limit: definedLimitOption(opts, 'limit', 100),
      }),
    format: (r) => `  ${displayPathRange(r.relativePath, r.startLine, r.endLine)}  [${r.kindName}]  ${r.shortName}`,
    emptyMessage: ({ args }) =>
      `No symbols found for kind "${stringArg(args, 0)}". Use "kind-counts" to see available kinds.`,
    after: (rows) => console.log(`\n${rows.length} symbol(s)`),
  }),
  tableQueryCommand({
    id: 'kind-counts',
    command: 'kind-counts',
    description: 'Histogram of symbol kinds in the codebase',
    options: [option('-s, --scope <path>', 'Limit to files matching path')],
    docs: doc('Navigation'),
    headers: ['count', 'kind'],
    query: ({ db, opts }) => queries.kindCounts(db, { scope: stringOptionValue(opts, 'scope') }),
    format: (r) => `  ${String(r.count).padStart(5)}  ${r.kindName} (${r.kind})`,
  }),
  listQueryCommand({
    id: 'hierarchy',
    command: 'hierarchy <symbol>',
    description: "Show a symbol's ancestry chain (method → class → module)",
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.hierarchy(db, stringArg(args, 0)),
    format: (node) => `${'  '.repeat(node.depth)}${node.shortName}`,
    before: (_rows, { db, args }) => symbolResolutionBefore(db, stringArg(args, 0)),
    emptyMessage: ({ db, args }) => symbolResolutionEmptyMessage(db, stringArg(args, 0), 'Symbol not found.'),
    toJson: (rows, { db, args }) => withSymbolResolutionJson(db, stringArg(args, 0), rows, 'hierarchy'),
  }),
  {
    id: 'dataflow',
    command: 'dataflow <symbol>',
    description: 'Reference-level dataflow: definition sites, usage sites, producers, consumers',
    options: withJsonOption([option('--full', 'Run unbounded semantic analysis on large indexes')]),
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleDataflow,
  },
  {
    id: 'slice',
    command: 'slice <symbol>',
    description: 'Reference-level program slice: what affects this (backward) or what this affects (forward)',
    options: withJsonOption([
      option('--forward', 'Forward slice (what does this affect). Default is backward.'),
      option('--depth <n>', 'Max transitive depth for backward slice', parseInteger, 3),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleSlice,
  },
];
