import * as queries from '../../queries/index.js';
import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';
import {
  agentContract,
  doc,
  fixedClaimFamily,
  mixedClaimContract,
  option,
  parseInteger,
  withJsonOption,
} from '../command-kit/command-spec-builders.js';
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
} from '../command-kit/command-execution.js';
import { budgetedSectionedQueryCommand, tableQueryCommand } from '../command-kit/query-command-builders.js';
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

const handleArchitecture = reportCommand({
  commandName: 'architecture',
  query: ({ db, opts }) => queries.architecture(db, { scope: stringOptionValue(opts, 'scope') }),
  emptyMessage: (result) =>
    result.configured
      ? undefined
      : 'No architecture boundaries configured. Add architecture.boundaries to .scipquery.json.',
  render: (result) => {
    const enforcedFindings = queries.architectureFindingIdentities(result);
    console.log(
      `Mapped ${result.coverage.mappedFiles}/${result.coverage.totalFiles} indexed file(s) across ` +
        `${result.boundaries.length} boundary(ies); ${result.policyCoverage.declaredRows}/` +
        `${result.policyCoverage.totalBoundaries} dependency row(s) declared.`,
    );
    if (enforcedFindings.length === 0) {
      console.log('Architecture policy passed.');
    } else {
      console.log(
        `Architecture policy failed with ${enforcedFindings.length} enforced finding(s). ` +
          'Update the code or narrow the declared policy before treating the structure as clean.',
      );
    }
    if (result.policyCoverage.missingRows.length > 0) {
      const policy = result.policyCoverage.requiresCompletePolicy ? ' [violates requireCompletePolicy]' : '';
      console.log(`Missing dependency rows: ${result.policyCoverage.missingRows.join(', ')}${policy}`);
    }
    if (result.coverage.unmappedFiles.length > 0) {
      const policy = result.policyCoverage.requiresCompleteCoverage ? ' [violates requireCompleteCoverage]' : '';
      console.log(`Unmapped files: ${result.coverage.unmappedFiles.length}${policy}`);
    }
    if (result.coverage.ambiguousFiles.length > 0) {
      const policy = result.policyCoverage.requiresCompleteCoverage ? ' [violates requireCompleteCoverage]' : '';
      console.log(`Ambiguous files: ${result.coverage.ambiguousFiles.length}${policy}`);
      for (const row of result.coverage.ambiguousFiles.slice(0, 5)) {
        console.log(`  ${row.file} -> ${row.boundaries.join(', ')}`);
      }
    }

    if (result.forbiddenEdges.length > 0) {
      console.log(`\nForbidden boundary edges (${result.forbiddenEdges.length}):`);
      for (const edge of result.forbiddenEdges) {
        console.log(
          `  ${edge.from} -> ${edge.to}: ${edge.fileEdgeCount} file edge(s), ` +
            `${edge.importerCount} importer(s), ${edge.importedFileCount} imported file(s)`,
        );
        for (const example of edge.examples) console.log(`    ${example.fromFile} -> ${example.toFile}`);
      }
    } else {
      console.log('\nNo forbidden dependency edges found.');
    }

    if (result.staleAllowances.length > 0) {
      const policy = result.policyCoverage.requiresMinimalPolicy ? ' [violates requireMinimalPolicy]' : '';
      console.log(
        `\nStale dependency allowances (${result.staleAllowances.length}): declared but unused, ` +
          `so the policy is wider than the code requires.${policy}`,
      );
      for (const row of result.staleAllowances) console.log(`  ${row.from} -> ${row.to}`);
    }

    if (result.boundaryLimits.length > 0) {
      console.log(`\nBoundaries over configured limits (${result.boundaryLimits.length}):`);
      for (const limit of result.boundaryLimits) {
        console.log(`  ${limit.boundary}: ${limit.kind} ${limit.observed} exceeds limit ${limit.limit}`);
      }
    }

    if (result.testBoundaryViolations.length > 0) {
      console.log(
        `\nTest boundary violations (${result.testBoundaryViolations.length}): a test reaches further ` +
          'than the boundary of the code it covers is allowed to reach.',
      );
      for (const row of result.testBoundaryViolations.slice(0, 20)) {
        const owner = row.ownerBoundary ?? '(no subject found)';
        console.log(`  ${row.testFile} [${owner}] -> ${row.importedBoundary} (${row.importedFile})`);
      }
      if (result.testBoundaryViolations.length > 20) {
        console.log(`  ... +${result.testBoundaryViolations.length - 20} more`);
      }
    }

    if (result.fragileEdges.length > 0) {
      console.log(
        `\nSingle-import boundary edges (${result.fragileEdges.length} of ${result.edges.length}): ` +
          'the whole boundary dependency is carried by one file-level import. ' +
          'Breadth alone does not establish importance -- inspect before concluding either way.',
      );
      for (const edge of result.fragileEdges.slice(0, 10)) {
        const example = edge.examples[0];
        console.log(`  ${edge.from} -> ${edge.to}${example ? `  (${example.fromFile} -> ${example.toFile})` : ''}`);
      }
      if (result.fragileEdges.length > 10) console.log(`  ... +${result.fragileEdges.length - 10} more`);
    }

    if (result.coarseBoundaries.length > 0) {
      console.log(
        `\nBoundaries too coarse to check (${result.coarseBoundaries.length}): ` +
          'these own an internal dependency cycle that the boundary graph cannot express, ' +
          'so requireAcyclic reports nothing about the code inside them.',
      );
      for (const finding of result.coarseBoundaries) {
        console.log(`  ${finding.boundary}: ${finding.subUnits.join(' <-> ')}`);
        for (const edge of finding.narrowestEdges) {
          console.log(`    narrowest: ${edge.from} -> ${edge.to} (${edge.fileEdgeCount} file edge(s))`);
          for (const example of edge.examples.slice(0, 3)) {
            console.log(`      ${example.fromFile} -> ${example.toFile}`);
          }
        }
      }
    }

    if (result.edges.length > 0) {
      console.log(`\nBoundary graph (${result.edges.length} directed edge(s)):`);
      for (const edge of result.edges) {
        console.log(
          `  ${edge.from} -> ${edge.to}  ${edge.policyStatus.padEnd(10)}  ` + `${edge.fileEdgeCount} file edge(s)`,
        );
      }
    }

    if (result.reciprocalPairs.length > 0) {
      console.log(`\nReciprocal boundary pairs (${result.reciprocalPairs.length}):`);
      for (const pair of result.reciprocalPairs) {
        console.log(
          `  ${pair.boundaries[0]} <-> ${pair.boundaries[1]}  ` +
            `${pair.forward.fileEdgeCount}/${pair.reverse.fileEdgeCount} file edge(s)`,
        );
      }
    }

    if (result.cycles.length > 0) {
      console.log(`\nStrongly connected boundary groups (${result.cycles.length}):`);
      for (const cycle of result.cycles) {
        const policy = cycle.violatesPolicy ? ' [violates requireAcyclic]' : '';
        console.log(`  { ${cycle.boundaries.join(', ')} }${policy}`);
        for (const edge of cycle.narrowestEdges) {
          console.log(`    inspect ${edge.from} -> ${edge.to}: ${edge.fileEdgeCount} file edge(s)`);
        }
      }
    }
  },
  after: (result) => {
    if (queries.architectureFindingIdentities(result).length > 0) process.exitCode = 1;
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
    agent: agentContract(
      'Which symbols are the largest reference choke points?',
      'ranked symbol identities with reference and file counts',
      [],
      'bounded',
      'repository',
    ),
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
    agent: {
      ...agentContract(
        'How many files reference this symbol, or which symbols have highest fan-in?',
        'exact symbols with referencing-file counts',
        ['symbol'],
        'bounded',
        'repository',
      ),
      resultUnits: { kind: 'field', field: 'rows' },
    },
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
    agent: agentContract(
      'How many external symbols does this file use, or which files have highest fan-out?',
      'files with external-symbol counts',
      ['file'],
      'bounded',
      'repository',
    ),
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
    agent: agentContract(
      'How strongly are these files coupled, or which pairs are most coupled?',
      'file pairs with coupling evidence and scores',
      ['file', 'file'],
      'bounded',
      'repository',
    ),
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
    agent: agentContract(
      'Which file dependency cycles exist?',
      'dependency-cycle file chains',
      [],
      'bounded',
      'repository',
    ),
    options: withJsonOption([
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--max-depth <n>', 'Bound DFS search depth', parseInteger, 10),
    ]),
    renderShape: 'custom',
    docs: doc('Graph'),
    handler: handleCycles,
  },
  {
    id: 'architecture',
    command: 'architecture',
    description: 'Evaluate project-owned architectural boundaries and dependency rules',
    agent: agentContract(
      'Does the repository obey its declared architecture boundaries?',
      'boundary coverage and dependency-rule violations',
      [],
      'complete',
      'repository',
    ),
    options: withJsonOption([option('-s, --scope <path>', 'Limit to files matching path')]),
    evidence: 'mixed',
    claims: mixedClaimContract(
      ['index-generation', 'live-workspace'],
      [
        fixedClaimFamily('declared-policy', 'boundaries', 'repository-source'),
        fixedClaimFamily('dependency-observations', 'edges', 'compiler-graph'),
        fixedClaimFamily('policy-findings', 'forbiddenEdges', 'compiler-graph'),
      ],
    ),
    renderShape: 'custom',
    docs: doc('Graph', ['scip-query architecture --json']),
    handler: handleArchitecture,
  },
  {
    id: 'bottlenecks',
    command: 'bottlenecks',
    description: 'Find coupling hubs: high fan-in AND high fan-out',
    agent: agentContract(
      'Which files are high-connectivity coupling hubs?',
      'ranked files with fan-in and fan-out counts',
      [],
      'bounded',
      'repository',
    ),
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
    agent: agentContract(
      'Which dependency chains are deepest and riskiest?',
      'ranked component chains with depth, risk, and recommendation',
      [],
      'bounded',
      'repository',
    ),
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
    agent: agentContract(
      'Who calls this symbol and what does it call?',
      'caller and callee symbol identities with files',
      ['symbol'],
      'bounded',
    ),
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
