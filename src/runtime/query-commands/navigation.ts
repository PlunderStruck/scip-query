import * as queries from '../../queries/index.js';
import type { CommandDescriptor, InvocationCoverage } from '../command-kit/command-descriptor-types.js';
import {
  agentContract,
  compactOption,
  doc,
  option,
  parseInteger,
  withJsonOption,
} from '../command-kit/command-spec-builders.js';
import {
  booleanOptionValue,
  budgetedDbCommand,
  budgetedListCommand,
  dbCommand,
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

const handleMethods = dbCommand(({ db, args, opts }) => {
  const className = stringArg(args, 0);
  const result = queries.resolveMethods(db, { className });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('methods', args, opts, result, {
      coverage: methodsInvocationCoverage(result),
    });
    if (result.kind !== 'matched') process.exitCode = 1;
    return;
  }
  if (result.kind === 'matched') {
    render.list(result.methods, (method) => `  ${displayRange(method.startLine, method.endLine)}  ${method.name}`);
    return;
  }
  render.empty(methodsResolutionFailureMessage(result));
  process.exitCode = 1;
});

function methodsInvocationCoverage(result: queries.MethodsResolution): InvocationCoverage {
  const returned = result.kind === 'matched' ? result.methods.length : 0;
  const resolution: NonNullable<InvocationCoverage['resolution']> =
    result.kind === 'matched'
      ? { state: 'exact', totalCandidates: 1 }
      : result.kind === 'missing'
        ? { state: 'missing', totalCandidates: 0 }
        : { state: 'ambiguous', totalCandidates: result.total };
  return {
    complete: true,
    totalKnown: true,
    returned,
    total: returned,
    omitted: 0,
    resolution,
  };
}

function methodsResolutionFailureMessage(result: Exclude<queries.MethodsResolution, { kind: 'matched' }>): string {
  if (result.kind === 'missing') {
    const base = `No class definition matched '${result.query}'.`;
    return result.suggestions.length > 0 ? `${base} Suggestions: ${result.suggestions.join(', ')}` : base;
  }
  const candidates = result.candidates
    .map((candidate) => `${candidate.relativePath}:${displayLine(candidate.startLine)}`)
    .join(', ');
  return (
    `Class '${result.query}' is ambiguous across ${result.total} definitions (${candidates}). ` +
    'Qualify it with a path or exact SCIP symbol identity.'
  );
}

export const navigationQueryCommandDescriptors: CommandDescriptor[] = [
  ...directNavigationQueryCommandDescriptors,
  listQueryCommand({
    id: 'files',
    command: 'files <pattern>',
    description: 'Find files matching a pattern',
    agent: agentContract(
      'Which indexed files match this text pattern?',
      'matching file paths',
      ['pattern'],
      'complete',
    ),
    docs: doc('Navigation', ['scip-query files auth']),
    query: ({ db, args }) => queries.files(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  {
    id: 'methods',
    command: 'methods <className>',
    description: 'List methods of one exactly resolved class; ambiguity and missing targets fail explicitly',
    options: withJsonOption(),
    agent: {
      ...agentContract('Which methods belong to this class?', 'method names and line ranges', ['symbol'], 'complete'),
      resultUnits: { kind: 'field', field: 'methods' },
    },
    docs: doc('Navigation'),
    renderShape: 'list',
    handler: handleMethods,
  },
  budgetedSectionedQueryCommand({
    id: 'trace',
    command: 'trace <symbol>',
    description: 'Trace a symbol: definition + all references',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes'), compactOption()],
    budget: 'semantic',
    agent: {
      answers: ['Where is this symbol defined, and everywhere is it referenced?'],
      returns: ['definition sites with source and signature', 'referencing files with line numbers'],
      inputs: ['symbol'],
      coverage: 'bounded',
      contrasts: [
        {
          command: 'refs',
          distinction: 'refs returns reference sites only; trace adds the definition and its source.',
        },
        {
          command: 'call-graph',
          distinction: 'trace lists reference sites flat; call-graph separates incoming callers from outgoing callees.',
        },
      ],
    },
    docs: doc('Navigation', ['scip-query trace parseSymbol']),
    query: ({ db, args, budget }) => queries.trace(db, stringArg(args, 0), { semantic: budget.semantic }),
    emptyMessage: (result, { db, args }) =>
      result.definitions.length === 0 && result.referencedBy.length === 0
        ? symbolResolutionEmptyMessage(db, stringArg(args, 0), 'No trace rows found.')
        : undefined,
    before: (_result, { db, args }) => symbolResolutionBefore(db, stringArg(args, 0)),
    toJson: (result, { db, args }) => ({ ...symbolResolutionJson(db, stringArg(args, 0)), ...result }),
    coverage: (result, { budget }) => {
      const returned = result.definitions.length + result.referencedBy.length;
      return budget.analysisBudget
        ? { complete: false, totalKnown: false, returned }
        : { complete: true, totalKnown: true, returned, total: returned, omitted: 0 };
    },
    agentResult: (result) => ({
      definitionCount: result.definitions.length,
      referenceCount: result.referencedBy.length,
      definitionIdentities: result.definitions.map(
        (definition) => `${definition.relativePath}:${definition.startLine}-${definition.endLine}`,
      ),
      referenceIdentities: result.referencedBy.map((reference) => `${reference.relativePath}:${reference.line}`),
    }),
    sections: traceSections,
  }),
  listQueryCommand({
    id: 'deps',
    command: 'deps <file>',
    description: 'Files this file depends on (internal)',
    agent: agentContract(
      'Which internal files does this file depend on?',
      'dependency file paths',
      ['file'],
      'complete',
    ),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.deps(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  listQueryCommand({
    id: 'rdeps',
    command: 'rdeps <file>',
    description: 'Files that depend on this file/module',
    agent: agentContract(
      'Which internal files depend on this file?',
      'reverse-dependency file paths',
      ['file'],
      'complete',
    ),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.rdeps(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  sectionedQueryCommand({
    id: 'system',
    command: 'system <module>',
    description: 'Full module map: files, symbols, deps in/out',
    options: [compactOption()],
    agent: {
      answers: ['What is in this module?', 'What does this module depend on, and what depends on it?'],
      returns: [
        'module file paths',
        'exported symbols with line ranges',
        'internal dependencies',
        'reverse dependencies',
      ],
      inputs: ['module'],
      // No budget and no row cap: every section is the whole set.
      coverage: 'complete',
      contrasts: [
        {
          command: 'surface',
          distinction: 'system lists everything the module exports; surface lists only what consumers actually use.',
        },
        { command: 'outline', distinction: 'system is module-scoped; outline covers a single file.' },
      ],
    },
    docs: doc('Navigation', ['scip-query system queries']),
    query: ({ db, args }) => queries.system(db, stringArg(args, 0)),
    coverage: (result) => {
      const returned =
        result.files.length + result.symbols.length + result.dependsOn.length + result.dependedOnBy.length;
      return { complete: true, totalKnown: true, returned, total: returned, omitted: 0 };
    },
    agentResult: (result) => ({
      counts: {
        files: result.files.length,
        symbols: result.symbols.length,
        dependencies: result.dependsOn.length,
        consumers: result.dependedOnBy.length,
      },
      files: result.files,
      dependsOn: result.dependsOn,
      dependedOnBy: result.dependedOnBy,
      detail: {
        location: 'result',
        symbolUnits: 'result.symbols contains every exported symbol with its line range',
      },
    }),
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
    agent: agentContract(
      'Which exported symbols do external consumers actually use?',
      'consumer paths and consumed symbol identities',
      ['module'],
      'complete',
    ),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.surface(db, stringArg(args, 0)),
    format: (r) => `  ${r.consumer} → ${r.shortName}`,
  }),
  {
    id: 'imports',
    command: 'imports <file>',
    description: 'What symbols does this file import?',
    agent: agentContract(
      'Which symbols does this file import?',
      'imported symbol identities and source files',
      ['file'],
      'bounded',
    ),
    options: withJsonOption([option('--full', 'Run unbounded semantic analysis on large indexes')]),
    budget: 'semantic',
    renderShape: 'list',
    docs: doc('Navigation'),
    handler: handleImports,
  },
  listQueryCommand({
    id: 'imported-by',
    command: 'imported-by <symbol>',
    description: 'Which files import this symbol?',
    agent: agentContract('Which files import this symbol?', 'importing file paths', ['symbol'], 'complete'),
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.importedBy(db, stringArg(args, 0)),
    format: (r) => `  ${r.fromFile}`,
  }),
  listQueryCommand({
    id: 'members',
    command: 'members <symbol>',
    description: 'All children of a symbol (methods, fields, nested types)',
    agent: agentContract(
      'Which members or nested symbols belong to this symbol?',
      'child symbol identities, kinds, and ranges',
      ['symbol'],
      'complete',
    ),
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
    agent: agentContract(
      'Which symbols have this SCIP kind?',
      'symbol identities, kinds, files, and ranges',
      ['pattern'],
      'bounded',
    ),
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
    agent: agentContract(
      'How many indexed symbols exist for each kind?',
      'symbol-kind counts',
      [],
      'complete',
      'repository',
    ),
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
    agent: agentContract(
      'What lexical ownership chain contains this symbol?',
      'ancestor symbol identities and depths',
      ['symbol'],
      'complete',
    ),
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
    agent: agentContract(
      'What defines, uses, produces, and consumes this symbol?',
      'definition sites, usage sites, producer symbols, and consumer symbols',
      ['symbol'],
      'bounded',
    ),
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
    agent: agentContract(
      'What transitively affects this symbol, or what does it affect?',
      'connected symbols with relationship and depth',
      ['symbol'],
      'bounded',
    ),
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
