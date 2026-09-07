import type { DeadOptions } from '../../../domain/types.js';
import type { InvocationCoverage } from '../../command-kit/command-descriptor-types.js';
import * as queries from '../../../queries/index.js';
import { resolveProjectRoot } from '../../cli-context.js';
import {
  cleanupVerificationFailures,
  createCleanupPatch,
  selectCleanupBatches,
  verifyCleanupPlan,
} from '../../cleanup-verify.js';
import { renderHeuristicNotice } from '../../cli-support.js';
import {
  booleanOptionValue,
  budgetedDbCommand,
  budgetedListCommand,
  budgetedReportCommand,
  dbCommand,
  definedLimitOption,
  definedNumberOption,
  numberOptionValue,
  optionalStringArg,
  printJsonEnvelope,
  reportCommand,
  stringArg,
  stringOptionValue,
} from '../../command-kit/command-execution.js';
import { displayPathRange, displayRange, displaySnippet, render } from '../../render.js';
import { renderDeadGroup } from './renderers.js';

const DEAD_HUMAN_SECTION_LIMIT = 20;

export const handleDead = budgetedDbCommand('dead', ({ db, args, opts, budget }) => {
  const deadOpts: DeadOptions = {
    scope: optionalStringArg(args, 0) || undefined,
    minLoc: definedNumberOption(opts, 'minLoc', 1),
    includeTests: booleanOptionValue(opts, 'includeTests'),
    skipBarrels: booleanOptionValue(opts, 'skipBarrels'),
    includeMembers: booleanOptionValue(opts, 'includeMembers'),
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
  };

  const result = queries.dead(db, deadOpts);
  const full = booleanOptionValue(opts, 'full');
  const sections = deadDisplaySections(
    result.symbols,
    booleanOptionValue(opts, 'onlyDead'),
    booleanOptionValue(opts, 'onlyInternal'),
    full,
  );
  const [deadSection, internalSection, implicitSection] = sections;
  const shownDeadCode = deadSection.shown;
  const shownFileInternal = internalSection.shown;
  const shownImplicitUsage = implicitSection.shown;
  const shownCounts = {
    total: shownDeadCode.length + shownFileInternal.length + shownImplicitUsage.length,
    deadCode: shownDeadCode.length,
    fileInternal: shownFileInternal.length,
    implicitUsage: shownImplicitUsage.length,
    loc: deadSection.loc + internalSection.loc + implicitSection.loc,
  };
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope(
      'dead',
      args,
      opts,
      {
        ...result,
        shown: {
          deadCode: shownDeadCode,
          fileInternal: shownFileInternal,
          implicitUsage: shownImplicitUsage,
        },
        shownCounts,
        totals: {
          total: result.counts.total,
          deadCode: result.counts.deadCode,
          fileInternal: result.counts.fileInternal,
          implicitUsage: result.counts.implicitUsage,
          loc: result.counts.loc,
        },
      },
      { analysisBudget: budget.analysisBudget },
    );
    return;
  }

  renderDeadSections(sections, full, shownCounts.total);
});

type DeadSymbols = ReturnType<typeof queries.dead>['symbols'];
type DeadDisplaySection = ReturnType<typeof deadDisplaySection>;

function deadDisplaySection(
  symbols: DeadSymbols,
  enabled: boolean,
  full: boolean,
  title: string,
  description: string,
  totalLabel: string,
) {
  const shown = enabled ? symbols : [];
  const displayed = full ? shown : shown.slice(0, DEAD_HUMAN_SECTION_LIMIT);
  return {
    enabled,
    title,
    description,
    totalLabel,
    shown,
    displayed,
    loc: shown.reduce((sum, symbol) => sum + symbol.loc, 0),
    displayLoc: displayed.reduce((sum, symbol) => sum + symbol.loc, 0),
  };
}

function deadDisplaySections(
  symbols: DeadSymbols,
  onlyDead: boolean,
  onlyInternal: boolean,
  full: boolean,
): [DeadDisplaySection, DeadDisplaySection, DeadDisplaySection] {
  return [
    deadDisplaySection(
      symbols.filter((symbol) => symbol.kind === 'dead-code'),
      !onlyInternal,
      full,
      'DEAD CODE',
      '  Zero references anywhere -- no cross-file callers AND no same-file uses.\n  Deletion candidates -- confirm with cleanup-plan --verify before deleting.',
      'dead code',
    ),
    deadDisplaySection(
      symbols.filter((symbol) => symbol.kind === 'file-internal'),
      !onlyDead,
      full,
      'FILE-INTERNAL ONLY',
      '  Used only within the same file (no cross-file callers). Could be a\n  single-use helper, an abstraction-in-progress, or a callback registered\n  through a framework path that static analysis cannot trace (signal\n  handlers, event listeners, dependency injection). NOT necessarily dead —\n  review case by case.',
      'file-internal',
    ),
    deadDisplaySection(
      symbols.filter((symbol) => symbol.kind === 'implicit-usage'),
      !onlyDead && !onlyInternal,
      full,
      'IMPLICIT USAGE',
      '  Traits, macros, attributes, ABI exports, or reflection provide a\n  consumer that the static reference graph cannot trace. Investigation\n  signals only — not deletion candidates and not counted as dead code.',
      'implicit usage',
    ),
  ];
}

function renderDeadSections(sections: DeadDisplaySection[], full: boolean, total: number): void {
  if (total === 0) {
    render.empty('No matching dead-code symbols found.');
    return;
  }
  let rendered = false;
  for (const section of sections) {
    if (section.shown.length === 0) continue;
    if (rendered) console.log('');
    renderDeadGroup(section.displayed, section.title, section.description, section.displayLoc, {
      count: section.shown.length,
      loc: section.loc,
    });
    if (!full && section.shown.length > section.displayed.length) {
      console.log(
        `\n  Showing top ${section.displayed.length} by LOC. Re-run with --full for the remaining ${section.shown.length - section.displayed.length}.`,
      );
    }
    rendered = true;
  }
  const totalParts = sections
    .filter((section) => section.enabled)
    .map((section) => `${section.shown.length} ${section.totalLabel} (${section.loc} LOC)`);
  console.log('\n───────────────────────────');
  console.log(`Total: ${total} symbols — ${totalParts.join(' + ')}`);
}

export const handleUnusedImports = budgetedListCommand('unused-imports', {
  query: ({ db, args, budget }) => queries.unusedImports(db, stringArg(args, 0), { semantic: budget.semantic }),
  format: (r) => `  ${r.shortName}  in ${r.importedIn}`,
  emptyMessage: () => 'No unused imports found.',
  after: (rows) => console.log(`\n${rows.length} unused import(s)`),
});

export const handleLocalityCandidates = budgetedDbCommand('locality-candidates', ({ db, args, opts, budget }) => {
  const results = queries.localityCandidates(db, {
    target: optionalStringArg(args, 0) || undefined,
    scope: stringOptionValue(opts, 'scope'),
    minConsumers: definedNumberOption(opts, 'minConsumers', 1),
    limit: definedLimitOption(opts, 'limit', 20),
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
    architecturalBoundarySegments: db.config.locality?.architecturalBoundarySegments,
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('locality-candidates', args, opts, results, { analysisBudget: budget.analysisBudget });
    return;
  }
  if (results.length === 0) return render.empty('No locality candidates found.');
  renderHeuristicNotice('locality candidates');
  for (const r of results) {
    renderLocalityCandidate(r);
  }
  console.log(`\n${results.length} locality candidate(s) found.`);
});

function renderLocalityCandidate(r: ReturnType<typeof queries.localityCandidates>[number]): void {
  const location =
    r.sourceUnit.kind === 'symbol' && r.sourceUnit.startLine !== undefined && r.sourceUnit.endLine !== undefined
      ? displayPathRange(r.sourceUnit.file, r.sourceUnit.startLine, r.sourceUnit.endLine)
      : r.sourceUnit.file;
  console.log(`\n${location}  ${r.sourceUnit.shortName}`);
  console.log(`  Current directory: ${r.currentDirectory}; tier: ${r.recommendedTier}; action: ${r.actionTier}`);
  console.log(`  Consumer coverage: ${r.consumerCoverage}; consumers: ${r.consumerFiles.length}`);
  if (r.nearestCommonDirectory) console.log(`  Nearest common directory: ${r.nearestCommonDirectory}`);
  if (r.suggestedHome) console.log(`  Suggested home: ${r.suggestedHome}`);
  if (r.whyNoSuggestedHome) console.log(`  Suggested home withheld: ${r.whyNoSuggestedHome}`);
  if (r.boundaryMarkers.length > 0) console.log(`  Boundary markers: ${r.boundaryMarkers.join('; ')}`);
  console.log(`  Recommendation: ${r.recommendation}`);
  renderLocalityConsumers(r.consumerFiles);
  for (const counter of r.counterevidence) console.log(`  - counterevidence: ${counter}`);
}

function renderLocalityConsumers(consumers: readonly string[]): void {
  if (consumers.length > 0) {
    for (const consumer of consumers.slice(0, 8)) console.log(`  - consumer: ${consumer}`);
    if (consumers.length > 8) console.log(`  - ... ${consumers.length - 8} more consumer(s)`);
  }
}

export const handlePassthroughCandidates = budgetedListCommand('passthrough-candidates', {
  query: ({ db, opts, budget }) =>
    queries.passthroughCandidates(db, {
      scope: stringOptionValue(opts, 'scope'),
      maxLoc: definedNumberOption(opts, 'maxLoc', 15),
      limit: definedLimitOption(opts, 'limit', 30),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    }),
  format: (r) =>
    `  ${displayPathRange(r.file, r.startLine, r.endLine)}  ${r.shortName}  (${r.loc} LOC)\n` +
    `    Forwards to: ${r.forwardsToShort}  (${r.forwardsToFile}, tier: ${r.actionTier})\n` +
    `    Recommendation: ${r.recommendation}` +
    (r.boundaryEvidence.length > 0 ? `\n    Boundary evidence: ${r.boundaryEvidence.join('; ')}` : '') +
    (r.publicFacadeEvidence.length > 0 ? `\n    Public facade evidence: ${r.publicFacadeEvidence.join('; ')}` : ''),
  emptyMessage: () => 'No passthrough candidates found.',
  heuristicLabel: 'passthrough candidates',
  after: (rows) => console.log(`\n${rows.length} passthrough candidate(s).`),
});

/**
 * Stderr progress for long candidate scans. A terminal sees a line every few
 * seconds; a captured stream sees one every half minute, so a long run is
 * never silent but a machine consumer is not flooded.
 */
function candidateScanProgressReporter(label: string): {
  report: (progress: { evaluated: number; scanned: number; matched: number }) => void;
  finish: () => void;
} {
  const intervalMs = process.stderr.isTTY ? 2_000 : 30_000;
  const started = Date.now();
  let last = started;
  let reported = false;
  return {
    report: (progress) => {
      const now = Date.now();
      if (now - last < intervalMs || progress.evaluated >= progress.scanned) return;
      last = now;
      reported = true;
      console.error(
        `${label}: ${progress.evaluated}/${progress.scanned} candidates scanned, ${progress.matched} finding(s), ${Math.round((now - started) / 1000)}s elapsed`,
      );
    },
    finish: () => {
      if (reported) console.error(`${label}: scan complete in ${Math.round((Date.now() - started) / 1000)}s`);
    },
  };
}

export const handleSliceCohesion = budgetedDbCommand('slice-cohesion', ({ db, args, opts, budget }) => {
  const symbol = optionalStringArg(args, 0) || undefined;
  const explicitScanLimit = numberOptionValue(opts, 'scanLimit');
  const progress = candidateScanProgressReporter('slice-cohesion');
  let counters: SliceCohesionScanCounters | null = null;
  const results = queries.sliceCohesion(db, {
    symbol,
    scope: stringOptionValue(opts, 'scope'),
    minLoc: definedNumberOption(opts, 'minLoc', 12),
    minStatements: definedNumberOption(opts, 'minStatements', 10),
    minClusterUnits: definedNumberOption(opts, 'minCluster', 4),
    limit: definedLimitOption(opts, 'limit', 20),
    scanLimit: explicitScanLimit ?? budget.scanLimit,
    onProgress: progress.report,
    onProfile: (scan) => {
      counters = scan;
    },
  });
  progress.finish();
  if (booleanOptionValue(opts, 'json')) {
    // A targeted symbol is resolved completely. A scan is complete when every
    // candidate was analyzed and every finding printed; a capped scan cannot
    // know its total, and a capped report knows what it omitted.
    const scan = counters as SliceCohesionScanCounters | null;
    const coverage = sliceCohesionInvocationCoverage(symbol, scan, results.length);
    printJsonEnvelope('slice-cohesion', args, opts, results, {
      coverage,
      ...(symbol ? {} : { analysisBudget: budget.analysisBudget }),
    });
    return;
  }
  if (results.length === 0) {
    return render.empty(
      symbol ? `No sliceable TypeScript function matched ${symbol}.` : 'No low-cohesion functions found.',
    );
  }
  renderHeuristicNotice('slice-cohesion candidates');
  if (!symbol && budget.analysisBudget) {
    console.log(
      `Bounded scan: at most ${budget.analysisBudget.scanLimit} candidates, largest first; the count below is not repository-wide.\n`,
    );
  }
  for (const result of results) renderSliceCohesionCandidate(result, Boolean(symbol));
  console.log(`\n${results.length} slice-cohesion candidate(s).`);
});

type SliceCohesionResult = ReturnType<typeof queries.sliceCohesion>[number];
type SliceCohesionScanCounters = { scanLimitApplied: boolean; resultLimitApplied: boolean; matchedResults: number };

function sliceCohesionInvocationCoverage(
  symbol: string | undefined,
  scan: SliceCohesionScanCounters | null,
  returned: number,
): InvocationCoverage {
  if (symbol || !scan) return { complete: true, totalKnown: true, returned, total: returned, omitted: 0 };
  if (scan.scanLimitApplied) return { complete: false, totalKnown: false, returned };
  if (scan.resultLimitApplied)
    return {
      complete: false,
      totalKnown: true,
      returned,
      total: scan.matchedResults,
      omitted: scan.matchedResults - returned,
    };
  return { complete: true, totalKnown: true, returned, total: returned, omitted: 0 };
}

function renderSliceCohesionCandidate(r: SliceCohesionResult, targeted: boolean): void {
  const extractions = r.clusters.filter((cluster) => cluster.role === 'extraction');
  console.log(
    `\n${displayPathRange(r.relativePath, r.startLine, r.endLine)}  ${r.shortName}  (${r.loc} LOC, ${r.statementCount} statements, ${r.archetype}${r.operational ? ', operational' : ''})`,
  );
  console.log(
    `  ${r.actionTier}; local model ${r.coverage.status}; ${extractions.length} extraction(s), ${extractions.filter((cluster) => cluster.narrow).length} narrow; ${r.tierReason}`,
  );
  console.log(`  Recommendation: ${displaySnippet(r.recommendation, 600)}`);
  for (const reason of r.evidenceReasons) console.log(`  - ${displaySnippet(reason, 300)}`);
  if (targeted) renderSliceCohesionDetails(r);
}

function renderSliceCohesionDetails(r: SliceCohesionResult): void {
  console.log('  Outputs:');
  for (const output of r.outputs) {
    console.log(
      `    ${output.id}  [${output.kind}${output.guard ? ', guard' : ''}${output.hook ? ', hook' : ''}]  slice ${output.sliceSize} statement(s)`,
    );
  }
  console.log('  Clusters:');
  r.clusters.forEach((cluster, index) => {
    const interfaceNote =
      cluster.role === 'remainder'
        ? ' (stays in place)'
        : cluster.inputs.length > 0
          ? `; parameters${cluster.narrow ? '' : ' (wide)'} ${cluster.inputs.join(', ')}`
          : '; no parameters';
    console.log(
      `    ${index + 1}. ${cluster.kind}, ${cluster.role}: ${cluster.units.length} statement(s) producing ${cluster.outputs.join(', ')}${interfaceNote}`,
    );
  });
  console.log('  Statements:');
  for (const unit of r.units ?? [])
    console.log(
      `    ${String(unit.index).padStart(3)}  ${unit.kind.padEnd(11)} ${displayRange(unit.startLine, unit.endLine)}  ${displaySnippet(unit.label, 100)}`,
    );
}

export const handleSimilar = budgetedReportCommand('similar', {
  query: ({ db, args, opts, budget }) => {
    if (booleanOptionValue(opts, 'plan')) {
      const symbolA = optionalStringArg(args, 0);
      const symbolB = optionalStringArg(args, 1);
      if (!symbolA || !symbolB) {
        throw new Error('similar --plan requires two symbols: similar <symbol1> <symbol2> --plan');
      }
      return {
        mode: 'plan' as const,
        result: queries.similarConsolidationPlan(db, symbolA, symbolB, {
          scanLimit: budget.scanLimit,
          semantic: budget.semantic,
        }),
      };
    }
    const symbol = optionalStringArg(args, 0);
    if (symbol) {
      return {
        mode: 'target' as const,
        rows: queries.similar(db, symbol, {
          minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.4),
          limit: definedLimitOption(opts, 'limit', 20),
          scanLimit: budget.scanLimit,
          semantic: budget.semantic,
        }),
      };
    }
    return {
      mode: 'all' as const,
      rows: queries.similarAll(db, {
        minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.4),
        limit: definedLimitOption(opts, 'limit', 20),
        scope: stringOptionValue(opts, 'scope'),
        minCallees: definedNumberOption(opts, 'minCallees', 4),
        crossFileOnly: booleanOptionValue(opts, 'crossFileOnly'),
        scanLimit: budget.scanLimit,
        semantic: budget.semantic,
      }),
    };
  },
  emptyMessage: (result) => {
    if (result.mode === 'plan') {
      return result.result ? undefined : 'No similarity evidence found for that pair.';
    }
    if (result.rows.length > 0) return undefined;
    return result.mode === 'target' ? 'No similar symbols found.' : 'No similar symbol pairs found.';
  },
  heuristicLabel: 'similarity candidates',
  render: (result) => {
    if (result.mode === 'plan') {
      const plan = result.result;
      if (!plan) return;
      renderSimilarityPlan(plan);
      return;
    }
    if (result.mode === 'target') {
      render.list(result.rows, (r) => {
        const basis = r.similarityBasis ?? 'callees';
        const sharedLabel = basis === 'source-tokens' ? 'Shared source tokens' : 'Shared callees';
        const onlyLabel = basis === 'source-tokens' ? 'Only tokens in' : 'Only in';
        const lines = [
          `\n${Math.round(r.similarity * 100)}% similar:`,
          `  A: ${r.shortNameA}  (${r.fileA})`,
          `  B: ${r.shortNameB}  (${r.fileB})`,
          `  Evidence class: ${r.evidenceClass}  (tier: ${r.actionTier})`,
          `  Recommendation: ${r.recommendation}`,
          `  ${sharedLabel}: ${r.sharedCallees.join(', ')}`,
        ];
        if (r.evidenceClassReasons.length) lines.push(`  Evidence reasons: ${r.evidenceClassReasons.join('; ')}`);
        if (r.uniqueToA.length) lines.push(`  ${onlyLabel} A: ${r.uniqueToA.join(', ')}`);
        if (r.uniqueToB.length) lines.push(`  ${onlyLabel} B: ${r.uniqueToB.join(', ')}`);
        return lines.join('\n');
      });
      return;
    }

    render.list(
      result.rows,
      (r) =>
        `\n${Math.round(r.similarity * 100)}% similar:\n` +
        `  A: ${r.shortNameA}  (${r.fileA})\n` +
        `  B: ${r.shortNameB}  (${r.fileB})\n` +
        `  Evidence class: ${r.evidenceClass}  (tier: ${r.actionTier})\n` +
        `  Recommendation: ${r.recommendation}\n` +
        (r.evidenceClassReasons.length ? `  Evidence reasons: ${r.evidenceClassReasons.join('; ')}\n` : '') +
        `  Shared ${r.similarityBasis === 'source-tokens' ? 'source tokens' : 'callees'}: ${r.sharedCallees.join(', ')}`,
    );
    console.log(`\n${result.rows.length} similar pair(s) found.`);
  },
});

export const handleSimilarFiles = reportCommand({
  commandName: 'similar-files',
  query: ({ db, args, opts }) =>
    queries.similarFiles(db, {
      minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.5),
      limit: definedLimitOption(opts, 'limit', 20),
      scope: stringOptionValue(opts, 'scope'),
      minDeps: numberOptionValue(opts, 'minDeps'),
      filePattern: optionalStringArg(args, 0),
    }),
  emptyMessage: (results) => (results.length === 0 ? 'No similar file pairs found.' : undefined),
  heuristicLabel: 'similar file candidates',
  render: (results) => {
    render.list(results, (r) => {
      const lines = [
        `\n${Math.round(r.similarity * 100)}% similar:`,
        `  ${r.fileA}`,
        `  ${r.fileB}`,
        `  Shared deps (${r.sharedDeps.length}): ${r.sharedDeps.join(', ')}`,
      ];
      if (r.uniqueToA.length) lines.push(`  Only in first:  ${r.uniqueToA.join(', ')}`);
      if (r.uniqueToB.length) lines.push(`  Only in second: ${r.uniqueToB.join(', ')}`);
      return lines.join('\n');
    });
    console.log(`\n${results.length} similar pair(s) found.`);
  },
});

export const handleDrift = budgetedReportCommand('drift', {
  query: ({ db, args, opts, budget }) =>
    queries.drift(db, {
      scope: optionalStringArg(args, 0),
      minDeviation: definedNumberOption(opts, 'minDeviation', 5),
      semantic: budget.semantic,
      includePatternDeviations: booleanOptionValue(opts, 'patterns'),
      includeArchitecture: booleanOptionValue(opts, 'architecture'),
      limit: definedLimitOption(opts, 'limit', 50),
    }),
  emptyMessage: (summary) => (summary.results.length === 0 && !summary.architecture ? 'No drift detected.' : undefined),
  heuristicLabel: 'drift candidates',
  render: (summary) => {
    console.log('');
    render.groupedByFile(
      summary.results,
      (r) => {
        const tag =
          r.kind === 'unused-import'
            ? 'UNUSED'
            : r.kind === 'architecture-violation' || r.kind === 'layer-violation'
              ? 'ARCH'
              : 'UNIQUE';
        const policy = r.policyBasis ? `, policy: ${r.policyBasis}` : '';
        const lines = [
          `  [${tag}] ${r.description}`,
          `         Tier: ${r.actionTier}${policy}`,
          `         Recommendation: ${r.recommendation}`,
          `         Evidence: ${r.evidenceReasons.join('; ')}`,
        ];
        if (r.detail) lines.push(`         ${r.detail}`);
        return lines.join('\n');
      },
      (r) => r.file,
    );
    if (summary.architecture) {
      renderDriftArchitecture(summary.architecture);
    }
    console.log(
      `\n${summary.unusedImports} unused import(s), ${summary.architectureViolations} declared architecture violation(s), ${summary.patternDeviations} pattern deviation(s)${summary.totalResults ? ` — showing ${summary.results.length} of ${summary.totalResults} (use -n to change)` : ''}`,
    );
  },
});

export const handleSimilarSignatures = budgetedListCommand('similar-signatures', {
  query: ({ db, opts, budget }) =>
    queries.similarSignatures(db, {
      scope: stringOptionValue(opts, 'scope'),
      minLoc: definedNumberOption(opts, 'minLoc', 3),
      maxShapeFrequency: definedNumberOption(opts, 'maxShapeFrequency', 12),
      limit: definedLimitOption(opts, 'limit', 20),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    }),
  format: (g) => {
    const exact = g.exactBody ? ', exact bodies' : '';
    const head = `\nSignature: ${g.signature}  (${g.functions.length} functions, ${g.locBand} LOC${exact})`;
    const body = g.functions
      .map((f) => `  ${displayPathRange(f.file, f.startLine, f.endLine)}  ${f.shortName}  (${f.loc} LOC)`)
      .join('\n');
    return `${head}\n${body}`;
  },
  emptyMessage: () => 'No same-shape function groups found.',
  after: (groups) => console.log(`\n${groups.length} group(s) found.`),
});

// Policy exclusions are human output: printing them from the query would
// prepend text to a JSON document or export file. The row renderer runs
// `after` only for human output.
let duplicateBodyExclusions: ReadonlyArray<{ count: number; detail: string }> = [];

export const handleDuplicateBodies = budgetedListCommand('duplicate-bodies', {
  query: ({ db, opts, budget }) => {
    const scan = queries.duplicateBodyScan(db, {
      scope: stringOptionValue(opts, 'scope'),
      maxLoc: definedNumberOption(opts, 'maxLoc', 15),
      minLoc: definedNumberOption(opts, 'minLoc', 3),
      limit: definedLimitOption(opts, 'limit', 20),
      scanLimit: budget.scanLimit,
    });
    duplicateBodyExclusions = scan.exclusions;
    return scan.groups;
  },
  format: (group) => {
    const head = `\nBody hash: ${group.hash}  (${group.functions.length} functions)`;
    const body = group.functions
      .map((entry, index) => {
        const role = index === 0 ? 'canonical' : 'duplicate';
        return `  ${role.padEnd(9)} ${displayPathRange(entry.file, entry.startLine, entry.endLine)}  ${entry.shortName}  (${entry.loc} LOC)`;
      })
      .join('\n');
    return `${head}\n${body}`;
  },
  emptyMessage: () => 'No exact duplicate function bodies found.',
  heuristicLabel: 'duplicate body candidates',
  after: (groups) => {
    for (const exclusion of duplicateBodyExclusions) {
      console.log(`Policy exclusion: ${exclusion.count} ${exclusion.detail}`);
    }
    console.log(`\n${groups.length} group(s) found.`);
  },
});

export const handleTwinDrift = budgetedListCommand('twin-drift', {
  query: ({ db, opts, budget }) =>
    queries.twinDrift(db, {
      scope: stringOptionValue(opts, 'scope'),
      minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.3),
      includeHomonyms: booleanOptionValue(opts, 'includeHomonyms'),
      limit: definedLimitOption(opts, 'limit', 20),
      scanLimit: budget.scanLimit,
    }),
  format: (group) => {
    const head = `\n${group.leaf}  (${group.relationship}, ${group.members.length} functions, ${Math.round(group.maxDivergence * 100)}% divergence)`;
    const body = group.members
      .map(
        (entry) =>
          `  ${displayPathRange(entry.file, entry.startLine, entry.endLine)}  ${entry.shortName}  (${entry.loc} LOC)`,
      )
      .join('\n');
    const divergence = group.firstDivergentTokens ? `\n  first divergent tokens: ${group.firstDivergentTokens}` : '';
    return `${head}\n${body}${divergence}`;
  },
  emptyMessage: () => 'No divergent twin groups found.',
  heuristicLabel: 'twin drift candidates',
  after: (groups) => console.log(`\n${groups.length} group(s) found.`),
});

export const handleNotImplemented = budgetedListCommand('not-implemented', {
  query: ({ db, opts, budget }) =>
    queries.notImplemented(db, {
      scope: stringOptionValue(opts, 'scope'),
      limit: definedLimitOption(opts, 'limit', 30),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    }),
  format: (r) =>
    `  ${displayPathRange(r.file, r.startLine, r.endLine)}  ${r.shortName}  (${r.stubKind}, reachability: ${r.reachability}${r.callerFanIn > 0 ? `, callers: ${r.callerFanIn}` : ''})\n` +
    `    ${r.stubText}`,
  emptyMessage: () => 'No reachable placeholder stubs found.',
  heuristicLabel: 'reachable placeholder stubs',
  after: (rows) => console.log(`\n${rows.length} reachable placeholder stub(s).`),
});

export const handleDecorativeCheckers = budgetedListCommand('decorative-checkers', {
  query: ({ db, opts, budget }) =>
    queries.decorativeCheckers(db, {
      scope: stringOptionValue(opts, 'scope'),
      limit: definedLimitOption(opts, 'limit', 30),
      scanLimit: budget.scanLimit,
    }),
  format: (r) =>
    `  ${displayPathRange(r.file, r.startLine, r.endLine)}  ${r.shortName}  (${r.nameKind}, resolved: ${r.resolvedVia}${r.delegateTarget ? ` -> ${r.delegateTarget}` : ''})`,
  emptyMessage: () => 'No decorative checker candidates found.',
  heuristicLabel: 'decorative checker candidates',
  after: (rows) => console.log(`\n${rows.length} decorative checker candidate(s).`),
});

export const handleTestQuality = budgetedDbCommand('test-quality', ({ db, args, opts, budget }) => {
  const report = queries.testQuality(db, {
    scope: stringOptionValue(opts, 'scope'),
    limit: definedLimitOption(opts, 'limit', 30),
    scanLimit: budget.scanLimit,
    rotDays: numberOptionValue(opts, 'rotDays'),
  });

  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('test-quality', args, opts, report, { analysisBudget: budget.analysisBudget });
    return;
  }

  renderHeuristicNotice('test-quality findings');
  const total = report.assertionFree.length + report.skipped.length + report.mockEcho.length;
  if (total === 0) {
    render.empty('No test-quality findings.');
    return;
  }

  if (report.assertionFree.length > 0) {
    console.log(`\nASSERTION-FREE (${report.assertionFree.length})`);
    render.list(
      report.assertionFree,
      (r) => `  ${displayPathRange(r.file, r.startLine, r.endLine)}  "${r.title}"  (severity: ${r.severity})`,
    );
  }
  if (report.skipped.length > 0) {
    console.log(`\nSKIPPED (${report.skipped.length})`);
    render.list(
      report.skipped,
      (r) =>
        `  ${r.file}:${r.startLine + 1}  "${r.title}"  (${r.blockKind}.${r.skipKind}, age: ${r.ageDays ?? 'unknown'}d, ${r.rot})`,
    );
  }
  if (report.mockEcho.length > 0) {
    console.log(`\nMOCK-ECHO (${report.mockEcho.length})`);
    render.list(
      report.mockEcho,
      (r) => `  ${displayPathRange(r.file, r.startLine, r.endLine)}  "${r.title}"  (echoed: ${r.echoedValue})`,
    );
  }
  console.log(
    `\n${report.assertionFree.length} assertion-free, ${report.skipped.length} skipped, ${report.mockEcho.length} mock-echo.`,
  );
});

export const handleCleanupPlan = budgetedDbCommand('cleanup-plan', ({ db, args, opts, budget }) => {
  const result = queries.cleanupPlan(db, {
    scope: stringOptionValue(opts, 'scope'),
    minLoc: definedNumberOption(opts, 'minLoc', 1),
    maxDepth: definedNumberOption(opts, 'maxDepth', 5),
    scanLimit: budget.scanLimit,
  });
  const projectRoot = resolveProjectRoot();
  const wantsPatch = booleanOptionValue(opts, 'patch');
  const wantsJson = booleanOptionValue(opts, 'json');
  const wantsVerify = booleanOptionValue(opts, 'verify') || wantsPatch;
  if (wantsPatch && !booleanOptionValue(opts, 'verify')) {
    console.error('error: cleanup-plan --patch requires --verify.');
    process.exitCode = 1;
    return;
  }
  if (result.batches.length === 0) {
    if (wantsJson) {
      printJsonEnvelope('cleanup-plan', args, opts, result, { analysisBudget: budget.analysisBudget });
      return;
    }
    return render.empty('Nothing deletable found — no graph-fact dead code to seed a cascade.');
  }
  const selectedBatches = selectCleanupBatches(result);
  const verification = wantsVerify ? verifyCleanupPlan(projectRoot, result) : undefined;

  if (wantsJson) {
    printJsonEnvelope('cleanup-plan', args, opts, { result, verification }, { analysisBudget: budget.analysisBudget });
    return;
  }

  if (wantsPatch) {
    renderVerifiedCleanupPatch(projectRoot, result, selectedBatches, verification!);
    return;
  }
  renderCleanupPlan(result);
  if (verification) renderCleanupVerification(verification);
});

type CleanupPlanResult = ReturnType<typeof queries.cleanupPlan>;
type CleanupVerification = ReturnType<typeof verifyCleanupPlan>;

function renderVerifiedCleanupPatch(
  projectRoot: string,
  result: CleanupPlanResult,
  selectedBatches: ReturnType<typeof selectCleanupBatches>,
  verification: CleanupVerification,
): void {
  const failures = cleanupVerificationFailures(verification, selectedBatches);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`error: ${failure}`);
    process.exitCode = 1;
    return;
  }
  const patch = createCleanupPatch(projectRoot, selectedBatches);
  if (patch.trim() === '') {
    console.error('error: verified cleanup plan produced an empty patch.');
    process.exitCode = 1;
    return;
  }
  console.error(`cleanup-plan --patch: ${selectedBatches.length} verified batch(es), ${result.totalLoc} LOC.`);
  console.log(patch);
  return;
}

function renderCleanupPlan(result: CleanupPlanResult): void {
  console.log(
    `Cleanup plan: ${result.totalSymbols} symbol(s), ${result.totalLoc} LOC across ${result.batches.length} batch(es).`,
  );
  console.log(
    'Review external consumers, runtime effects, and tests before applying candidates. A checker pass only establishes checker compatibility.\n',
  );
  for (const batch of result.batches) {
    const header =
      batch.depth === 0
        ? `── Batch 0: initial no-observed-use candidates ( ${batch.loc} LOC) ──`
        : `── Batch ${batch.depth}: candidate after batch ${batch.depth - 1} (cascade, ${batch.loc} LOC) ──`;
    console.log(header);
    for (const entry of batch.entries) {
      console.log(
        `  ${entry.file}:${entry.startLine + 1}-${entry.endLine + 1}  ${entry.shortName}  (${entry.loc} LOC)`,
      );
    }
    if (batch.filesEmptied.length > 0) {
      console.log(`  -> all indexed definitions selected: ${batch.filesEmptied.join(', ')}`);
    }
    console.log('');
  }
  if (result.blocked.length > 0) {
    console.log('Cascade blocked (references outside the removal set):');
    for (const entry of result.blocked) {
      console.log(`  ${entry.shortName}  (${entry.file})  blocked by ${entry.blockingFiles.join(', ')}`);
    }
  }
}

function renderCleanupVerification(verification: CleanupVerification): void {
  console.log('\nVerifying batches against the project checker (isolated snapshot of committed HEAD)...');
  if (verification.checkers.length === 0) {
    console.log(
      '  No checker detected (need tsconfig.json, go.mod, Python project markers, Clojure project markers, or Cargo.toml) -- skipped.',
    );
    return;
  }
  for (const checker of verification.checkers) {
    console.log(`  Checker: ${checker}`);
  }
  if (verification.unavailableReason) {
    console.log(`  UNAVAILABLE: ${verification.unavailableReason}.`);
    return;
  }
  renderCleanupVerificationWarnings(verification);
  const oracleSummary = verificationOracleSummary(verification.checkers);
  const caveat = verificationLintCaveat(verification.checkers);
  for (const batch of verification.batches) {
    if (batch.status === 'verified') {
      console.log(`  Batch ${batch.depth}: VERIFIED (${oracleSummary})${caveat}`);
    } else {
      console.log(
        `  Batch ${batch.depth}: FAILED${batch.reason ? ` (${batch.reason})` : ''} -- the output below names references the static evidence missed or unparsed checker output:`,
      );
      for (const error of batch.errors ?? []) {
        console.log(`    ${error}`);
      }
    }
  }
}

function renderCleanupVerificationWarnings(verification: CleanupVerification): void {
  if (verification.uncoveredFiles.length > 0) {
    console.log(
      `  WARNING: no checker covers these plan files (entries there are NOT verified): ${verification.uncoveredFiles.join(', ')}`,
    );
  }
  if (verification.baselineErrors > 0) {
    console.log(
      `  Baseline has ${verification.baselineErrors} pre-existing error(s) — verifying differentially (no NEW errors).`,
    );
  }
  if (verification.workingTree.state === 'unavailable') {
    console.log(`  WARNING: working-tree inspection unavailable: ${verification.workingTree.reason}`);
  }
  if (verification.dirtyOverlap.length > 0) {
    console.log(
      `  WARNING: plan files dirty in working tree (verification runs at HEAD): ${verification.dirtyOverlap.join(', ')}`,
    );
  }
  if (verification.dirtyWorkingTree.length > 0) {
    const shown = verification.dirtyWorkingTree.slice(0, 5);
    const omitted = verification.dirtyWorkingTree.length - shown.length;
    console.log(
      `  WARNING: verification ran at HEAD; ${verification.dirtyWorkingTree.length} working-tree change(s) were not compiled: ${shown.join(', ')}${omitted > 0 ? `, ... ${omitted} more` : ''}`,
    );
  }
}

function verificationOracleSummary(checkers: readonly string[]): string {
  return checkers.join(', ');
}

function verificationLintCaveat(checkers: readonly string[]): string {
  return checkers.some((checker) => /clj-kondo|ruff|compileall/i.test(checker))
    ? ' -- lint-level or syntax-level check, not a type proof'
    : '';
}

export const handleRecentDuplicates = budgetedDbCommand('recent-duplicates', ({ db, args, opts, budget }) => {
  const full = booleanOptionValue(opts, 'full');
  const result = queries.recentDuplicates(db, {
    windowCommits: definedNumberOption(opts, 'window', 100),
    minSimilarity: numberOptionValue(opts, 'minSimilarity'),
    limit: definedLimitOption(opts, 'limit', 30),
    scope: stringOptionValue(opts, 'scope'),
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
    historyMode: full ? 'full' : 'bounded',
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('recent-duplicates', args, opts, result, { analysisBudget: budget.analysisBudget });
    return;
  }
  if (!result.available) return render.empty('No git history available (not a repository, or git missing).');
  if (result.findings.length === 0) {
    return render.empty(`No recent re-implementations found (window: last ${result.windowCommits} commits).`);
  }
  renderHeuristicNotice('recent re-implementation candidates');
  console.log(`Recent re-implementations (window: last ${result.windowCommits} commits):\n`);
  renderRecentDuplicateGroups(result.rootCauseGroups);
  for (const finding of result.findings) {
    const evidence = finding.sharedEvidence.slice(0, 16).join(', ');
    if (finding.kind === 'echo') {
      console.log(
        `  ${Math.round(finding.similarity * 100)}%  ECHO  ${finding.domain}  ${finding.echoFile}  ${finding.echoSymbol}  (added ${finding.echoAgeCommits} commits ago)`,
      );
      console.log(`        duplicates established  ${finding.establishedFile}  ${finding.establishedSymbol}`);
    } else {
      console.log(
        `  ${Math.round(finding.similarity * 100)}%  TWIN  ${finding.domain}  ${finding.echoFile}  ${finding.echoSymbol}`,
      );
      console.log(
        `        and                     ${finding.establishedFile}  ${finding.establishedSymbol}  (both new — consolidate before they diverge)`,
      );
    }
    console.log(`        basis: ${finding.basis}`);
    if (evidence.length > 0) console.log(`        shared: ${evidence}`);
  }
  console.log(
    `\n${result.findings.length} finding(s). ECHO: prefer extending the established side and deleting the echo.`,
  );
});

export const handleDocDrift = dbCommand(({ db, args, opts }) => {
  const full = booleanOptionValue(opts, 'full');
  const result = queries.docDrift(db, {
    doc: args[0] === undefined ? undefined : stringArg(args, 0),
    limit: definedLimitOption(opts, 'limit', 20),
    minCoupling: definedNumberOption(opts, 'minCoupling', 3),
    includeSnapshotExcluded: full,
    historyMode: full ? 'full' : 'bounded',
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('doc-drift', args, opts, result);
    return;
  }
  if (!result.available) return render.empty('No git history available (not a repository, or git missing).');
  if (result.findings.length === 0) {
    return render.empty(
      `No drifting docs found across ${result.docsScanned} doc(s) — referenced and co-changed code has not moved since each doc last changed.`,
    );
  }
  renderHeuristicNotice('doc drift candidates');
  console.log(
    `Docs whose referenced or co-changed code moved on without them (${result.docsScanned} docs scanned, ${result.commitsAnalyzed} commits analyzed):\n`,
  );
  for (const finding of result.findings) {
    renderDocDriftFinding(finding);
  }
  console.log('\nStale standards docs are worse than none — agents implement to a dead spec.');
});

function renderDocDriftFinding(finding: ReturnType<typeof queries.docDrift>['findings'][number]): void {
  const snapshotLabel = finding.snapshotExcluded ? '  [snapshot (excluded by policy)]' : '';
  const estimatedLabel = finding.docLastChangedAtEstimated ? '  [docLastChangedAt estimated from file mtime]' : '';
  console.log(`  staleness ${finding.staleness}  ${finding.doc}${snapshotLabel}${estimatedLabel}`);
  for (const broken of finding.brokenReferences.slice(0, 4)) {
    console.log(`    BROKEN REFERENCE: cites ${broken} — that file no longer exists`);
  }
  for (const subject of finding.subjects.slice(0, 4)) {
    renderDocDriftSubject(subject);
  }
}

function renderDocDriftSubject(
  subject: ReturnType<typeof queries.docDrift>['findings'][number]['subjects'][number],
): void {
  const evidence =
    subject.evidence === 'both'
      ? `referenced by doc + coupled ${subject.coChanges}x`
      : subject.evidence === 'reference'
        ? 'referenced by doc'
        : `coupled ${subject.coChanges}x historically`;
  console.log(
    `    ${subject.changesSinceDocUpdate} change(s) since doc update  ${subject.file}  (${evidence}; ${subject.actionTier}/${subject.docIntent})`,
  );
  const intentReason = subject.docIntentReasons[0];
  if (intentReason) console.log(`      intent: ${intentReason}`);
  const citedClaim = subject.citationContexts?.[0];
  if (citedClaim) console.log(`      cited claim: ${displaySnippet(citedClaim)}`);
}

export const handleUnusedParams = budgetedListCommand('unused-params', {
  query: ({ db, opts, budget }) =>
    queries.unusedParams(db, {
      scope: stringOptionValue(opts, 'scope'),
      limit: definedLimitOption(opts, 'limit', 30),
      scanLimit: budget.scanLimit,
    }),
  format: (r) =>
    `  ${displayPathRange(r.file, r.startLine, r.endLine)}  ${r.shortName}\n` +
    `    trailing unused: ${r.unusedTrailing.join(', ')}  (${r.unusedTrailing.length} of ${r.paramCount} params -- type-safe to remove at the signature; check call sites for side-effectful arguments)`,
  emptyMessage: () => 'No trailing unused parameters found.',
  heuristicLabel: 'unused trailing parameter candidates',
  after: (rows) => console.log(`\n${rows.length} function(s) with trailing unused parameters.`),
});

function renderRecentDuplicateGroups(groups: ReturnType<typeof queries.recentDuplicates>['rootCauseGroups']): void {
  const multiFindingGroups = groups?.filter((group) => group.count > 1) ?? [];
  if (multiFindingGroups.length > 0) {
    console.log(`Root-cause groups (${multiFindingGroups.length}):`);
    for (const group of multiFindingGroups) {
      console.log(
        `  ${group.count} pair(s)  ${group.kind.toUpperCase()}  ${group.domain}  ${Math.round(
          group.maxSimilarity * 100,
        )}% max`,
      );
      if (group.establishedFile && group.establishedSymbol) {
        console.log(`        established: ${group.establishedFile}  ${group.establishedSymbol}`);
      }
      console.log(`        files: ${group.relatedFiles.slice(0, 6).join(', ')}`);
      console.log(`        -> ${group.recommendation}`);
    }
    console.log('');
  }
}

function renderSimilarityPlan(plan: NonNullable<ReturnType<typeof queries.similarConsolidationPlan>>): void {
  const evidenceLabel = plan.similarityBasis === 'source-tokens' ? 'source-token overlap' : 'weighted callee overlap';
  console.log(`\n${Math.round(plan.similarity * 100)}% ${evidenceLabel}\n`);
  console.log(`  A: ${plan.symbolA.shortName}  (${plan.symbolA.file}, ${plan.symbolA.loc} LOC)`);
  console.log(`  B: ${plan.symbolB.shortName}  (${plan.symbolB.file}, ${plan.symbolB.loc} LOC)`);
  console.log(`  Evidence class: ${plan.evidenceClass}  (tier: ${plan.actionTier})`);
  console.log(`  Recommendation: ${plan.recommendation}\n`);
  console.log(`  Shared evidence (${plan.sharedEvidence.length}):`);
  for (const item of plan.sharedEvidence) console.log(`    ${item}`);
  if (plan.uniqueToA.length > 0) {
    console.log(`\n  Unique to A (${plan.uniqueToA.length}):`);
    for (const item of plan.uniqueToA) console.log(`    ${item}`);
  }
  if (plan.uniqueToB.length > 0) {
    console.log(`\n  Unique to B (${plan.uniqueToB.length}):`);
    for (const item of plan.uniqueToB) console.log(`    ${item}`);
  }
  console.log(`\n  Strategy: ${plan.consolidationStrategy}`);
}

function renderDriftArchitecture(architecture: NonNullable<ReturnType<typeof queries.drift>['architecture']>): void {
  const undeclaredEdges = architecture.edges.filter((edge) => edge.policyStatus === 'undeclared').length;
  console.log(
    `\nArchitecture context: ${architecture.coverage.mappedFiles}/${architecture.coverage.totalFiles} file(s) mapped; ` +
      `${architecture.policyCoverage.declaredRows}/${architecture.policyCoverage.totalBoundaries} dependency row(s) declared; ` +
      `${undeclaredEdges} undeclared boundary edge(s).`,
  );
  if (architecture.reciprocalPairs.length > 0) {
    console.log(`  Reciprocal pairs (${architecture.reciprocalPairs.length}):`);
    for (const pair of architecture.reciprocalPairs) {
      console.log(`    ${pair.boundaries[0]} <-> ${pair.boundaries[1]}`);
    }
  }
  if (architecture.cycles.length > 0) {
    console.log(`  Connected boundary groups (${architecture.cycles.length}):`);
    for (const cycle of architecture.cycles) {
      const policy = cycle.violatesPolicy ? ' [violates requireAcyclic]' : ' [signal]';
      console.log(`    { ${cycle.boundaries.join(', ')} }${policy}`);
    }
  }
}
