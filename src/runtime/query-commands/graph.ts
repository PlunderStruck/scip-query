import * as queries from '../../queries/index.js';
import type {
  ConnectedBehaviorPacket,
  ExplorationTopology,
  SystemMapEvidenceFloor,
  SystemMapRelationKind,
  SystemMapSourceScope,
} from '../../queries/index.js';
import type { CommandDescriptor } from '../command-kit/command-descriptor-types.js';
import type { CommandOptions } from '../command-kit/command-execution.js';
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
import { GRAPH_EVIDENCE_FAMILIES } from '../../domain/graph-exploration-contract.js';
import { groupBy } from '../../domain/group-by.js';
import { compareSystemMapDrilldownSymbols } from '../../domain/system-map-origin-rank.js';
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
import { renderSessionEvidence } from '../source-emission-session.js';
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

function dependencyDepthHandler(commandName: 'deep-chains' | 'dependency-depth') {
  return reportCommand({
    commandName,
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

const handleDeepChains = dependencyDepthHandler('deep-chains');
const handleDependencyDepth = dependencyDepthHandler('dependency-depth');

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
      `    evidence: ${entry.evidence.join(', ')}; indexed callers: ${entry.indexedCallerCount}\n` +
      `    symbol: ${entry.symbol}`,
  );
  console.log(
    '\n═══ EVIDENCE CALIBRATION ═══\n  [root] has configured, framework-dispatched, Rust public-library, or entry-surface evidence. [candidate] is package-public or lacks indexed callers; neither label proves a runtime invocation.',
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

  if (result.unmatchedExpansions.length > 0) {
    console.error(`\nUnmatched expansion id(s): ${result.unmatchedExpansions.join(', ')}`);
  }
  console.log(
    `\nCoverage: ${result.coverage.symbolCount} symbol(s), ${result.coverage.symbolEdgeCount} call edge(s), ` +
      `${result.coverage.regionCount} region(s), ${result.coverage.externalCallCount} unresolved/external call(s).`,
  );
  console.log('Complete within indexed static call edges; dynamic dispatch is not represented.');
});

const handleSystemMap = dbCommand(({ db, args, opts }) => {
  const selectionTerms = stringArrayOptionValue(opts, 'selectionTerm');
  const result = queries.systemMap(db, {
    searches: stringArrayOptionValue(opts, 'search'),
    symbols: stringArrayOptionValue(opts, 'symbol'),
    behaviorFocusLocations: stringArrayOptionValue(opts, 'focusAt').map(systemMapBehaviorFocus),
    maxDepth: definedNumberOption(opts, 'depth', 5),
    expand: stringArrayOptionValue(opts, 'expand'),
    relations: stringArrayOptionValue(opts, 'relation') as SystemMapRelationKind[],
    evidenceFloor: stringOptionValue(opts, 'evidenceFloor') as SystemMapEvidenceFloor | undefined,
    sourceScopes: stringArrayOptionValue(opts, 'sourceScope') as SystemMapSourceScope[],
    maxTopologyCharacters: definedNumberOption(opts, 'topologyCharacters', 12_000),
    topologyFrontiers: stringArrayOptionValue(opts, 'frontier'),
    routeIds: stringArrayOptionValue(opts, 'route'),
    fullLiteralTraversal: booleanOptionValue(opts, 'fullLiteralTraversal'),
    selectionTerms,
  });
  if (selectionTerms.length > 0 && !booleanOptionValue(opts, 'json')) {
    console.error(
      'Deprecated: --selection-term is accepted as a no-op; graph selection is explicit and query-neutral.',
    );
  }
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('system-map', args, opts, result, {
      coverage: {
        complete: false,
        totalKnown: false,
        returned: result.regions.length,
      },
    });
    return;
  }
  if (booleanOptionValue(opts, 'gapRecoveryOnly')) {
    printSystemMapGapRecovery(result.nextAnchors, stringArrayOptionValue(opts, 'gapCallee'));
    return;
  }
  const presentedRegionIds = new Set(result.presentation.regionIds);
  const presentedRelationKeys = new Set(result.presentation.relationKeys);
  const presentedRegions = result.regions.filter((region) => presentedRegionIds.has(region.id));
  const presentedRelations = result.regionRelations.filter((relation) =>
    presentedRelationKeys.has(`${relation.fromRegionId}\u0000${relation.toRegionId}`),
  );
  const hasExpandedRegions = presentedRegions.some((region) => region.expanded);
  const hasConnectedBehavior = Boolean(result.behavior && result.behavior.steps.length > 0);

  console.log('═══ EXPLICIT ANCHORS ═══');
  for (const anchor of result.anchors) {
    const count =
      anchor.kind === 'literal'
        ? `${anchor.matchingLines ?? 0} matching line(s); ${anchor.seedMatchingLines ?? 0} materialized source seed(s), ${anchor.matchOnlyLines ?? 0} match-only, ${anchor.withheldMatchingLines ?? 0} withheld before traversal`
        : `${anchor.totalSymbolCandidates ?? 0} candidate definition(s)`;
    console.log(`  [${anchor.status}] ${anchor.kind} ${anchor.query} — ${count}`);
    if ((anchor.seedRegionIds ?? []).length > 0) {
      console.log(`    traversal seed regions: ${anchor.seedRegionIds!.join(', ')}`);
    }
    if ((anchor.matchOnlyRegionIds ?? []).length > 0) {
      console.log(`    retained match-only regions: ${anchor.matchOnlyRegionIds!.join(', ')}`);
    }
    for (const match of anchor.representativeMatches ?? []) {
      const owner = match.ownerShortName ? `  ${compactSystemMapIdentity(match.ownerShortName)}` : '';
      console.log(
        `    representative: ${match.file}:${displayLine(match.line)}${owner} — ${match.sourceLine.slice(0, 160)}`,
      );
    }
    for (const command of anchor.narrowingCommands ?? []) console.log(`    narrow exactly: ${command}`);
    if (anchor.exhaustiveTraversalCommand) {
      console.log(`    exhaustive recovery: ${anchor.exhaustiveTraversalCommand}`);
    }
    if (anchor.kind === 'symbol' && anchor.matchedRegionIds.length > 0) {
      console.log(`    regions: ${anchor.matchedRegionIds.join(', ')}`);
    }
    if (!hasExpandedRegions) {
      const shownCandidates = hasConnectedBehavior
        ? (anchor.symbolCandidates ?? []).slice(0, 3)
        : (anchor.symbolCandidates ?? []);
      for (const candidate of shownCandidates) {
        console.log(
          `    ${candidate.relativePath}:${displayLine(candidate.startLine)}  ${compactSystemMapIdentity(candidate.shortName)}`,
        );
      }
    }
    if ((anchor.omittedSymbolCandidates ?? 0) > 0) {
      console.log(`    ${anchor.omittedSymbolCandidates} additional candidate(s) omitted by symbol resolution.`);
    }
  }

  if (result.topology) {
    const topologyNodeById = new Map(result.topology.nodes.map((node) => [node.id, node]));
    const emittedNodes = result.topology.nodes.filter((node) => node.disposition === 'emitted');
    const emittedEdges = result.topology.edges.filter(
      (edge) =>
        edge.disposition === 'emitted' && edge.kind !== 'structural-membership' && edge.fromNodeId !== edge.toNodeId,
    );
    const foldedFrontiers = result.topology.frontiers.filter((frontier) => frontier.disposition === 'folded');
    console.log('\n═══ QUERY CONNECTOR GRAPH ═══');
    console.log(
      `  ${emittedNodes.length}/${result.topology.nodes.length} node(s) selected; ` +
        `${emittedEdges.length} typed connector edge(s); ${foldedFrontiers.length} reversible frontier group(s).`,
    );
    if (result.topology.completion) {
      console.log(`  [${result.topology.completion.status}] ${result.topology.completion.explanation}`);
    }
    for (const path of result.topology.paths) {
      const labels = path.nodeIds.map((id) => topologyNodeById.get(id)?.label ?? id);
      console.log(`  [${path.status}] ${labels.length > 0 ? labels.join(' ↔ ') : 'no proved connector'}`);
    }
    const routeCatalog = result.topology.routeCatalog;
    if (routeCatalog) {
      const selectedRouteIds = new Set(routeCatalog.selectedRouteIds);
      console.log(
        `  Route catalogue [${routeCatalog.coverage.status}]: ${routeCatalog.routes.length} distinct proved public/runtime endpoint route(s); ` +
          `${routeCatalog.coverage.enumeration}; depth ≤ ${routeCatalog.coverage.maximumDepth}.`,
      );
      for (const route of routeCatalog.routes) {
        const selected = selectedRouteIds.has(route.id) ? '; selected' : '';
        const families = route.relatedEdgeFamilies.length > 0 ? route.relatedEdgeFamilies.join(',') : 'control';
        const chain = route.nodeIds
          .map((nodeId) => compactSystemMapIdentity(topologyNodeById.get(nodeId)?.label ?? nodeId))
          .join(' → ');
        console.log(
          `  [${route.id}; ${route.endpointKind}; ${route.edgeIds.length} edge(s); families ${families}${selected}] ` +
            `${chain} @ ${route.endpointLocation.file}:${displayLine(route.endpointLocation.line)}`,
        );
      }
      if (routeCatalog.coverage.anchorsWithoutRoutes.length > 0) {
        console.log(
          `  [no proved public/runtime route] ${routeCatalog.coverage.anchorsWithoutRoutes.length} anchor node(s): ` +
            routeCatalog.coverage.anchorsWithoutRoutes.join(', '),
        );
      }
      if (routeCatalog.routes.length > 0 && routeCatalog.selectedRouteIds.length === 0) {
        console.log(
          `  Select only routes whose interior behavior is a named missing fact; repeat --route to batch: ` +
            `${systemMapRouteSelectionCommand(opts, [])} --route '<route-id>'`,
        );
      }
    }
    const upstreamCausalRoots = emittedNodes.filter(
      (node) => typeof node.attributes['upstreamCausalEndpoint'] === 'string',
    );
    if (upstreamCausalRoots.length > 0) {
      console.log(
        '  Upstream causal roots are the earliest source-backed constructs selected on bounded proved paths into the anchors; ' +
          'a traversal root has no earlier proved caller in this query graph and is not necessarily a public application entry.',
      );
      for (const node of upstreamCausalRoots) {
        const location = node.location ? ` @ ${node.location.file}:${displayLine(node.location.line)}` : '';
        const distance = Number(node.attributes['upstreamCausalDistance'] ?? 0);
        console.log(
          `  [${String(node.attributes['upstreamCausalEndpoint'])}; ${distance} edge(s) to anchor] ` +
            `${compactSystemMapIdentity(node.label)}${location}`,
        );
      }
    }
    const shownEdgeLimit = hasConnectedBehavior ? 4 : 8;
    for (const edge of emittedEdges.slice(0, shownEdgeLimit)) {
      const from = topologyNodeById.get(edge.fromNodeId)?.label ?? edge.fromNodeId;
      const to = topologyNodeById.get(edge.toNodeId)?.label ?? edge.toNodeId;
      const strengths = [...new Set(edge.evidence.map((source) => source.strength))].join('/');
      console.log(`  ${from} → ${to} — ${edge.kind} [${strengths}]`);
    }
    if (emittedEdges.length > shownEdgeLimit) {
      console.log(`  +${emittedEdges.length - shownEdgeLimit} selected connector edge(s).`);
    }
    const shownFrontiers = foldedFrontiers.slice(0, hasConnectedBehavior ? 1 : 2);
    for (const frontier of shownFrontiers) {
      const examples = frontier.memberNodeIds
        .slice(0, 2)
        .map((id) => topologyNodeById.get(id)?.label ?? id)
        .join(', ');
      console.log(
        `  [folded ${frontier.id}] ${frontier.memberCount} node(s), ${frontier.edgeIds.length} edge(s)` +
          `${examples ? ` — ${examples}` : ''}`,
      );
    }
    const firstExpansion = shownFrontiers.find((frontier) => frontier.expansion)?.expansion;
    if (firstExpansion && !hasConnectedBehavior) {
      const expansionBase = firstExpansion.replace(/ --frontier '[^']+'$/u, '');
      console.log(
        `  Expand shown frontiers together: ${expansionBase} ${shownFrontiers
          .map((frontier) => `--frontier '${frontier.id}'`)
          .join(' ')}`,
      );
    }
    if (foldedFrontiers.length > shownFrontiers.length) {
      console.log(
        `  +${foldedFrontiers.length - shownFrontiers.length} frontier group(s); ` +
          'all exact members and expansion commands remain in the structured result.',
      );
    }
    renderCausalCorridor(result.topology, result.behavior);
  }

  if (result.behavior && result.behavior.steps.length > 0) {
    console.log('\n═══ CONNECTED BEHAVIOR ═══');
    console.log(
      `  [${result.behavior.status}] ${result.behavior.steps.length}/${result.behavior.coverage.candidateNodes} selected construct(s); ` +
        `${result.behavior.transitions.length} evidenced transition(s); ` +
        `${result.behavior.coverage.withheldStatements} non-connector statement(s) withheld with exact-source recovery.`,
    );
    if (result.behavior.coverage.requestedFocusLocations.length > 0) {
      console.log(
        `  Question-aligned focus: ${result.behavior.coverage.matchedFocusLocations.length}/${result.behavior.coverage.requestedFocusLocations.length} exact location(s) fell inside selected constructs.`,
      );
      for (const location of result.behavior.coverage.unmatchedFocusLocations) {
        console.log(`  [unmatched focus] ${location.file}:${displayLine(location.line)}`);
      }
    }
    console.log(
      '  Read every relevant sibling branch under the explicit anchors before using optional gap recovery; ' +
        'the branch outcomes are jointly required behavior, not alternative search results.',
    );
    const stepNumberById = new Map(result.behavior.steps.map((step) => [step.id, step.order + 1]));
    for (const step of result.behavior.steps) {
      const location = step.location ? ` @ ${step.location.file}:${displayLine(step.location.line)}` : '';
      console.log(
        `  ${step.order + 1}. [${step.role}; ${step.kind}] ${compactSystemMapIdentity(step.label)}${location}`,
      );
      if (!step.behavior) continue;
      const behaviorLines = [
        `     [${step.behavior.kind}; ${step.behavior.constructKind}] ${step.behavior.signature} ` +
          `(${step.behavior.renderedCharacters}/${step.behavior.rawCharacters} chars; ` +
          `${step.behavior.coverage.representedStatements}/${step.behavior.coverage.sourceStatements} detected behavior statements selected)`,
      ];
      for (const line of step.behavior.lines) {
        const signals = line.signals.length > 0 ? ` [${line.signals.join(',')}]` : '';
        behaviorLines.push(`       ${displayLine(line.line)}${signals} ${'  '.repeat(line.depth)}${line.text}`);
      }
      for (const declaration of step.behavior.supportingDeclarations ?? []) {
        const text = declaration.text.replace(/\s*\n\s*/gu, ' ');
        behaviorLines.push(
          `       [support; ${declaration.kind}] ${declaration.label} @ ${declaration.file}:${displayLine(declaration.line)} — ${text}`,
        );
      }
      for (const declaration of step.behavior.omittedSupportingDeclarations ?? []) {
        behaviorLines.push(
          `       [support omitted; ${declaration.reason}] ${declaration.label} @ ${declaration.file}:${displayLine(declaration.line)}-${displayLine(declaration.endLine)}`,
        );
      }
      console.log(
        renderSessionEvidence({
          kind: 'unit',
          identity: step.nodeId,
          content: behaviorLines.join('\n'),
          label: compactSystemMapIdentity(step.label),
          indent: '     ',
        }),
      );
    }
    if (result.behavior.transitions.length > 0) {
      console.log('  Transitions (arrows preserve repository-edge direction):');
      for (const transition of result.behavior.transitions) {
        const evidence = transition.evidence.map((source) => `${source.method}/${source.strength}`).join(', ');
        const runtimeKeys =
          transition.kind === 'runtime-boundary'
            ? [
                ...new Set(
                  transition.evidence.flatMap((source) =>
                    typeof source.identity === 'string' && source.identity.length > 0 ? [source.identity] : [],
                  ),
                ),
              ]
            : [];
        const from = stepNumberById.get(transition.fromStepId) ?? '?';
        const to = stepNumberById.get(transition.toStepId) ?? '?';
        console.log(
          renderSessionEvidence({
            kind: 'edge',
            identity: transition.edgeId,
            content:
              `    ${from} → ${to} — ${transition.kind}; path=${transition.pathTraversal}; ${evidence}` +
              (runtimeKeys.length > 0 ? `; key=${runtimeKeys.join(' | ')}` : ''),
            label: `${from} → ${to} ${transition.kind}`,
            indent: '    ',
          }),
        );
      }
    }
    if (result.behavior.coverage.omittedNodeIds.length > 0) {
      console.log(
        `  ${result.behavior.coverage.omittedNodeIds.length} bounded emitted construct(s) were not materialized; ` +
          'their identities remain in behavior.coverage.omittedNodeIds.',
      );
    }
    if (result.behavior.exactSourceCommand) {
      console.log(
        `  Exhaustive exact-source recovery (usually unnecessary; never combine with the drill batch below): ` +
          result.behavior.exactSourceCommand,
      );
    }
  }

  if (result.nextAnchors && result.nextAnchors.candidateAnchors > 0) {
    console.log('\n═══ ADJACENT RECOVERY INVENTORY ═══');
    const adjacent = [...result.nextAnchors.anchors, ...result.nextAnchors.withheldAnchors];
    const inventory = new Map<string, number>();
    for (const anchor of adjacent) {
      const key = `${anchor.direction}/${anchor.relationKind}/${anchor.causalRole}`;
      inventory.set(key, (inventory.get(key) ?? 0) + 1);
    }
    console.log(
      `  ${result.nextAnchors.candidateAnchors} exact or candidate adjacent target(s) are recoverably folded.`,
    );
    for (const [kind, count] of [...inventory].sort(([left], [right]) => left.localeCompare(right))) {
      console.log(`  ${kind}: ${count}`);
    }
    console.log(
      `  Select a named missing callee without relevance inference: ${systemMapGapRecoveryCommand(opts, ['<callee-from-connected-behavior>'])}.`,
    );
  }

  if (result.regions.length === 0) {
    console.log('\nNo structural regions matched the supplied anchors.');
  } else {
    console.log('\n═══ COLLAPSED SYSTEM REGIONS ═══');
    for (const region of presentedRegions) {
      const expansion = region.expanded ? 'expanded' : 'collapsed';
      const shownNotableSymbols = region.notableSymbols.slice(0, 2);
      if (hasExpandedRegions) {
        console.log(
          `  d${region.minDepth} [${expansion}] ${region.id} — ${region.fileCount} file; ` +
            `${region.symbolCount} sym; ${region.literalHitCount} hit; ` +
            `${region.relationKinds.join(',') || 'anchor-only'}; ` +
            `${region.incomingRegionIds.length} in/${region.outgoingRegionIds.length} out` +
            `${region.memberCallCandidateRelationCount > 0 ? `; ${region.memberCallCandidateRelationCount} M-candidate` : ''}`,
        );
        continue;
      }
      if (hasConnectedBehavior) {
        console.log(
          `  d${region.minDepth} [${expansion}] ${region.id} — ${region.fileCount} file; ` +
            `${region.symbolCount} sym; ${region.relationKinds.join(',') || 'anchor-only'}; ` +
            `${region.incomingRegionIds.length} in/${region.outgoingRegionIds.length} out`,
        );
        continue;
      }
      console.log(
        `  depth ${region.minDepth} [${expansion}] ${region.id} — ` +
          `${region.fileCount} file (${region.sourceFileCount} src/${region.testFileCount} test); ` +
          `${region.symbolCount} sym; ${region.literalHitCount} hit; ` +
          `${region.relationKinds.join(',') || 'anchor-only'}; ` +
          `${region.incomingRegionIds.length} in/${region.outgoingRegionIds.length} out` +
          `${region.memberCallCandidateRelationCount > 0 ? `; ${region.memberCallCandidateRelationCount} M-candidate` : ''}\n` +
          `    anchors: ${region.anchorQueries.join(', ') || 'none'}; drill: ` +
          `${
            shownNotableSymbols
              .map((symbol) => `${compactSystemMapIdentity(symbol.shortName)} (${symbol.file})`)
              .join(', ') || 'none'
          }${
            region.symbolCount > shownNotableSymbols.length
              ? `; +${region.symbolCount - shownNotableSymbols.length}`
              : ''
          }`,
      );
    }
  }

  if (!result.presentation.complete) {
    console.log('\n═══ TOPOLOGY WITHHELD MANIFEST ═══');
    console.log(
      `  The ${result.presentation.maxCharacters}-character topology budget selected ` +
        `${result.presentation.regionIds.length}/${result.regions.length} region(s) and ` +
        `${result.presentation.relationKeys.length}/${result.regionRelations.length} cross-region relation(s).`,
    );
    if (result.presentation.omittedRegionIds.length > 0) {
      console.log(`  Withheld region ids: ${summarizeMapValues(result.presentation.omittedRegionIds, 12)}.`);
    }
    console.log(
      `  Structured JSON retains all facts. Expand the human topology without paging: ${result.presentation.expansionCommand}`,
    );
  }

  if (!hasExpandedRegions && !hasConnectedBehavior && result.expansion?.command) {
    console.log('\n═══ NEXT ABSTRACTION LEVEL ═══');
    if (result.expansion.command) {
      const matchOnlyRegions = result.regions.length - result.expansion.regionCount;
      const candidateRegions = result.expansion.candidateRegionCount ?? result.expansion.regionCount;
      const omittedRegions = result.expansion.omittedRegionIds ?? [];
      console.log(
        `  Expand ${result.expansion.regionCount}/${candidateRegions} ranked traversal-relevant region(s) in one complete child-file summary; ` +
          `${matchOnlyRegions} other observed region(s) remain visible above.`,
      );
      console.log(`  Expand together: ${result.expansion.command}`);
      if (omittedRegions.length > 0) {
        console.log(
          `  Withheld traversal-relevant regions: ${omittedRegions.join(', ')}. Add several --expand selectors to the command when they can change the decision.`,
        );
      }
    }
  }

  if (presentedRelations.length > 0) {
    console.log('\n═══ CROSS-REGION RELATIONSHIPS ═══');
    if (!hasConnectedBehavior) {
      console.log(
        '  Evidence A=AST callsite; M=source candidate (receiver type unproved); S=semantic callee; C=SCIP chunk; K=cross-workspace contract symbol; I=index/source import; R=index/source reference; B=proven runtime-boundary join.',
      );
    }
    for (const relation of presentedRelations) {
      console.log(
        `  ${compactSystemMapRegionId(relation.fromRegionId)} → ${compactSystemMapRegionId(relation.toRegionId)} — ` +
          `${relation.relationCount} rel [${relation.kinds.join(',')}; ` +
          `${relation.evidence.map(compactSystemMapRelationEvidence).join(',')}]`,
      );
    }
  }

  if (result.boundaryFrontiers.length > 0) {
    console.log('\n═══ UNRESOLVED RUNTIME BOUNDARIES ═══');
    const buckets = groupSystemMapBoundaryFrontiers(result.boundaryFrontiers);
    const shown = buckets.slice(0, hasConnectedBehavior ? 3 : 8);
    for (const bucket of shown) {
      const examples = bucket.frontiers
        .slice(0, hasConnectedBehavior ? 1 : 2)
        .map(
          (frontier) => `${compactBoundaryAddress(frontier.address)} @ ${frontier.file}:${displayLine(frontier.line)}`,
        );
      console.log(`  [${bucket.strength}] ${bucket.action} ×${bucket.frontiers.length} — ${examples.join('; ')}`);
      if (!hasConnectedBehavior) console.log(`    ${bucket.reason}`);
    }
    if (buckets.length > shown.length) {
      console.log(
        `  ${buckets.length - shown.length} additional frontier bucket(s); every observation and reason remains in --json.`,
      );
    }
    if (hasConnectedBehavior) {
      console.log(
        '  These are disclosed candidate observations, not proven connector edges; expand only when a named missing fact crosses one of them.',
      );
    }
  }

  if (result.externalBoundaries.length > 0) {
    console.log('\n═══ EXTERNAL IMPORT BOUNDARIES ═══');
    console.log(
      hasConnectedBehavior
        ? `  ${result.externalBoundaries.length} imported external symbol(s) remain accounted in the structured result.`
        : `  ${result.externalBoundaries.length} imported external symbol(s): ` +
            `${summarizeMapValues(
              result.externalBoundaries.map((boundary) => boundary.name),
              12,
            )}. ` +
            'Use --json when the complete external-import list can change the decision.',
    );
  }

  const expanded = presentedRegions.filter((region) => region.expanded);
  if (expanded.length > 0) {
    console.log('\n═══ EXPANDED REGIONS ═══');
    console.log(
      '  Every child file is listed. d=depth; S/T/E/B/W=source/test/entry/barrel/worker; ' +
        'sym/hit/rel counts are complete; C/I/R/B=call/import/reference/runtime-boundary; x=connected-region count; ' +
        'final names are ranked symbol@line drill candidates.',
    );
    for (const region of expanded) {
      console.log(`  ${region.label}  (${region.id})`);
      printSystemMapChildFiles(region);
    }
    if (result.drilldown?.command) {
      console.log('\n═══ BATCHED DRILL-DOWN ═══');
      console.log(
        `  ${result.drilldown.selectedAnchors}/${result.drilldown.candidateAnchors} coverage-diverse child-file anchor(s) selected` +
          `${result.drilldown.omittedAnchors > 0 ? `; ${result.drilldown.omittedAnchors} withheld by the ranked drill-down budget and still listed above` : ''}.`,
      );
      console.log(`  Inspect the selected behavior together: ${result.drilldown.command}`);
      if (result.drilldown.definitionCommand) {
        console.log(`  Full-source escalation for the selected exact units: ${result.drilldown.definitionCommand}`);
      }
    }
  }

  if (result.unmatchedExpansions.length > 0) {
    console.error(`\nUnmatched expansion id(s): ${result.unmatchedExpansions.join(', ')}`);
  }
  console.log(
    `\nQuery plan: relations=${result.coverage.requestedRelationKinds.join(',')}; ` +
      `evidence>=${result.coverage.evidenceFloor}; scopes=${result.coverage.includedSourceScopes.join(',')}.`,
  );
  console.log(
    `Query closure: ${result.closure.status}; emitted ${result.closure.emitted.regions} region(s), ` +
      `${result.closure.emitted.relations} relation(s), and ${result.closure.emitted.runtimeLinks} runtime link(s); ` +
      `withheld ${result.closure.withheld.symbols} symbol(s), ${result.closure.withheld.files} file(s), ` +
      `${result.closure.withheld.regions} region(s), and ${result.closure.withheld.drillAnchors} drill anchor(s); ` +
      `${result.closure.ambiguous.anchors} ambiguous anchor(s), ${result.closure.external} external boundary(ies), ` +
      `${result.closure.unresolved} unresolved runtime frontier(s).`,
  );
  console.log(`  ${result.closure.explanation}`);
  console.log(
    `\nCoverage: ${result.coverage.matchedAnchorCount}/${result.coverage.explicitAnchorCount} anchor(s) matched; ` +
      `${result.regions.length} region(s); depth ${result.coverage.maxTraversalDepth}; ` +
      `${result.coverage.frontierSymbols} untraversed symbol(s); ${result.coverage.frontierFiles} untraversed file(s); ` +
      `${result.coverage.supportFilesNotTraversed} visible support file(s) not traversed; ` +
      `${result.coverage.filteredUnverifiedCallEdges} unverified call edge(s) filtered; ` +
      `${result.coverage.memberCallCandidateEdges} source-attributed member-call candidate edge(s); ` +
      `${result.coverage.unresolvedMemberCallsites} unresolved member callsite(s); ` +
      `${result.coverage.runtimeBoundaryTraversedLinks}/${result.coverage.runtimeBoundaryExactLinks + result.coverage.runtimeBoundaryDerivedLinks} map-relevant proven runtime-boundary link(s) traversed ` +
      `(${result.coverage.repositoryRuntimeBoundaryExactLinks + result.coverage.repositoryRuntimeBoundaryDerivedLinks} repository-wide); ` +
      `${result.coverage.runtimeBoundaryCandidateLinks} candidate boundary link(s); ` +
      `${result.coverage.runtimeBoundaryFrontiers} relevant unresolved boundary frontier(s); ` +
      `${result.coverage.referenceExpansionEligibleSymbols} symbol(s) reverse-expanded and ` +
      `${result.coverage.referenceExpansionSkippedSymbols} discovered symbol(s) not reverse-expanded.`,
  );
  if (!result.coverage.symbolCandidateSetsComplete) {
    console.log(`Symbol resolution omitted ${result.coverage.omittedSymbolCandidates} ambiguous candidate(s).`);
  }
  console.log('Blind spots:');
  const shownBlindSpots = hasConnectedBehavior ? result.coverage.blindSpots.slice(0, 2) : result.coverage.blindSpots;
  for (const blindSpot of shownBlindSpots) console.log(`  - ${blindSpot}`);
  if (result.coverage.blindSpots.length > shownBlindSpots.length) {
    console.log(
      `  - ${result.coverage.blindSpots.length - shownBlindSpots.length} additional disclosed limitation(s) remain in coverage.blindSpots.`,
    );
  }
  if (hasConnectedBehavior) {
    const answerAuditEntries = new Map<string, Map<string, string | null>>([
      ['branch conditions', new Map()],
      ['structured payloads', new Map()],
      ['terminal outcomes', new Map()],
    ]);
    for (const step of result.behavior?.steps ?? []) {
      if (!step.location || !step.behavior) continue;
      for (const line of step.behavior.lines) {
        const location = `${step.location.file}:${displayLine(line.line)}`;
        if (line.signals.includes('branch')) answerAuditEntries.get('branch conditions')?.set(location, null);
        if (
          line.signals.includes('shape') &&
          (line.signals.includes('call') || line.signals.includes('mutation') || line.signals.includes('return'))
        ) {
          answerAuditEntries.get('structured payloads')?.set(location, line.text.replace(/\s*\n\s*/gu, ' '));
        }
        if (line.signals.includes('return') || line.signals.includes('throw')) {
          answerAuditEntries.get('terminal outcomes')?.set(location, null);
        }
      }
    }
    console.log('\n═══ ANSWER EVIDENCE CONTRACT ═══');
    console.log(
      '  Before another query, account for each question-relevant condition and outcome already rendered above. ' +
        'Preserve exact ownership/lifetime (including singleton/shared/per-invocation scope), normalization and path rules, invocation arguments, working directory ' +
        'and standard I/O, bounds/defaults, returned fields or instructions, every condition that stops or continues ' +
        'the enclosing loop, policy or dispatch precedence and bypass scope, and rethrown-versus-rendered ' +
        'interruption behavior.',
    );
    console.log(
      '  Draft audit locations are mechanically derived from selected syntax. For every category material to the question, explicitly account for every listed location:',
    );
    for (const [label, entries] of answerAuditEntries) {
      if (entries.size === 0) continue;
      if (label === 'structured payloads') {
        console.log(`  Draft audit — ${label}:`);
        for (const [location, source] of entries) console.log(`    ${location} — ${source ?? ''}`);
      } else {
        console.log(`  Draft audit — ${label}: ${[...entries.keys()].join(', ')}`);
      }
    }
    console.log(
      '  No causal target is automatically recommended. Use the adjacent recovery inventory only for a named material fact with no rendered evidence; otherwise answer from the map.',
    );
  }
});

type SystemMapNextAnchors = NonNullable<ReturnType<typeof queries.systemMap>['nextAnchors']>;

function printSystemMapGapRecovery(
  nextAnchors: SystemMapNextAnchors | undefined,
  requestedCallees: readonly string[],
): void {
  console.log('═══ OPTIONAL GAP RECOVERY (ONLY AFTER NAMING A MISSING FACT) ═══');
  if (!nextAnchors || nextAnchors.candidateAnchors === 0) {
    console.log('  No causal drill targets were resolved from the connected behavior.');
    return;
  }
  if (requestedCallees.length === 0) {
    throw new Error('--gap-recovery-only requires at least one --gap-callee named in connected behavior.');
  }
  const requested = new Set(requestedCallees.map(normalizedGapCallee));
  const selected = [...nextAnchors.anchors, ...nextAnchors.withheldAnchors].filter((anchor) =>
    [anchor.callsite.calleeLeaf, ...anchor.alternatives.map((alternative) => alternative.label)].some((value) =>
      requested.has(normalizedGapCallee(value)),
    ),
  );
  if (selected.length === 0) {
    console.log(
      `  No resolved target matched ${requestedCallees.map(shellArgument).join(', ')}. ` +
        'Copy callee names exactly from connected behavior.',
    );
    return;
  }
  console.log(
    `  ${selected.length}/${nextAnchors.candidateAnchors} causal target(s) matched the named callee selector(s); ` +
      'no English intent inferred.',
  );
  for (const anchor of selected) {
    const first = anchor.alternatives[0];
    const target = first
      ? `${compactSystemMapIdentity(first.label)} @ ${first.file}:${displayLine(first.line)}`
      : anchor.callsite.calleeLeaf;
    const signals = anchor.callsite.signals.filter((signal) => signal !== 'anchor' && signal !== 'call').join(',');
    const causal = [anchor.direction, anchor.causalRole, anchor.relationKind].filter(Boolean).join('; ');
    console.log(
      `  [${anchor.status}; ${anchor.source}${causal ? `; ${causal}` : ''}${signals ? `; ${signals}` : ''}] ${target}` +
        `${anchor.alternativeCount > 1 ? ` — ${anchor.alternativeCount} possible identities` : ''}`,
    );
    console.log(
      `    from ${compactSystemMapIdentity(anchor.fromLabel)} @ ${anchor.callsite.file}:${displayLine(anchor.callsite.line)} — ` +
        anchor.callsite.text.slice(0, 220),
    );
    if (anchor.alternativeCount > 1) {
      for (const alternative of anchor.alternatives) {
        console.log(
          `      candidate: ${compactSystemMapIdentity(alternative.label)} @ ${alternative.file}:${displayLine(alternative.line)}`,
        );
      }
    }
  }
  const exactTargets = new Map<string, { file: string; line: number }>();
  for (const anchor of selected) {
    if (anchor.alternativeCount !== 1) continue;
    const target = anchor.alternatives[0];
    if (target) exactTargets.set(`${target.file}:${target.line}`, target);
  }
  if (exactTargets.size > 0) {
    console.log(
      `  Inspect named targets together: scip-query inspect ${[...exactTargets.values()]
        .map((target) => `--at ${shellArgument(`${target.file}:${displayLine(target.line)}`)}`)
        .join(' ')} --view behavior`,
    );
  }
  if (selected.some((anchor) => anchor.source === 'leaf-identity-candidate' || anchor.status === 'ambiguous')) {
    console.log(
      '  Identity candidates locate possible definitions but do not prove the receiver-to-callee edge; confirm before making a relationship claim.',
    );
  }
}

function systemMapGapRecoveryCommand(
  opts: CommandOptions,
  callees = stringArrayOptionValue(opts, 'gapCallee'),
): string {
  const parts = ['scip-query', 'system-map'];
  for (const search of stringArrayOptionValue(opts, 'search')) parts.push('--search', shellArgument(search));
  for (const symbol of stringArrayOptionValue(opts, 'symbol')) parts.push('--symbol', shellArgument(symbol));
  for (const focus of stringArrayOptionValue(opts, 'focusAt')) parts.push('--focus-at', shellArgument(focus));
  parts.push('--depth', String(definedNumberOption(opts, 'depth', 5)));
  for (const relation of stringArrayOptionValue(opts, 'relation')) parts.push('--relation', shellArgument(relation));
  const evidenceFloor = stringOptionValue(opts, 'evidenceFloor');
  if (evidenceFloor) parts.push('--evidence-floor', shellArgument(evidenceFloor));
  for (const scope of stringArrayOptionValue(opts, 'sourceScope')) {
    parts.push('--source-scope', shellArgument(scope));
  }
  if (booleanOptionValue(opts, 'fullLiteralTraversal')) parts.push('--full-literal-traversal');
  for (const region of stringArrayOptionValue(opts, 'expand')) parts.push('--expand', shellArgument(region));
  for (const frontier of stringArrayOptionValue(opts, 'frontier')) parts.push('--frontier', shellArgument(frontier));
  for (const route of stringArrayOptionValue(opts, 'route')) parts.push('--route', shellArgument(route));
  for (const callee of callees) parts.push('--gap-callee', shellArgument(callee));
  parts.push('--gap-recovery-only');
  return parts.join(' ');
}

function systemMapRouteSelectionCommand(opts: CommandOptions, routes: readonly string[]): string {
  const parts = ['scip-query', 'system-map'];
  for (const search of stringArrayOptionValue(opts, 'search')) parts.push('--search', shellArgument(search));
  for (const symbol of stringArrayOptionValue(opts, 'symbol')) parts.push('--symbol', shellArgument(symbol));
  for (const focus of stringArrayOptionValue(opts, 'focusAt')) parts.push('--focus-at', shellArgument(focus));
  parts.push('--depth', String(definedNumberOption(opts, 'depth', 5)));
  for (const relation of stringArrayOptionValue(opts, 'relation')) parts.push('--relation', shellArgument(relation));
  const evidenceFloor = stringOptionValue(opts, 'evidenceFloor');
  if (evidenceFloor) parts.push('--evidence-floor', shellArgument(evidenceFloor));
  for (const scope of stringArrayOptionValue(opts, 'sourceScope')) parts.push('--source-scope', shellArgument(scope));
  if (booleanOptionValue(opts, 'fullLiteralTraversal')) parts.push('--full-literal-traversal');
  for (const region of stringArrayOptionValue(opts, 'expand')) parts.push('--expand', shellArgument(region));
  for (const frontier of stringArrayOptionValue(opts, 'frontier')) parts.push('--frontier', shellArgument(frontier));
  for (const route of routes) parts.push('--route', shellArgument(route));
  return parts.join(' ');
}

function normalizedGapCallee(value: string): string {
  const compact = value.replace(/\(\)$/u, '').replace(/^#/u, '');
  return (
    compact.slice(Math.max(compact.lastIndexOf(':'), compact.lastIndexOf('.')) + 1) || compact
  ).toLocaleLowerCase();
}

function systemMapBehaviorFocus(value: string): { file: string; line: number } {
  const match = value.match(/^(.+):(\d+)$/u);
  const display = match ? Number(match[2]) : Number.NaN;
  if (!match || !Number.isSafeInteger(display) || display <= 0) {
    throw new Error(`Invalid --focus-at location '${value}'; expected path:line with a positive line number.`);
  }
  return { file: match[1]!, line: display - 1 };
}

export function renderCausalCorridor(topology: ExplorationTopology, behavior?: ConnectedBehaviorPacket): void {
  const corridor = topology.corridor;
  if (!corridor) return;
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(topology.edges.map((edge) => [edge.id, edge]));
  const labels = (nodeIds: readonly string[]): string =>
    nodeIds.map((nodeId) => compactSystemMapIdentity(nodeById.get(nodeId)?.label ?? nodeId)).join(', ');
  const ownedByOwner = new Map<string, string[]>();
  const representedBehaviorLinesByFile = new Map<string, Array<{ line: number; endLine: number }>>();
  for (const step of behavior?.steps ?? []) {
    if (!step.location || !step.behavior) continue;
    const lines = representedBehaviorLinesByFile.get(step.location.file) ?? [];
    lines.push(...step.behavior.lines.map((line) => ({ line: line.line, endLine: line.endLine })));
    representedBehaviorLinesByFile.set(step.location.file, lines);
  }
  const behaviorRepresents = (node: (typeof topology.nodes)[number] | undefined): boolean => {
    if (!node?.location) return false;
    return (representedBehaviorLinesByFile.get(node.location.file) ?? []).some(
      (line) => node.location!.line >= line.line && node.location!.line <= line.endLine,
    );
  };
  const summarizedControlByOwner = new Map<string, Map<string, number>>();
  const localControlByOwner = new Map<
    string,
    Map<
      string,
      {
        controllerLabel: string;
        controllerLocation: { file: string; line: number } | null;
        outcomes: Map<string, Set<string>>;
      }
    >
  >();
  const materialFacts: Array<{
    edge: (typeof topology.edges)[number];
    semantic: NonNullable<(typeof topology.edges)[number]['semantics']>[number];
  }> = [];
  const groupedFacts = new Map<
    string,
    {
      family: string;
      subtype: string;
      ownerLabel: string;
      ownerLocation: { file: string; line: number } | null;
      count: number;
      targetLabels: Set<string>;
      values: Set<string>;
    }
  >();
  for (const edgeId of corridor.edgeIds) {
    const edge = edgeById.get(edgeId);
    if (!edge) continue;
    for (const semantic of edge.semantics ?? []) {
      if (semantic.family === 'identity') {
        const children = ownedByOwner.get(edge.fromNodeId) ?? [];
        children.push(edge.toNodeId);
        ownedByOwner.set(edge.fromNodeId, children);
      } else if (semantic.family === 'control' && !isRenderedNavigationSemantic(semantic.subtype)) {
        const from = nodeById.get(edge.fromNodeId);
        const target = nodeById.get(edge.toNodeId);
        const ownerId =
          typeof from?.attributes['ownerNodeId'] === 'string' ? from.attributes['ownerNodeId'] : edge.fromNodeId;
        if (behaviorRepresents(from) && behaviorRepresents(target)) {
          const counts = summarizedControlByOwner.get(ownerId) ?? new Map<string, number>();
          counts.set(semantic.subtype, (counts.get(semantic.subtype) ?? 0) + 1);
          summarizedControlByOwner.set(ownerId, counts);
          continue;
        }
        const decisions = localControlByOwner.get(ownerId) ?? new Map();
        const decision = decisions.get(edge.fromNodeId) ?? {
          controllerLabel: from?.label ?? compactSystemMapIdentity(edge.fromNodeId),
          controllerLocation: from?.location ? { file: from.location.file, line: from.location.line } : null,
          outcomes: new Map<string, Set<string>>(),
        };
        const outcomes = decision.outcomes.get(semantic.subtype) ?? new Set<string>();
        outcomes.add(target?.label ?? compactSystemMapIdentity(edge.toNodeId));
        decision.outcomes.set(semantic.subtype, outcomes);
        decisions.set(edge.fromNodeId, decision);
        localControlByOwner.set(ownerId, decisions);
      } else if (shouldGroupCorridorSemantic(semantic.family, semantic.subtype)) {
        const owner = corridorFactOwner(edge.fromNodeId, nodeById);
        const key = `${semantic.family}\0${semantic.subtype}\0${owner.label}`;
        const group = groupedFacts.get(key) ?? {
          family: semantic.family,
          subtype: semantic.subtype,
          ownerLabel: owner.label,
          ownerLocation: owner.location,
          count: 0,
          targetLabels: new Set<string>(),
          values: new Set<string>(),
        };
        group.count += 1;
        group.targetLabels.add(compactSystemMapIdentity(nodeById.get(edge.toNodeId)?.label ?? edge.toNodeId));
        const value = semantic.attributes?.['value'];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          group.values.add(String(value));
        }
        groupedFacts.set(key, group);
      } else {
        materialFacts.push({ edge, semantic });
      }
    }
  }

  console.log('\n═══ CAUSAL CORRIDOR ═══');
  console.log(
    `  [${corridor.status}] ${corridor.startNodeIds.length} anchor node(s) → ${corridor.outcomeNodeIds.length} mechanical outcome(s); ` +
      `${corridor.coverage.protectedNodes} protected node(s), ${corridor.coverage.protectedEdges} protected edge(s).`,
  );
  console.log(`  Starts: ${labels(corridor.startNodeIds) || 'none proved'}`);
  console.log(`  Outcomes: ${renderCorridorOutcomes(corridor.outcomeNodeIds, topology)}`);
  for (const [ownerId, childIds] of [...ownedByOwner].sort(([left], [right]) => left.localeCompare(right))) {
    const kinds = new Map<string, number>();
    for (const childId of new Set(childIds)) {
      const kind = nodeById.get(childId)?.kind ?? 'unknown';
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    const kindSummary = [...kinds]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => `${kind}×${count}`)
      .join(', ');
    console.log(`  [owns] ${labels([ownerId])} → ${new Set(childIds).size} local construct(s) [${kindSummary}]`);
  }
  for (const [ownerId, counts] of [...summarizedControlByOwner].sort(([left], [right]) => left.localeCompare(right))) {
    const summary = [...counts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([subtype, count]) => `${subtype}×${count}`)
      .join(', ');
    console.log(`  [local-control] ${labels([ownerId])} — ${summary}; exact decisions are represented below`);
  }
  for (const [ownerId, decisions] of [...localControlByOwner].sort(([left], [right]) => left.localeCompare(right))) {
    for (const decision of [...decisions.values()].sort(
      (left, right) =>
        (left.controllerLocation?.file ?? '').localeCompare(right.controllerLocation?.file ?? '') ||
        (left.controllerLocation?.line ?? -1) - (right.controllerLocation?.line ?? -1) ||
        left.controllerLabel.localeCompare(right.controllerLabel),
    )) {
      const outcomes = [...decision.outcomes]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([subtype, targetLabels]) => [...targetLabels].sort().map((target) => `${subtype} → ${target}`))
        .join('; ');
      const location = decision.controllerLocation
        ? ` @ ${decision.controllerLocation.file}:${displayLine(decision.controllerLocation.line)}`
        : '';
      console.log(`  [local-control] ${labels([ownerId])}: ${decision.controllerLabel} — ${outcomes}${location}`);
    }
  }
  for (const group of [...groupedFacts.values()].sort(
    (left, right) =>
      left.ownerLabel.localeCompare(right.ownerLabel) ||
      left.family.localeCompare(right.family) ||
      left.subtype.localeCompare(right.subtype),
  )) {
    const targets =
      group.family === 'control'
        ? `; targets=[${[...group.targetLabels].sort().join(', ')}]`
        : group.family === 'data' && group.subtype === 'constant-to-parameter'
          ? `; values=[${[...group.values].sort().join(', ')}]`
          : group.family === 'data'
            ? `; ${group.targetLabels.size} parameter target(s)`
            : '';
    const location = group.ownerLocation
      ? ` @ ${group.ownerLocation.file}:${displayLine(group.ownerLocation.line)}`
      : '';
    console.log(
      `  [${group.family}:${group.subtype}; grouped] ${group.ownerLabel} — ${group.count} proved edge(s)${targets}${location}`,
    );
  }
  for (const { edge, semantic } of materialFacts) {
    const qualifiers = {
      ...(semantic.context ?? {}),
      ...(semantic.attributes ?? {}),
    };
    const renderedQualifiers = Object.entries(qualifiers)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ');
    const location = edge.evidence.find((evidence) => evidence.location)?.location;
    console.log(
      `  [${semantic.family}:${semantic.subtype}] ${labels([edge.fromNodeId])} → ${labels([edge.toNodeId])}` +
        `${renderedQualifiers ? `; ${renderedQualifiers}` : ''}` +
        `${location ? ` @ ${location.file}:${displayLine(location.line)}` : ''}`,
    );
  }
  console.log(
    `  Frontier manifest: ${corridor.accountedFrontierIds.length} accounted; ` +
      `${corridor.unresolvedFrontierIds.length} unsupported; ${corridor.unresolvedEdgeIds.length} candidate/unknown edge(s).`,
  );
  if (groupedFacts.size > 0) {
    console.log(
      '  Grouped edge identities remain in the structured corridor; inspect a named owner only when that flow is material.',
    );
  }
  if (corridor.status === 'incomplete') console.log(`  ${corridor.explanation}`);
}

function shouldGroupCorridorSemantic(family: string, subtype: string): boolean {
  return (
    (family === 'control' && isRenderedNavigationSemantic(subtype)) ||
    (family === 'data' && ['argument-to-parameter', 'constant-to-parameter'].includes(subtype)) ||
    (family === 'temporal' && ['await-completion-before', 'awaits-completion', 'lexical-successor'].includes(subtype))
  );
}

function corridorFactOwner(
  nodeId: string,
  nodeById: ReadonlyMap<string, ExplorationTopology['nodes'][number]>,
): { label: string; location: { file: string; line: number } | null } {
  const node = nodeById.get(nodeId);
  const ownerNodeId = typeof node?.attributes['ownerNodeId'] === 'string' ? node.attributes['ownerNodeId'] : null;
  const ownerNode = ownerNodeId ? nodeById.get(ownerNodeId) : null;
  const ownerSymbol = typeof node?.attributes['ownerSymbol'] === 'string' ? node.attributes['ownerSymbol'] : null;
  return {
    label: compactSystemMapIdentity(ownerNode?.label ?? ownerSymbol ?? node?.label ?? nodeId),
    location: ownerNode?.location ?? node?.location ?? null,
  };
}

function isRenderedNavigationSemantic(subtype: string): boolean {
  return ['call', 'discriminator-dispatch', 'result-callback', 'runtime-handoff'].includes(subtype);
}

function renderCorridorOutcomes(outcomeNodeIds: readonly string[], topology: ExplorationTopology): string {
  if (outcomeNodeIds.length === 0) return 'none proved';
  const outcomes = new Set(outcomeNodeIds);
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  const stateResources = new Set<string>();
  const navigationTargets = new Set<string>();
  let returned = 0;
  let thrown = 0;
  const classified = new Set<string>();
  for (const edge of topology.edges) {
    if (!outcomes.has(edge.toNodeId)) continue;
    for (const semantic of edge.semantics ?? []) {
      if (semantic.family === 'state') {
        stateResources.add(compactSystemMapIdentity(nodeById.get(edge.toNodeId)?.label ?? edge.toNodeId));
        classified.add(edge.toNodeId);
      } else if (semantic.family === 'control' && isRenderedNavigationSemantic(semantic.subtype)) {
        navigationTargets.add(compactSystemMapIdentity(nodeById.get(edge.toNodeId)?.label ?? edge.toNodeId));
        classified.add(edge.toNodeId);
      } else if (semantic.family === 'control' && semantic.subtype === 'returns') {
        returned += 1;
        classified.add(edge.toNodeId);
      } else if (semantic.family === 'control' && semantic.subtype === 'throws') {
        thrown += 1;
        classified.add(edge.toNodeId);
      }
    }
  }
  return [
    navigationTargets.size > 0 ? `navigation=[${[...navigationTargets].sort().join(', ')}]` : '',
    stateResources.size > 0 ? `resources=[${[...stateResources].sort().join(', ')}]` : '',
    returned > 0 ? `return×${returned}` : '',
    thrown > 0 ? `throw×${thrown}` : '',
    outcomeNodeIds.length > classified.size ? `other-causal-sink×${outcomeNodeIds.length - classified.size}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printSystemMapChildFiles(region: ReturnType<typeof queries.systemMap>['regions'][number]): void {
  const symbolsByFile = groupBy(region.symbols, (symbol) => symbol.file);
  const hitsByFile = groupBy(region.literalHits, (hit) => hit.file);
  const relationsByFile = new Map<string, typeof region.relations>();
  for (const relation of region.relations) {
    for (const file of new Set([relation.fromFile, relation.toFile])) {
      if (!region.files.some((candidate) => candidate.file === file)) continue;
      const bucket = relationsByFile.get(file) ?? [];
      bucket.push(relation);
      relationsByFile.set(file, bucket);
    }
  }

  for (const file of region.files) {
    const symbols = (symbolsByFile.get(file.file) ?? []).sort(compareSystemMapDrilldownSymbols);
    const hits = hitsByFile.get(file.file) ?? [];
    const relations = relationsByFile.get(file.file) ?? [];
    const shownSymbols = symbols.slice(0, 4);
    const relationKinds = [...new Set(relations.map((relation) => relation.kind))].sort();
    const connectedRegions = [
      ...new Set(
        relations.flatMap((relation) =>
          [relation.fromRegionId, relation.toRegionId].filter((regionId) => regionId !== region.id),
        ),
      ),
    ].sort();
    const drilldown =
      shownSymbols.length > 0
        ? shownSymbols
            .map((symbol) => `${compactSystemMapIdentity(symbol.shortName)}@${displayLine(symbol.startLine)}`)
            .join(', ') + (symbols.length > shownSymbols.length ? `; +${symbols.length - shownSymbols.length}` : '')
        : 'none';
    console.log(
      `    d${file.depth} ${compactSystemMapFileKind(file.kind)} ${file.file} | ` +
        `sym${symbols.length} hit${hits.length} rel${relations.length}` +
        `${relationKinds.length > 0 ? `:${relationKinds.map(compactSystemMapRelationKind).join('/')}` : ''} ` +
        `x${connectedRegions.length} | ${drilldown}`,
    );
    for (const hit of hits) {
      console.log(`      literal ${hit.query}@${displayLine(hit.line)}  ${hit.sourceLine}`);
    }
  }
}

function compactSystemMapIdentity(value: string): string {
  const segments = value.split(':');
  return segments.at(-1) || value;
}

function groupSystemMapBoundaryFrontiers<
  T extends {
    action: string;
    strength: string;
    reason: string;
  },
>(frontiers: readonly T[]): Array<{ action: string; strength: string; reason: string; frontiers: T[] }> {
  const grouped = new Map<string, { action: string; strength: string; reason: string; frontiers: T[] }>();
  for (const frontier of frontiers) {
    const key = `${frontier.strength}\0${frontier.action}\0${frontier.reason}`;
    const bucket = grouped.get(key) ?? {
      action: frontier.action,
      strength: frontier.strength,
      reason: frontier.reason,
      frontiers: [],
    };
    bucket.frontiers.push(frontier);
    grouped.set(key, bucket);
  }
  return [...grouped.values()].sort(
    (left, right) => right.frontiers.length - left.frontiers.length || left.action.localeCompare(right.action),
  );
}

function compactBoundaryAddress(value: string): string {
  const oneLine = value.replace(/\s+/gu, ' ').trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}

function compactSystemMapRegionId(value: string): string {
  return value.replace(/^region:(?:apps|packages)\//, '');
}

function compactSystemMapFileKind(value: string): string {
  return { source: 'S', test: 'T', entry: 'E', barrel: 'B', worker: 'W' }[value] ?? value;
}

function compactSystemMapRelationKind(value: string): string {
  return { call: 'C', 'contract-symbol': 'K', import: 'I', reference: 'R', 'runtime-boundary': 'B' }[value] ?? value;
}

function compactSystemMapRelationEvidence(value: string): string {
  if (value.startsWith('runtime-boundary:')) return `B:${value.slice('runtime-boundary:'.length)}`;
  return (
    {
      'ast-callsite': 'A',
      'ast-member-import-candidate': 'M',
      'compiler-cross-workspace-symbol': 'K',
      'semantic-callee': 'S',
      'scip-chunk': 'C',
      'indexed-or-source-import': 'I',
      'indexed-or-source-reference': 'R',
    }[value] ?? value
  );
}

function summarizeMapValues(values: readonly string[], limit: number): string {
  const shown = values.slice(0, limit);
  return `${shown.join(', ')}${values.length > shown.length ? `; ${values.length - shown.length} more` : ''}`;
}

export const graphQueryCommandDescriptors: CommandDescriptor[] = [
  tableQueryCommand({
    id: 'hotspots',
    command: 'hotspots',
    description: 'Rank symbols by cross-file reference count; a reference metric, not runtime contention',
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
      option('--imports-only', 'Analyze only resolved file imports instead of all cross-file symbol references'),
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
    id: 'deep-chains',
    command: 'deep-chains',
    hidden: true,
    description: 'Deprecated alias for dependency-depth',
    agent: analysisAgentContract(
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
      option('--imports-only', 'Measure the import graph instead of the symbol-reference dependency graph'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    renderShape: 'custom',
    docs: doc('Graph'),
    handler: handleDeepChains,
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
        'entry symbols with files, confidence, evidence, and indexed caller counts',
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
              'Source/compiler-grounded entry evidence and indexed caller counts; exported-only candidates remain candidates.',
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
  {
    id: 'system-map',
    command: 'system-map',
    hidden: true,
    description: 'Deprecated compatibility view for collapsed regions and legacy route catalogues; use evidence',
    agent: agentContract(
      'Which components and proven compiler or runtime relationships connect these explicit literals or symbols?',
      'all matched anchors, collapsed structural regions, compiler and exact runtime relationships, unresolved boundary frontiers, simultaneous drilldown summaries, and explicit coverage gaps',
      [],
      'bounded',
      'repository',
      REPOSITORY_OBSERVATION_OPERATION,
      graphProjectionSemanticContract({
        rootKinds: ['text', 'symbol', 'construct', 'runtime-key'],
        edgeFamilies: GRAPH_EVIDENCE_FAMILIES,
        directions: ['incoming', 'outgoing', 'both'],
        operations: ['reachability', 'connecting'],
        compression: ['topology'],
        nonClaims: [
          'Legacy region and next-anchor ranking does not establish task relevance.',
          'Structural region membership does not establish execution.',
        ],
        compatibility: 'deprecated',
      }),
    ),
    options: withJsonOption([
      option('--search <literal>', 'Add an exact indexed-source anchor; repeat to include several', collectValues, []),
      option('--symbol <symbol>', 'Add a symbol anchor; repeat to include several', collectValues, []),
      option(
        '--focus-at <file:line>',
        'Focus connected behavior at one exact source location inside a selected construct; repeat to include several',
        collectValues,
        [],
      ),
      option('--depth <n>', 'Traverse this many relationship levels', parseInteger, 5),
      option(
        '--relation <kind>',
        'Traverse one relation family; repeat for call, contract-symbol, import, reference, or runtime-boundary',
        collectValues,
        [],
      ),
      option('--evidence-floor <floor>', 'Runtime evidence floor: exact or derived'),
      option(
        '--topology-characters <n>',
        'Soft character budget for the first human topology view; complete JSON facts remain available',
        parseInteger,
        12_000,
      ),
      option(
        '--source-scope <scope>',
        'Include one source scope; repeat for production, test, fixture, example, generated, script, or unknown',
        collectValues,
        [],
      ),
      option(
        '--full-literal-traversal',
        'Traverse every literal match after deliberately accepting broad-selector expansion',
      ),
      option(
        '--expand <region-id>',
        'Expand one structural region; repeat to expand several together',
        collectValues,
        [],
      ),
      option(
        '--frontier <frontier-id>',
        'Expand one accounted topology frontier; repeat to expand several together',
        collectValues,
        [],
      ),
      option(
        '--route <route-id>',
        'Select one proved upstream route; repeat to materialize several routes together',
        collectValues,
        [],
      ),
      option(
        '--gap-callee <name>',
        'Resolve one callee already shown in connected behavior; repeat to batch a named gap',
        collectValues,
        [],
      ),
      option(
        '--selection-term <term>',
        'Deprecated no-op retained for command compatibility; query vocabulary no longer changes graph selection',
        collectValues,
        [],
      ),
      option('--gap-recovery-only', 'Render only the --gap-callee targets and one exact batched recovery command'),
    ]),
    evidence: 'mixed',
    claims: mixedClaimContract(
      ['index-generation', 'live-workspace'],
      [
        fixedClaimFamily('matched-anchors', 'anchors', 'compiler-graph'),
        fixedClaimFamily('typed-relations', 'regionRelations', 'repository-source'),
        fixedClaimFamily('structural-grouping', 'regions', 'heuristic'),
        fixedClaimFamily('coverage', 'coverage', 'repository-source'),
      ],
    ),
    renderShape: 'custom',
    docs: doc('Compatibility'),
    handler: handleSystemMap,
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
