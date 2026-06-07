import * as queries from '../../queries/index.js';
import type { CommandDescriptor } from '../command-descriptor-types.js';
import { doc, option, parseInteger } from '../command-spec-builders.js';
import {
  budgetedDbCommand,
  budgetedTableCommand,
  dbCommand,
  definedNumberOption,
  optionalStringArg,
  reportCommand,
  stringArg,
  stringOptionValue,
} from '../command-execution.js';
import { tableQueryCommand } from '../query-command-builders.js';
import { render } from '../render.js';

const handleBottlenecks = budgetedTableCommand('bottlenecks', {
  headers: ['score', 'fan-in', 'fan-out', 'symbol'],
  query: ({ db, opts, budget }) => queries.bottlenecks(db, {
    limit: definedNumberOption(opts, 'limit', 20),
    scope: stringOptionValue(opts, 'scope'),
    minFanIn: definedNumberOption(opts, 'minFanIn', 2),
    minFanOut: definedNumberOption(opts, 'minFanOut', 2),
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
  }),
  format: (r) =>
    `  ${String(r.score).padStart(5)}  ${String(r.fanIn).padStart(6)}  ` +
    `${String(r.fanOut).padStart(7)}  ${r.shortName}`,
  emptyMessage: () => 'No bottlenecks found.',
});

const handleCallGraph = budgetedDbCommand('call-graph', ({ db, args, budget }) => {
  const result = queries.callGraph(db, stringArg(args, 0), { semantic: budget.semantic });
  if (!result) return render.empty('Symbol not found.');
  console.log(`Symbol: ${result.shortName}\n`);
  render.sectionedReport([
    { title: `CALLERS (${result.callers.length})`, rows: result.callers.map((c) => `  ${c.file}  ${c.shortName}`) },
    { title: `CALLEES (${result.callees.length})`, rows: result.callees.map((c) => `  ${c.file}  ${c.shortName}`) },
  ]);
});

const handleFanIn = dbCommand(({ db, args, opts }) => {
  const symbol = optionalStringArg(args, 0);
  if (symbol) {
    const results = queries.fanIn(db, symbol);
    if (results.length === 0) return render.empty(`No fan-in for ${symbol}.`);
    render.list(results, (r) => `  ${String(r.count).padStart(4)} files  ${r.name}`);
    return;
  }
  render.table(
    ['files', 'symbol'],
    queries.topFanIn(db, { limit: definedNumberOption(opts, 'limit', 30), scope: stringOptionValue(opts, 'scope') }).map(
      (r) => `  ${String(r.count).padStart(5)}  ${r.name}`,
    ),
  );
});

const handleFanOut = dbCommand(({ db, args, opts }) => {
  const file = optionalStringArg(args, 0);
  if (file) {
    const results = queries.fanOut(db, file);
    if (results.length === 0) return render.empty(`No fan-out for ${file}.`);
    render.list(results, (r) => `  ${String(r.count).padStart(4)} symbols  ${r.name}`);
    return;
  }
  render.table(
    ['symbols', 'file'],
    queries.topFanOut(db, { limit: definedNumberOption(opts, 'limit', 30), scope: stringOptionValue(opts, 'scope') }).map(
      (r) => `  ${String(r.count).padStart(7)}  ${r.name}`,
    ),
  );
});

const handleCoupling = dbCommand(({ db, args, opts }) => {
  const file1 = optionalStringArg(args, 0);
  const file2 = optionalStringArg(args, 1);
  if (file1 && file2) {
    const result = queries.coupling(db, file1, file2);
    console.log(`${result.file1} ↔ ${result.file2}: ${result.sharedSymbols} shared symbols`);
    return;
  }
  render.table(
    ['shared', 'file1 → file2'],
    queries.topCoupling(db, { limit: definedNumberOption(opts, 'limit', 20), scope: stringOptionValue(opts, 'scope') }).map(
      (r) => `  ${String(r.sharedSymbols).padStart(6)}  ${r.file1} → ${r.file2}`,
    ),
  );
});

const handleCycles = reportCommand({
  query: ({ db, opts }) => queries.cycles(db, {
    scope: stringOptionValue(opts, 'scope'),
    maxDepth: definedNumberOption(opts, 'maxDepth', 10),
  }),
  emptyMessage: (results) => results.length === 0 ? 'No circular dependencies found.' : undefined,
  render: (results) => {
    const real = results.filter((r) => r.kind === 'real');
    const moduleHierarchy = results.filter((r) => r.kind === 'module-hierarchy');
    for (let i = 0; i < real.length; i++) {
      console.log(`\nCycle ${i + 1} (${real[i]!.path.length - 1} files):`);
      for (let j = 0; j < real[i]!.path.length; j++) {
        const arrow = j < real[i]!.path.length - 1 ? ' →' : ' (cycle)';
        console.log(`  ${real[i]!.path[j]}${arrow}`);
      }
    }
    if (real.length === 0) console.log('No real circular dependencies found.');
    else console.log(`\n${real.length} real cycle(s) found.`);
    if (moduleHierarchy.length > 0) {
      console.log(`(${moduleHierarchy.length} module-hierarchy cycle(s) hidden — barrel files participating in normal parent/child re-export patterns. Pass --include-module-hierarchy to see them.)`);
    }
  },
});

const handleDeepChains = reportCommand({
  query: ({ db, opts }) => queries.deepChains(db, {
    limit: definedNumberOption(opts, 'limit', 10),
    scope: stringOptionValue(opts, 'scope'),
    minDepth: definedNumberOption(opts, 'minDepth', 3),
  }),
  emptyMessage: (results) => results.length === 0 ? 'No deep chains found.' : undefined,
  render: (results) => {
    for (let i = 0; i < results.length; i++) {
      console.log(`\nChain ${i + 1} (depth ${results[i]!.depth}):`);
      for (const file of results[i]!.chain) console.log(`  → ${file}`);
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
    ],
    docs: doc('Graph'),
    headers: ['refs', 'files', 'symbol'],
    query: ({ db, opts }) => queries.hotspots(db, {
      limit: definedNumberOption(opts, 'limit', 30),
      scope: stringOptionValue(opts, 'scope'),
    }),
    format: (r) => `  ${String(r.refCount).padStart(4)}  ${String(r.fileCount).padStart(5)}  ${r.shortName}`,
  }),
  {
    id: 'fan-in',
    command: 'fan-in [symbol]',
    description: 'How many files reference a symbol (or top fan-in across codebase)',
    options: [
      option('-n, --limit <n>', 'Number of results for top mode', parseInteger, 30),
      option('-s, --scope <path>', 'Limit to files matching path'),
    ],
    renderShape: 'custom',
    docs: doc('Graph'),
    handler: handleFanIn,
  },
  {
    id: 'fan-out',
    command: 'fan-out [file]',
    description: 'How many external symbols a file uses (or top fan-out across codebase)',
    options: [
      option('-n, --limit <n>', 'Number of results for top mode', parseInteger, 30),
      option('-s, --scope <path>', 'Limit to files matching path'),
    ],
    renderShape: 'custom',
    docs: doc('Graph'),
    handler: handleFanOut,
  },
  {
    id: 'coupling',
    command: 'coupling [file1] [file2]',
    description: 'Coupling between two files, or top coupled pairs in codebase',
    options: [
      option('-n, --limit <n>', 'Number of results for top mode', parseInteger, 20),
      option('-s, --scope <path>', 'Limit to files matching path'),
    ],
    renderShape: 'custom',
    docs: doc('Graph'),
    handler: handleCoupling,
  },
  {
    id: 'cycles',
    command: 'cycles',
    description: 'Detect circular dependency chains between files',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--max-depth <n>', 'Maximum cycle depth', parseInteger, 10),
    ],
    renderShape: 'custom',
    docs: doc('Graph'),
    handler: handleCycles,
  },
  {
    id: 'bottlenecks',
    command: 'bottlenecks',
    description: 'Find coupling hubs: high fan-in AND high fan-out',
    options: [
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-fan-in <n>', 'Minimum fan-in', parseInteger, 2),
      option('--min-fan-out <n>', 'Minimum fan-out', parseInteger, 2),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    budget: 'candidate-scan',
    renderShape: 'table',
    docs: doc('Graph'),
    handler: handleBottlenecks,
  },
  {
    id: 'deep-chains',
    command: 'deep-chains',
    description: 'Find the longest transitive dependency chains',
    options: [
      option('-n, --limit <n>', 'Number of chains to show', parseInteger, 10),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-depth <n>', 'Minimum chain depth', parseInteger, 3),
    ],
    renderShape: 'custom',
    docs: doc('Graph'),
    handler: handleDeepChains,
  },
  {
    id: 'call-graph',
    command: 'call-graph <symbol>',
    description: 'Show incoming callers and outgoing callees for a symbol',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    renderShape: 'sectioned-report',
    docs: doc('Graph'),
    handler: handleCallGraph,
  },
];
