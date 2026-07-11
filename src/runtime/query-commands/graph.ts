import * as queries from '../../queries/index.js';
import type { CommandDescriptor } from '../commands/command-descriptor-types.js';
import { doc, option, parseInteger, withJsonOption } from '../commands/command-spec-builders.js';
import {
  budgetedTableCommand,
  booleanOptionValue,
  dbCommand,
  definedLimitOption,
  definedNumberOption,
  optionalStringArg,
  printJsonEnvelope,
  reportCommand,
  stringOptionValue,
} from '../commands/command-execution.js';
import { budgetedSectionedQueryCommand, tableQueryCommand } from '../commands/query-command-builders.js';
import { render } from '../render.js';
import { symbolResolutionBefore, symbolResolutionEmptyMessage, withSymbolResolutionJson } from './symbol-resolution.js';

const handleBottlenecks = budgetedTableCommand('bottlenecks', {
  headers: ['tier', 'risk', 'score', 'fan-in', 'fan-out', 'symbol'],
  query: ({ db, opts, budget }) =>
    queries.bottlenecks(db, {
      limit: definedLimitOption(opts, 'limit', 20),
      scope: stringOptionValue(opts, 'scope'),
      minFanIn: definedNumberOption(opts, 'minFanIn', 2),
      minFanOut: definedNumberOption(opts, 'minFanOut', 2),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    }),
  format: (r) =>
    `  ${r.actionTier.padEnd(6)}  ${r.riskKind.padEnd(20)}  ${String(r.score).padStart(5)}  ${String(r.fanIn).padStart(6)}  ` +
    `${String(r.fanOut).padStart(7)}  ${r.shortName}`,
  emptyMessage: () => 'No bottlenecks found.',
});

const handleFanIn = dbCommand(({ db, args, opts }) => {
  const symbol = optionalStringArg(args, 0);
  const limit = definedLimitOption(opts, 'limit', 30);
  if (symbol) {
    const results = queries.fanIn(db, symbol);
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('fan-in', args, opts, { mode: 'symbol', symbol, rows: results });
      return;
    }
    if (results.length === 0) return render.empty(`No fan-in for ${symbol}.`);
    render.list(results, (r) => `  ${String(r.count).padStart(4)} files  ${r.name}`);
    return;
  }
  const results = queries.topFanIn(db, { limit, scope: stringOptionValue(opts, 'scope') });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('fan-in', args, opts, { mode: 'top', rows: results });
    return;
  }
  const nameCounts = new Map<string, number>();
  for (const row of results) nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1);
  const duplicateNames = new Set([...nameCounts].filter(([, count]) => count > 1).map(([name]) => name));
  render.table(
    ['files', 'symbol'],
    results.map(
      (r) => `  ${String(r.count).padStart(5)}  ${r.name}${duplicateNames.has(r.name) ? `  [${r.definedIn}]` : ''}`,
    ),
  );
});

const handleFanOut = dbCommand(({ db, args, opts }) => {
  const file = optionalStringArg(args, 0);
  const limit = definedLimitOption(opts, 'limit', 30);
  if (file) {
    const results = queries.fanOut(db, file);
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('fan-out', args, opts, { mode: 'file', file, rows: results });
      return;
    }
    if (results.length === 0) return render.empty(`No fan-out for ${file}.`);
    render.list(results, (r) => `  ${String(r.count).padStart(4)} symbols  ${r.name}`);
    return;
  }
  const results = queries.topFanOut(db, { limit, scope: stringOptionValue(opts, 'scope') });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('fan-out', args, opts, { mode: 'top', rows: results });
    return;
  }
  render.table(
    ['symbols', 'file'],
    results.map((r) => `  ${String(r.count).padStart(7)}  ${r.name}`),
  );
});

const handleCoupling = dbCommand(({ db, args, opts }) => {
  const file1 = optionalStringArg(args, 0);
  const file2 = optionalStringArg(args, 1);
  const limit = definedLimitOption(opts, 'limit', 20);
  if (file1 && file2) {
    const result = queries.coupling(db, file1, file2);
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('coupling', args, opts, { mode: 'pair', result });
      return;
    }
    console.log(`${result.file1} ↔ ${result.file2}: ${result.sharedSymbols} shared symbols (${result.actionTier})`);
    console.log(`  Risk: ${result.couplingKind}`);
    console.log(`  Recommendation: ${result.recommendation}`);
    return;
  }
  const results = queries.topCoupling(db, { limit, scope: stringOptionValue(opts, 'scope') });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('coupling', args, opts, { mode: 'top', rows: results });
    return;
  }
  render.table(
    ['tier', 'risk', 'shared', 'file1 → file2'],
    results.map(
      (r) =>
        `  ${r.actionTier.padEnd(6)}  ${r.couplingKind.padEnd(22)}  ${String(r.sharedSymbols).padStart(6)}  ${r.file1} → ${r.file2}`,
    ),
  );
});

const handleCycles = reportCommand({
  commandName: 'cycles',
  query: ({ db, opts }) =>
    queries.cycleSummary(db, {
      scope: stringOptionValue(opts, 'scope'),
      maxDepth: definedNumberOption(opts, 'maxDepth', 10),
    }),
  emptyMessage: (result) =>
    result.cycles.length === 0
      ? result.truncated
        ? `No circular dependencies found. Search truncated at depth ${result.maxDepth}; deeper cycles may exist.`
        : 'No circular dependencies found.'
      : undefined,
  toJson: (result) => result,
  render: (result) => {
    const real = result.cycles.filter((r) => r.kind === 'real');
    const moduleHierarchy = result.cycles.filter((r) => r.kind === 'module-hierarchy');
    for (let i = 0; i < real.length; i++) {
      console.log(`\nCycle ${i + 1} (${real[i]!.path.length - 1} files):`);
      for (let j = 0; j < real[i]!.path.length; j++) {
        const arrow = j < real[i]!.path.length - 1 ? ' →' : ' (cycle)';
        console.log(`  ${real[i]!.path[j]}${arrow}`);
      }
    }
    if (real.length === 0) console.log('No real circular dependencies found.');
    else console.log(`\n${real.length} real cycle(s) found.`);
    if (result.truncated) {
      console.log(`(search truncated at depth ${result.maxDepth} — deeper cycles may exist)`);
    }
    if (moduleHierarchy.length > 0) {
      console.log(
        `(${moduleHierarchy.length} module-hierarchy cycle(s) hidden — barrel files participating in normal parent/child re-export patterns. Pass --include-module-hierarchy to see them.)`,
      );
    }
  },
});

const handleDeepChains = reportCommand({
  commandName: 'deep-chains',
  query: ({ db, opts }) =>
    queries.deepChains(db, {
      limit: definedLimitOption(opts, 'limit', 10),
      scope: stringOptionValue(opts, 'scope'),
      minDepth: definedNumberOption(opts, 'minDepth', 3),
    }),
  emptyMessage: (results) => (results.length === 0 ? 'No deep chains found.' : undefined),
  render: (results) => {
    for (let i = 0; i < results.length; i++) {
      console.log(`\nChain ${i + 1} (depth ${results[i]!.depth}):`);
      for (const component of results[i]!.components) {
        const label = component.length === 1 ? component[0]! : `{ ${component.join(', ')} } (cycle)`;
        console.log(`  → ${label}`);
      }
      console.log(`  Tier: ${results[i]!.actionTier}  Risk: ${results[i]!.chainKind}`);
      console.log(`  Recommendation: ${results[i]!.recommendation}`);
      console.log(`  Evidence: ${results[i]!.evidenceReasons.join('; ')}`);
    }
  },
});

export const graphQueryCommandDescriptors: CommandDescriptor[] = [
  tableQueryCommand({
    id: 'hotspots',
    command: 'hotspots',
    description: 'Most-referenced symbols in the codebase (choke points)',
    options: [
      option('-n, --limit <n>', 'Number of results', parseInteger, 30),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ],
    docs: doc('Graph'),
    headers: ['refs', 'files', 'symbol'],
    query: ({ db, opts }) =>
      queries.hotspots(db, {
        limit: definedLimitOption(opts, 'limit', 30),
        scope: stringOptionValue(opts, 'scope'),
      }),
    format: (r) => `  ${String(r.refCount).padStart(4)}  ${String(r.fileCount).padStart(5)}  ${r.shortName}`,
  }),
  {
    id: 'fan-in',
    command: 'fan-in [symbol]',
    description: 'Count files referencing an exact symbol; top JSON rows include exact symbol identity',
    options: withJsonOption([
      option('-n, --limit <n>', 'Number of results for top mode', parseInteger, 30),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    renderShape: 'custom',
    docs: doc('Graph'),
    handler: handleFanIn,
  },
  {
    id: 'fan-out',
    command: 'fan-out [file]',
    description: 'How many external symbols a file uses (or top fan-out across codebase)',
    options: withJsonOption([
      option('-n, --limit <n>', 'Number of results for top mode', parseInteger, 30),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    renderShape: 'custom',
    docs: doc('Graph'),
    handler: handleFanOut,
  },
  {
    id: 'coupling',
    command: 'coupling [file1] [file2]',
    description: 'Coupling between two files, or top coupled pairs in codebase',
    options: withJsonOption([
      option('-n, --limit <n>', 'Number of results for top mode', parseInteger, 20),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    renderShape: 'custom',
    docs: doc('Graph'),
    handler: handleCoupling,
  },
  {
    id: 'cycles',
    command: 'cycles',
    description: 'Detect circular dependency chains between files',
    options: withJsonOption([
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--max-depth <n>', 'Bound DFS search depth', parseInteger, 10),
    ]),
    renderShape: 'custom',
    docs: doc('Graph'),
    handler: handleCycles,
  },
  {
    id: 'bottlenecks',
    command: 'bottlenecks',
    description: 'Find coupling hubs: high fan-in AND high fan-out',
    options: withJsonOption([
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-fan-in <n>', 'Minimum fan-in', parseInteger, 2),
      option('--min-fan-out <n>', 'Minimum fan-out', parseInteger, 2),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    budget: 'candidate-scan',
    renderShape: 'table',
    docs: doc('Graph'),
    handler: handleBottlenecks,
  },
  {
    id: 'deep-chains',
    command: 'deep-chains',
    description: 'Find the longest condensed dependency-component chains',
    options: withJsonOption([
      option('-n, --limit <n>', 'Number of chains to show', parseInteger, 10),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-depth <n>', 'Minimum chain depth', parseInteger, 3),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    renderShape: 'custom',
    docs: doc('Graph'),
    handler: handleDeepChains,
  },
  budgetedSectionedQueryCommand({
    id: 'call-graph',
    command: 'call-graph <symbol>',
    description: 'Show incoming callers and outgoing callees for a symbol',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    docs: doc('Graph'),
    query: ({ db, args, budget }) => queries.callGraph(db, String(args[0]), { semantic: budget.semantic }),
    emptyMessage: (result, { db, args }) =>
      result ? undefined : symbolResolutionEmptyMessage(db, String(args[0]), 'Symbol not found.'),
    before: (result, { db, args }) => {
      if (result) {
        symbolResolutionBefore(db, String(args[0]));
        console.log(`Symbol: ${result.shortName}\n`);
      }
    },
    toJson: (result, { db, args }) => withSymbolResolutionJson(db, String(args[0]), result, 'callGraph'),
    sections: (result) =>
      result
        ? [
            {
              title: `CALLERS (${result.callers.length})`,
              rows: result.callers.map((c) => `  ${c.file}  ${c.shortName}`),
            },
            {
              title: `CALLEES (${result.callees.length})`,
              rows: result.callees.map((c) => `  ${c.file}  ${c.shortName}`),
            },
          ]
        : [],
  }),
];
