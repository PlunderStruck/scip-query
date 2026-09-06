import * as queries from '../../queries/index.js';
import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';
import {
  agentContract,
  analysisAgentContract,
  graphProjectionSemanticContract,
  locatorSemanticContract,
  collectValues,
  doc,
  fixedClaimFamily,
  mixedClaimContract,
  option,
  parseInteger,
  withJsonOption,
} from '../command-kit/command-spec-builders.js';
import { REPOSITORY_OBSERVATION_OPERATION } from '../command-operation.js';
import {
  budgetedTableCommand,
  booleanOptionValue,
  dbCommand,
  definedLimitOption,
  definedNumberOption,
  optionalStringArg,
  printJsonEnvelope,
  reportCommand,
  stringArg,
  stringArrayOptionValue,
  stringOptionValue,
} from '../command-kit/command-execution.js';
import { budgetedSectionedQueryCommand, tableQueryCommand } from '../command-kit/query-command-builders.js';
import { displayLine, render } from '../render.js';
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
    const results = queries.externalSymbolFanOut(db, file);
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
  if (Boolean(file1) !== Boolean(file2))
    throw new Error('Supply both files for pair coupling, or neither for ranking.');
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
    queries.dependencyCycleSummary(db, {
      scope: stringOptionValue(opts, 'scope'),
      maxDepth: definedNumberOption(opts, 'maxDepth', 10),
      edgeBasis: booleanOptionValue(opts, 'importsOnly') ? 'imports' : 'symbol-references',
    }),
  emptyMessage: (result) =>
    result.cycles.length === 0 ? `No cycles found in the ${result.edgeBasis} graph.` : undefined,
  toJson: (result) => result,
  render: (result) => {
    console.log(`Cyclic strongly connected components in the ${result.edgeBasis} graph:`);
    for (let i = 0; i < result.cycles.length; i++) {
      const cycle = result.cycles[i]!;
      const component = cycle.component ?? [...new Set(cycle.path.slice(0, -1))].sort();
      console.log(
        `\nComponent ${i + 1} (${component.length} files; ${cycle.classification ?? cycle.kind}; one witness follows):`,
      );
      for (let j = 0; j < cycle.path.length; j++) {
        const arrow = j < cycle.path.length - 1 ? ' →' : ' (cycle witness)';
        console.log(`  ${cycle.path[j]}${arrow}`);
      }
      if (component.length > new Set(cycle.path.slice(0, -1)).size) {
        console.log(`  Full component: ${component.join(', ')}`);
      }
    }
    console.log(
      `\n${result.cycles.length} cyclic component(s) found; results are SCC-complete, not all simple cycles.`,
    );
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
    renderArchitectureOverview(result);
    renderArchitecturePolicyGaps(result);
    renderArchitectureDependencies(result);
    renderArchitectureLimits(result);
    renderArchitectureFragility(result);
    renderCoarseArchitectureBoundaries(result);
    renderArchitectureBoundaryGraph(result);
    renderArchitectureCycles(result);
  },
  after: (result) => {
    if (queries.architectureFindingIdentities(result).length > 0) process.exitCode = 1;
  },
});

type ArchitectureReport = ReturnType<typeof queries.architecture>;

function renderArchitectureOverview(result: ArchitectureReport): void {
  const enforcedFindings = queries.architectureFindingIdentities(result);
  for (const limitation of result.coverage.limitations ?? []) console.log(`Scope limitation: ${limitation}`);
  console.log(
    `Mapped ${result.coverage.mappedFiles}/${result.coverage.totalFiles} indexed file(s) across ` +
      `${result.boundaries.length} boundary(ies); ${result.policyCoverage.declaredRows}/` +
      `${result.policyCoverage.totalBoundaries} dependency row(s) declared.`,
  );
  if (enforcedFindings.length === 0) {
    console.log(
      result.configured
        ? result.coverage.scope
          ? 'No configured violation observed in this scoped projection; repository-wide checks remain unevaluated.'
          : 'Configured architecture checks passed; undeclared dependency directions remain unknown.'
        : 'No architecture policy is configured.',
    );
  } else {
    console.log(
      `Architecture policy failed with ${enforcedFindings.length} enforced finding(s). ` +
        'Update the code or narrow the declared policy before treating the structure as clean.',
    );
  }
  if (result.dependencyRoles)
    console.log(
      `${result.dependencyRoles.excludedTestEdges} test-related file edges excluded from production groups. ${result.dependencyRoles.cycleMeaning}`,
    );
}

function renderArchitecturePolicyGaps(result: ArchitectureReport): void {
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
}

function renderArchitectureDependencies(result: ArchitectureReport): void {
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

  if (result.testForbiddenEdges?.length) {
    console.log(`\nTest imports violating explicit boundary rows (${result.testForbiddenEdges.length}):`);
    for (const edge of result.testForbiddenEdges)
      console.log(`  ${edge.from} -> ${edge.to}: ${edge.fileEdgeCount} test-related dependencies`);
  }
  if (result.staleAllowances.length > 0) {
    const policy = result.policyCoverage.requiresMinimalPolicy ? ' [violates requireMinimalPolicy]' : '';
    console.log(
      `\nStale dependency allowances (${result.staleAllowances.length}): declared but unused, ` +
        `so the policy is wider than the code requires.${policy}`,
    );
    for (const row of result.staleAllowances) console.log(`  ${row.from} -> ${row.to}`);
  }
}

function renderArchitectureLimits(result: ArchitectureReport): void {
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
}

function renderArchitectureFragility(result: ArchitectureReport): void {
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
}

function renderCoarseArchitectureBoundaries(result: ArchitectureReport): void {
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
}

function renderArchitectureBoundaryGraph(result: ArchitectureReport): void {
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
}

function renderArchitectureCycles(result: ArchitectureReport): void {
  if (result.cycles.length > 0) {
    console.log(`\nStrongly connected boundary groups (${result.cycles.length}):`);
    for (const cycle of result.cycles) {
      const policy = cycle.violatesPolicy ? ' [violates requireAcyclic]' : '';
      console.log(`  { ${cycle.boundaries.join(', ')} }${policy} [${cycle.origin ?? 'group origin unavailable'}]`);
      if (cycle.fileCycleMembers?.length)
        console.log(`    file-cycle members (types included): ${cycle.fileCycleMembers.join(', ')}`);
      for (const edge of cycle.narrowestEdges) {
        console.log(`    inspect ${edge.from} -> ${edge.to}: ${edge.fileEdgeCount} file edge(s)`);
      }
    }
  }
}

function dependencyDepthHandler() {
  return reportCommand({
    commandName: 'dependency-depth',
    query: ({ db, opts }) =>
      queries.dependencyDepth(db, {
        limit: definedLimitOption(opts, 'limit', 10),
        scope: stringOptionValue(opts, 'scope'),
        minDepth: definedNumberOption(opts, 'minDepth', 3),
        edgeBasis: booleanOptionValue(opts, 'importsOnly') ? 'imports' : 'symbol-references',
      }),
    emptyMessage: (results) => (results.length === 0 ? 'No deep chains found.' : undefined),
    render: (results) => {
      for (let i = 0; i < results.length; i++) {
        console.log(`\nChain ${i + 1} (condensed depth ${results[i]!.depth}; ${results[i]!.edgeBasis}):`);
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
}
const handleDependencyDepth = dependencyDepthHandler();

const handleEntryPoints = dbCommand(({ db, args, opts }) => {
  const search = optionalStringArg(args, 0);
  const results = queries.entryPoints(db, {
    search,
    scope: stringOptionValue(opts, 'scope'),
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('entrypoints', args, opts, results, {
      coverage: {
        complete: true,
        totalKnown: true,
        returned: results.length,
        total: results.length,
        omitted: 0,
      },
    });
    return;
  }
  const scope = stringOptionValue(opts, 'scope');
  console.log(`═══ REQUEST ═══\n  text=${search ? JSON.stringify(search) : '<all>'}; scope=${scope ?? '<repository>'}`);
  if (results.length === 0) {
    console.log(
      `\n═══ OBSERVED FACTS ═══\n  ${search ? `No detected entry candidate matched ${JSON.stringify(search)}.` : 'No entry candidates were detected.'}`,
    );
    console.log(
      '\n═══ EVIDENCE CALIBRATION ═══\n  Absence from this detector does not prove that the repository has no runtime ingress.',
    );
    console.log("\n═══ COVERAGE ═══\n  Complete within the detector's indexed source/compiler entry evidence.");
    return;
  }
  console.log('\n═══ OBSERVED FACTS ═══');
  render.list(
    results,
    (entry) =>
      `  [${entry.confidence}] ${entry.file}:${displayLine(entry.startLine)}  ${entry.shortName}\n` +
      `    evidence: ${entry.evidence.join(', ')}; observed static callers: ${entry.observedCallerCount}\n` +
      `    symbol: ${entry.symbol}`,
  );
  console.log(
    '\n═══ EVIDENCE CALIBRATION ═══\n  [root] has configured, framework-dispatched, or Rust public-library evidence. [candidate] is package-public or lacks observed callers; neither label proves a runtime invocation.',
  );
  console.log(`\n═══ COVERAGE ═══\n  ${results.length} entry candidate(s); complete within indexed detector evidence.`);
  console.log(
    '\n═══ RECOVERY ═══\n  Any printed exact symbol can be projected with scip-query evidence using the family and direction required by the material question.',
  );
});

const handleEntryMap = dbCommand(({ db, args, opts }) => {
  const query = stringArg(args, 0);
  const result = queries.entryCallMap(db, query, {
    expand: stringArrayOptionValue(opts, 'expand'),
  });
  if (result.kind !== 'matched') process.exitCode = 1;
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('entry-map', args, opts, result, {
      coverage:
        result.kind === 'matched'
          ? {
              complete: true,
              totalKnown: true,
              returned: result.regions.length,
              total: result.regions.length,
              omitted: 0,
            }
          : { complete: true, totalKnown: true, returned: 0, total: 0, omitted: 0 },
    });
    return;
  }
  if (result.kind !== 'matched') return renderEntryMapFailure(result, query);
  renderEntryMap(result);
});

type EntryMapReport = ReturnType<typeof queries.entryCallMap>;

function renderEntryMapFailure(result: Exclude<EntryMapReport, { kind: 'matched' }>, query: string): void {
  if (result.kind === 'missing') {
    process.exitCode = 1;
    return render.empty(`No symbol matched '${query}'.`);
  }
  if (result.kind === 'ambiguous') {
    process.exitCode = 1;
    console.error(`'${query}' is ambiguous across ${result.total} definitions:`);
    for (const candidate of result.candidates) {
      console.error(`  ${candidate.relativePath}:${displayLine(candidate.startLine)}  ${candidate.shortName}`);
      console.error(`    symbol: ${candidate.symbol}`);
    }
    return;
  }
  if (result.kind === 'not-entry') {
    process.exitCode = 1;
    return render.empty(`${result.shortName} (${result.file}) is not a detected entry point. ${result.reason}`);
  }
}

function renderEntryMap(result: Extract<EntryMapReport, { kind: 'matched' }>): void {
  console.log(`Entry: ${result.entry.shortName}  (${result.entry.file})`);
  console.log(`Evidence: ${result.entry.evidence.join(', ')}\n`);
  console.log('═══ COLLAPSED FILE REGIONS ═══');
  for (const region of result.regions) {
    const expansion = region.expanded ? 'expanded' : `expand with --expand '${region.id}'`;
    console.log(
      `  depth ${region.minDepth}  ${region.id}\n` +
        `    ${region.symbolCount} symbol(s); ${region.internalEdgeCount} internal edge(s); ` +
        `${region.externalCallCount} unresolved/external call(s); ` +
        `${region.incomingRegionIds.length} incoming region(s); ${region.outgoingRegionIds.length} outgoing region(s)\n` +
        `    ${expansion}`,
    );
  }

  if (result.regionEdges.length > 0) {
    console.log('\n═══ CROSS-REGION CALLS ═══');
    for (const edge of result.regionEdges) {
      console.log(
        `  ${edge.fromRegionId} → ${edge.toRegionId}  (${edge.callCount} edge(s); ${edge.evidence.join(', ')})\n` +
          `    ${edge.fromSymbols.join(', ')} → ${edge.toSymbols.join(', ')}`,
      );
    }
  }

  renderExpandedEntryRegions(result);

  if (result.unmatchedExpansions.length > 0) {
    console.error(`\nUnmatched expansion id(s): ${result.unmatchedExpansions.join(', ')}`);
  }
  console.log(
    `\nCoverage: ${result.coverage.symbolCount} symbol(s), ${result.coverage.symbolEdgeCount} call edge(s), ` +
      `${result.coverage.regionCount} region(s), ${result.coverage.externalCallCount} unresolved/external call(s).`,
  );
  console.log('Complete within indexed static call edges; dynamic dispatch is not represented.');
}

function renderExpandedEntryRegions(result: Extract<EntryMapReport, { kind: 'matched' }>): void {
  const expanded = result.regions.filter((region) => region.expanded);
  if (expanded.length > 0) {
    console.log('\n═══ EXPANDED REGIONS ═══');
    for (const region of expanded) {
      console.log(`  ${region.id}`);
      for (const symbol of region.symbols) {
        console.log(`    depth ${symbol.depth}  ${symbol.shortName}\n      ${symbol.symbol}`);
      }
      for (const edge of region.internalEdges) {
        console.log(`    call  ${edge.fromShortName} → ${edge.toShortName}  (${edge.source})`);
      }
      for (const call of region.externalCalls) {
        console.log(
          `    unresolved/external  ${call.fromShortName} → ${call.toShortName}  ` +
            `(${call.reportedFile}; ${call.source})`,
        );
      }
    }
  }
}

export const graphQueryCommandDescriptors: CommandDescriptor[] = [
  tableQueryCommand({
    id: 'hotspots',
    command: 'hotspots',
    description: 'Rank symbols by referencing chunks, or incoming evidence rows when SCIP mentions are unavailable',
    agent: analysisAgentContract(
      'Which symbols have the most observed cross-file reference evidence?',
      'ranked symbol identities with explicit evidence basis and counting units',
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
    headers: ['count', 'files', 'unit', 'symbol'],
    query: ({ db, opts }) =>
      queries.hotspots(db, {
        limit: definedLimitOption(opts, 'limit', 30),
        scope: stringOptionValue(opts, 'scope'),
      }),
    format: (r) =>
      `  ${String(r.refCount).padStart(4)}  ${String(r.fileCount).padStart(5)}  ${r.countUnit}  ${r.shortName}`,
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
        REPOSITORY_OBSERVATION_OPERATION,
        locatorSemanticContract(
          ['symbol', 'construct'],
          [
            'Entry-point detection reports evidenced external roots and candidates; it does not establish task relevance.',
          ],
        ),
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
    agent: analysisAgentContract(
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
    description: 'Count shared-symbol coupling between two files, or rank file pairs by that metric',
    agent: analysisAgentContract(
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
    description: 'Find every cyclic file-dependency component and show one deterministic witness for each',
    agent: analysisAgentContract(
      'Which file dependency cycles exist?',
      'dependency-cycle file chains',
      [],
      'complete',
      'repository',
    ),
    options: withJsonOption([
      option('-s, --scope <path>', 'Limit to files matching path'),
      option(
        '--imports-only',
        'Analyze resolved imports and re-exports, including type-only dependencies, instead of all symbol references',
      ),
      option(
        '--max-depth <n>',
        'Deprecated compatibility option; SCC detection no longer truncates by depth',
        parseInteger,
        10,
      ),
    ]),
    renderShape: 'custom',
    docs: doc('Graph'),
    handler: handleCycles,
  },
  {
    id: 'architecture',
    command: 'architecture',
    description: 'Evaluate project-owned architectural boundaries and dependency rules',
    agent: analysisAgentContract(
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
    description: 'Rank coordination hubs by incoming evidence files × outgoing cross-file callable targets',
    agent: analysisAgentContract(
      'Which callable symbols are high-connectivity coordination hubs?',
      'ranked callable symbols with incoming evidence-file and outgoing callable-target counts',
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
    id: 'dependency-depth',
    command: 'dependency-depth',
    description: 'Find longest paths through the SCC-condensed file dependency graph',
    agent: analysisAgentContract(
      'Which file dependency paths have the greatest condensed depth?',
      'ranked component paths with full cycle membership, edge basis, and condensed depth',
      [],
      'bounded',
      'repository',
    ),
    options: withJsonOption([
      option('-n, --limit <n>', 'Number of paths to show', parseInteger, 10),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-depth <n>', 'Minimum condensed component depth', parseInteger, 3),
      option('--imports-only', 'Measure the import graph instead of the symbol-reference dependency graph'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    renderShape: 'custom',
    docs: doc('Graph'),
    handler: handleDependencyDepth,
  },
  {
    id: 'entrypoints',
    command: 'entrypoints [text]',
    description: 'Find callables where control may enter from outside the indexed call graph',
    agent: {
      ...agentContract(
        'Which detected external roots or entry-surface candidates match this text?',
        'entry symbols with files, confidence, evidence, and observed static caller counts',
        ['pattern'],
        'complete',
        'repository',
        REPOSITORY_OBSERVATION_OPERATION,
        locatorSemanticContract(
          ['symbol', 'construct'],
          [
            'A package-public export or zero indexed callers is an entry candidate, not proof of runtime ingress.',
            'Entry classification does not establish that the callable executes.',
          ],
          {
            ranking: 'identity-only',
            manualInput: 'Optional exact text to filter candidates; otherwise the current indexed repository.',
            evidenceCeiling:
              'Source/compiler-grounded entry evidence and observed static caller counts; exported-only candidates remain candidates.',
            outputCost: 'bounded',
            frontierClosure: ['evidence', 'inspect', 'code'],
          },
        ),
      ),
      contrasts: [
        {
          command: 'entry-map',
          distinction:
            'entrypoints locates possible external roots; entry-map traverses static calls from one selected root.',
        },
        {
          command: 'search',
          distinction: 'entrypoints classifies callable roots; search only locates exact text and ownership.',
        },
      ],
    },
    options: withJsonOption([option('-s, --scope <path>', 'Limit to files matching path')]),
    renderShape: 'custom',
    docs: doc('Graph', ['scip-query entrypoints', 'scip-query entrypoints work-session']),
    handler: handleEntryPoints,
  },
  {
    id: 'entry-map',
    command: 'entry-map <entry>',
    description: 'Map the complete indexed call graph from one detected entry point, collapsed by file',
    agent: {
      ...agentContract(
        'What statically reachable call structure begins at this detected entry point?',
        'all reachable file regions, cross-region call edges, coverage, and selected expanded symbol details',
        ['symbol'],
        'complete',
        undefined,
        REPOSITORY_OBSERVATION_OPERATION,
        graphProjectionSemanticContract({
          rootKinds: ['symbol', 'construct'],
          edgeFamilies: ['execution'],
          directions: ['outgoing'],
          operations: ['reachability'],
          compression: ['topology'],
          nonClaims: ['Static may-call reachability does not establish runtime execution.'],
        }),
      ),
      contrasts: [
        {
          command: 'entrypoints',
          distinction: 'entry-map traverses one selected root; entrypoints locates and classifies candidate roots.',
        },
        {
          command: 'evidence',
          distinction:
            'entry-map is outgoing execution reachability; evidence projects explicitly selected families and directions.',
        },
      ],
    },
    options: withJsonOption([
      option('--expand <region-id>', 'Expand one file region; repeat to expand several together', collectValues, []),
    ]),
    renderShape: 'custom',
    docs: doc('Graph', [
      'scip-query entry-map start',
      "scip-query entry-map start --expand 'file:src/routes.ts' --expand 'file:src/store.ts'",
    ]),
    handler: handleEntryMap,
  },
  budgetedSectionedQueryCommand({
    id: 'call-graph',
    command: 'call-graph <symbol>',
    description: 'Show static may-call edges with exact/candidate evidence and explicit blind spots',
    agent: analysisAgentContract(
      'Who calls this symbol and what does it call?',
      'caller and callee symbol identities, files, evidence strengths, and static-analysis blind spots',
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
              rows: result.callerEvidence
                ? result.callerEvidence.map(
                    (c) =>
                      `  [${c.evidenceStrength}:${c.relationship}${c.interaction ? `:${c.interaction}` : ''}] ${c.file}  ${c.shortName}  (${c.evidenceSource})`,
                  )
                : result.callers.map((c) => `  ${c.file}  ${c.shortName}`),
            },
            {
              title: `CALLEES (${result.callees.length})`,
              rows: result.calleeEvidence
                ? result.calleeEvidence.map(
                    (c) =>
                      `  [${c.evidenceStrength}:${c.relationship}${c.interaction ? `:${c.interaction}` : ''}] ${c.file}  ${c.shortName}  (${c.evidenceSource})`,
                  )
                : result.callees.map((c) => `  ${c.file}  ${c.shortName}`),
            },
            {
              title: 'COVERAGE',
              rows: result.coverage
                ? [
                    `  ${result.coverage.scope}`,
                    ...result.coverage.blindSpots.map((blindSpot) => `  Blind spot: ${blindSpot}`),
                  ]
                : ['  Legacy result: explicit static-analysis coverage was not reported.'],
            },
          ]
        : [],
  }),
];
