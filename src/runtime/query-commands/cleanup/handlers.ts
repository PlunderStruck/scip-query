import type { DeadOptions } from '../../../domain/types.js';
import * as queries from '../../../queries/index.js';
import { resolveProjectRoot } from '../../cli-context.js';
import {
  applyCleanupBatches,
  cleanupVerificationFailures,
  createCleanupPatch,
  selectCleanupBatches,
  verifyCleanupPlan,
} from '../../cleanup-verify.js';
import { renderHeuristicNotice } from '../../cli-support.js';
import {
  booleanOptionValue,
  budgetedDbCommand,
  budgetedGroupedByFileCommand,
  budgetedListCommand,
  budgetedReportCommand,
  budgetedTableCommand,
  dbCommand,
  definedLimitOption,
  definedNumberOption,
  numberOptionValue,
  optionalStringArg,
  printJsonEnvelope,
  reportCommand,
  stringArg,
  stringOptionValue,
} from '../../commands/command-execution.js';
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
  const deadCode = result.symbols.filter((s) => s.kind === 'dead-code');
  const fileInternal = result.symbols.filter((s) => s.kind !== 'dead-code');
  const showDead = !booleanOptionValue(opts, 'onlyInternal');
  const showInternal = !booleanOptionValue(opts, 'onlyDead');
  const shownDeadCode = showDead ? deadCode : [];
  const shownFileInternal = showInternal ? fileInternal : [];
  const deadLoc = shownDeadCode.reduce((sum, s) => sum + s.loc, 0);
  const fiLoc = shownFileInternal.reduce((sum, s) => sum + s.loc, 0);
  const full = booleanOptionValue(opts, 'full');
  const displayDeadCode = full ? shownDeadCode : shownDeadCode.slice(0, DEAD_HUMAN_SECTION_LIMIT);
  const displayFileInternal = full ? shownFileInternal : shownFileInternal.slice(0, DEAD_HUMAN_SECTION_LIMIT);
  const displayDeadLoc = displayDeadCode.reduce((sum, s) => sum + s.loc, 0);
  const displayFileInternalLoc = displayFileInternal.reduce((sum, s) => sum + s.loc, 0);
  const shownCounts = {
    total: shownDeadCode.length + shownFileInternal.length,
    deadCode: shownDeadCode.length,
    fileInternal: shownFileInternal.length,
    loc: deadLoc + fiLoc,
  };
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('dead', args, opts, {
      ...result,
      shown: {
        deadCode: shownDeadCode,
        fileInternal: shownFileInternal,
      },
      shownCounts,
      totals: {
        total: result.counts.total,
        deadCode: result.counts.deadCode,
        fileInternal: result.counts.fileInternal,
        loc: result.counts.loc,
      },
    });
    return;
  }

  if (shownDeadCode.length === 0 && shownFileInternal.length === 0) {
    render.empty('No matching dead-code symbols found.');
    return;
  }

  if (shownDeadCode.length > 0) {
    renderDeadGroup(
      displayDeadCode,
      'DEAD CODE',
      '  Zero references anywhere -- no cross-file callers AND no same-file uses.\n  Deletion candidates -- confirm with cleanup-plan --verify before deleting.',
      displayDeadLoc,
      { count: shownDeadCode.length, loc: deadLoc },
    );
    if (!full && shownDeadCode.length > displayDeadCode.length) {
      console.log(
        `\n  Showing top ${displayDeadCode.length} by LOC. Re-run with --full for the remaining ${shownDeadCode.length - displayDeadCode.length}.`,
      );
    }
  }
  if (shownFileInternal.length > 0) {
    if (shownDeadCode.length > 0) console.log('');
    renderDeadGroup(
      displayFileInternal,
      'FILE-INTERNAL ONLY',
      '  Used only within the same file (no cross-file callers). Could be a\n  single-use helper, an abstraction-in-progress, or a callback registered\n  through a framework path that static analysis cannot trace (signal\n  handlers, event listeners, dependency injection). NOT necessarily dead —\n  review case by case.',
      displayFileInternalLoc,
      { count: shownFileInternal.length, loc: fiLoc },
    );
    if (!full && shownFileInternal.length > displayFileInternal.length) {
      console.log(
        `\n  Showing top ${displayFileInternal.length} by LOC. Re-run with --full for the remaining ${shownFileInternal.length - displayFileInternal.length}.`,
      );
    }
  }

  const totalParts: string[] = [];
  if (showDead) totalParts.push(`${shownDeadCode.length} dead code (${deadLoc} LOC)`);
  if (showInternal) totalParts.push(`${shownFileInternal.length} file-internal (${fiLoc} LOC)`);
  console.log('\n───────────────────────────');
  console.log(`Total: ${shownDeadCode.length + shownFileInternal.length} symbols — ${totalParts.join(' + ')}`);
});

export const handleUnusedImports = budgetedListCommand('unused-imports', {
  query: ({ db, args, budget }) => queries.unusedImports(db, stringArg(args, 0), { semantic: budget.semantic }),
  format: (r) => `  ${r.shortName}  in ${r.importedIn}`,
  emptyMessage: () => 'No unused imports found.',
  after: (rows) => console.log(`\n${rows.length} unused import(s)`),
});

export const handleIsolated = budgetedGroupedByFileCommand('isolated', {
  query: ({ db, opts, budget }) =>
    queries.isolated(db, {
      scope: stringOptionValue(opts, 'scope'),
      minLoc: definedNumberOption(opts, 'minLoc', 3),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    }),
  format: (r) => `  ${displayRange(r.startLine, r.endLine)}  (${r.loc} LOC)  ${r.shortName}`,
  emptyMessage: () => 'No isolated symbols found.',
  after: (rows) => console.log(`\n${rows.length} isolated symbol(s)`),
});

export const handleExtractCandidates = budgetedDbCommand('extract-candidates', ({ db, args, opts, budget }) => {
  const results = queries.extractCandidates(db, {
    scope: stringOptionValue(opts, 'scope'),
    minLoc: definedNumberOption(opts, 'minLoc', 10),
    minCallees: definedNumberOption(opts, 'minCallees', 6),
    limit: definedLimitOption(opts, 'limit', 20),
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('extract-candidates', args, opts, results);
    return;
  }
  if (results.length === 0) return render.empty('No extraction candidates found.');
  renderHeuristicNotice('extraction candidates');
  for (const r of results) {
    console.log(
      `\n${displayPathRange(r.relativePath, r.startLine, r.endLine)}  ${r.shortName}  (${r.loc} LOC, ${r.totalCallees} callees)`,
    );
    console.log(`  Kind: ${r.extractionKind}; tier: ${r.actionTier}`);
    console.log(`  Recommendation: ${r.recommendation}`);
    for (const reason of r.evidenceReasons) console.log(`  - ${reason}`);
    for (let i = 0; i < r.clusters.length; i++) {
      const c = r.clusters[i]!;
      console.log(`  Cluster ${i + 1} (${Math.round(c.isolation * 100)}% isolated, ${c.callees.length} callees):`);
      for (const callee of c.callees) console.log(`    ${callee}`);
    }
  }
  console.log(`\n${results.length} extraction candidate(s) found.`);
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
    printJsonEnvelope('locality-candidates', args, opts, results);
    return;
  }
  if (results.length === 0) return render.empty('No locality candidates found.');
  renderHeuristicNotice('locality candidates');
  for (const r of results) {
    const location =
      r.sourceUnit.kind === 'symbol' && r.sourceUnit.startLine !== undefined && r.sourceUnit.endLine !== undefined
        ? displayPathRange(r.sourceUnit.file, r.sourceUnit.startLine, r.sourceUnit.endLine)
        : r.sourceUnit.file;
    console.log(`\n${location}  ${r.sourceUnit.shortName}`);
    console.log(`  Current directory: ${r.currentDirectory}; tier: ${r.recommendedTier}; action: ${r.actionTier}`);
    console.log(`  Consumer coverage: ${r.consumerCoverage}; consumers: ${r.consumerFiles.length}`);
    if (r.nearestCommonOwner) console.log(`  Nearest common owner: ${r.nearestCommonOwner}`);
    if (r.suggestedHome) console.log(`  Suggested home: ${r.suggestedHome}`);
    if (r.whyNoSuggestedHome) console.log(`  Suggested home withheld: ${r.whyNoSuggestedHome}`);
    if (r.boundaryMarkers.length > 0) console.log(`  Boundary markers: ${r.boundaryMarkers.join('; ')}`);
    console.log(`  Recommendation: ${r.recommendation}`);
    if (r.consumerFiles.length > 0) {
      for (const consumer of r.consumerFiles.slice(0, 8)) console.log(`  - consumer: ${consumer}`);
      if (r.consumerFiles.length > 8) console.log(`  - ... ${r.consumerFiles.length - 8} more consumer(s)`);
    }
    for (const counter of r.counterevidence) console.log(`  - counterevidence: ${counter}`);
  }
  console.log(`\n${results.length} locality candidate(s) found.`);
});

export const handleWrapperCandidates = budgetedListCommand('wrapper-candidates', {
  query: ({ db, opts, budget }) =>
    queries.wrapperCandidates(db, {
      scope: stringOptionValue(opts, 'scope'),
      maxLoc: definedNumberOption(opts, 'maxLoc', 15),
      limit: definedLimitOption(opts, 'limit', 30),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    }),
  format: (r) =>
    `  ${displayPathRange(r.file, r.startLine, r.endLine)}  ${r.shortName}  (${r.loc} LOC)\n` +
    `    Only called by: ${r.singleCallerShort}  (fan-in: ${r.callerFanIn}, tier: ${r.actionTier})` +
    (r.boundaryEvidence.length > 0 ? `\n    Boundary evidence: ${r.boundaryEvidence.join('; ')}` : ''),
  emptyMessage: () => 'No wrapper candidates found.',
  heuristicLabel: 'wrapper candidates',
  after: (rows) => console.log(`\n${rows.length} wrapper candidate(s).`),
});

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

export const handleStaleAbstractions = budgetedListCommand('stale-abstractions', {
  query: ({ db, opts, budget }) =>
    queries.staleAbstractions(db, {
      scope: stringOptionValue(opts, 'scope'),
      minLoc: definedNumberOption(opts, 'minLoc', 3),
      limit: definedLimitOption(opts, 'limit', 30),
      includeLowConfidence: booleanOptionValue(opts, 'includeLowConfidence'),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    }),
  format: (r) => {
    const consumerLabel = r.consumers === 0 ? 'unused' : `${r.consumers} consumer`;
    const barrelLabel = r.barrelConsumers > 0 ? `, +${r.barrelConsumers} barrel` : '';
    return (
      `  [${r.confidence}] ${displayPathRange(r.file, r.startLine, r.endLine)}  ${r.shortName}  ` +
      `(${r.kind}, ${r.loc} LOC, ${consumerLabel}${barrelLabel})\n` +
      `           ${r.reason}\n` +
      `           Kind: ${r.stalenessKind}; tier: ${r.actionTier}\n` +
      `           Recommendation: ${r.recommendation}`
    );
  },
  emptyMessage: () => 'No stale abstractions found.',
  heuristicLabel: 'stale abstraction candidates',
  after: (rows) => console.log(`\n${rows.length} stale abstraction(s).`),
});

export const handleComplexityHotspots = budgetedTableCommand('complexity-hotspots', {
  headers: ['score', ' LOC', 'fan-in', 'fan-out', 'callees', 'symbol'],
  query: ({ db, opts, budget }) =>
    queries.complexityHotspots(db, {
      scope: stringOptionValue(opts, 'scope'),
      minLoc: definedNumberOption(opts, 'minLoc', 10),
      limit: definedLimitOption(opts, 'limit', 20),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    }),
  format: (r) =>
    `  ${r.score.toFixed(1).padStart(5)}  ${String(r.loc).padStart(4)}  ` +
    `${String(r.fanIn).padStart(6)}  ${String(r.fanOut).padStart(7)}  ` +
    `${String(r.calleeCount).padStart(7)}  ${r.shortName}`,
  emptyMessage: () => 'No complexity hotspots found.',
  heuristicLabel: 'complexity hotspot candidates',
  dashWidths: [5, 4, 6, 7, 7, 6],
});

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
      const evidenceLabel =
        plan.similarityBasis === 'source-tokens' ? 'source-token overlap' : 'weighted callee overlap';
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

export const handleSimilarChains = reportCommand({
  commandName: 'similar-chains',
  query: ({ db, opts }) =>
    queries.similarChains(db, {
      minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.5),
      limit: definedLimitOption(opts, 'limit', 15),
      scope: stringOptionValue(opts, 'scope'),
      minChainLength: definedNumberOption(opts, 'minLength', 3),
      maxChainLength: definedNumberOption(opts, 'maxLength', 8),
    }),
  emptyMessage: (results) => (results.length === 0 ? 'No similar chains found.' : undefined),
  heuristicLabel: 'similar chain candidates',
  render: (results) => {
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      console.log(
        `\n── Chain pair ${i + 1} (${Math.round(r.similarity * 100)}% similar, ${r.divergencePoints.length} divergence point(s)) ──`,
      );
      console.log(`  Chain A: ${r.chainA.join(' → ')}`);
      console.log(`  Chain B: ${r.chainB.join(' → ')}`);
      if (r.commonPrefix.length) console.log(`  Common prefix: ${r.commonPrefix.join(' → ')}`);
      if (r.commonSuffix.length) console.log(`  Common suffix: ${r.commonSuffix.join(' → ')}`);
      console.log('  Divergence points (consolidation targets):');
      for (const d of r.divergencePoints) console.log(`    [${d.index}] ${d.nodeA}  ↔  ${d.nodeB}`);
    }
    console.log(`\n${results.length} similar chain pair(s) found.`);
  },
});

export const handleDrift = budgetedReportCommand('drift', {
  query: ({ db, args, opts, budget }) =>
    queries.drift(db, {
      scope: optionalStringArg(args, 0),
      minDeviation: definedNumberOption(opts, 'minDeviation', 5),
      semantic: budget.semantic,
      includePatternDeviations: booleanOptionValue(opts, 'patterns'),
      limit: definedLimitOption(opts, 'limit', 50),
    }),
  emptyMessage: (summary) => (summary.results.length === 0 ? 'No drift detected.' : undefined),
  heuristicLabel: 'drift candidates',
  render: (summary) => {
    console.log('');
    render.groupedByFile(
      summary.results,
      (r) => {
        const tag = r.kind === 'unused-import' ? 'UNUSED' : r.kind === 'layer-violation' ? 'LAYER' : 'UNIQUE';
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
    console.log(
      `\n${summary.unusedImports} unused import(s), ${summary.layerViolations} layer violation(s), ${summary.patternDeviations} pattern deviation(s)${summary.totalResults ? ` — showing ${summary.results.length} of ${summary.totalResults} (use -n to change)` : ''}`,
    );
  },
});

export const handleConvergence = budgetedReportCommand('convergence', {
  query: ({ db, args, budget }) =>
    queries.convergence(db, stringArg(args, 0), stringArg(args, 1), { semantic: budget.semantic }),
  emptyMessage: (result) => (result ? undefined : 'One or both symbols not found.'),
  render: (result) => {
    if (!result) return;
    console.log('\nDeprecated: use `similar <symbol1> <symbol2> --plan` for the same weighted similarity basis.');
    console.log(`\n${Math.round(result.similarity * 100)}% callee overlap\n`);
    console.log(`  A: ${result.symbolA.shortName}  (${result.symbolA.file}, ${result.symbolA.loc} LOC)`);
    console.log(`  B: ${result.symbolB.shortName}  (${result.symbolB.file}, ${result.symbolB.loc} LOC)\n`);
    console.log(`  Shared callees (${result.sharedCallees.length}):`);
    for (const c of result.sharedCallees) console.log(`    ${c}`);
    if (result.uniqueToA.length > 0) {
      console.log(`\n  Unique to A (${result.uniqueToA.length}):`);
      for (const c of result.uniqueToA) console.log(`    ${c}`);
    }
    if (result.uniqueToB.length > 0) {
      console.log(`\n  Unique to B (${result.uniqueToB.length}):`);
      for (const c of result.uniqueToB) console.log(`    ${c}`);
    }
    console.log(`\n  Strategy: ${result.consolidationStrategy}`);
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

export const handleDuplicateBodies = budgetedListCommand('duplicate-bodies', {
  query: ({ db, opts, budget }) =>
    queries.duplicateBodies(db, {
      scope: stringOptionValue(opts, 'scope'),
      maxLoc: definedNumberOption(opts, 'maxLoc', 15),
      minLoc: definedNumberOption(opts, 'minLoc', 3),
      limit: definedLimitOption(opts, 'limit', 20),
      scanLimit: budget.scanLimit,
    }),
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
  after: (groups) => console.log(`\n${groups.length} group(s) found.`),
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
      printJsonEnvelope('cleanup-plan', args, opts, result);
      return;
    }
    return render.empty('Nothing deletable found — no graph-fact dead code to seed a cascade.');
  }
  const selectedBatches = selectCleanupBatches(result);
  const verification = wantsVerify ? verifyCleanupPlan(projectRoot, result) : undefined;

  if (wantsJson) {
    printJsonEnvelope('cleanup-plan', args, opts, { result, verification });
    return;
  }

  if (wantsPatch) {
    const failures = cleanupVerificationFailures(verification!, selectedBatches);
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

  console.log(
    `Cleanup plan: ${result.totalSymbols} symbol(s), ${result.totalLoc} LOC across ${result.batches.length} batch(es).`,
  );
  console.log('Apply one batch at a time; run your typecheck between batches.\n');
  for (const batch of result.batches) {
    const header =
      batch.depth === 0
        ? `── Batch 0: deletable now (graph-fact, ${batch.loc} LOC) ──`
        : `── Batch ${batch.depth}: dead once batch ${batch.depth - 1} lands (cascade, ${batch.loc} LOC) ──`;
    console.log(header);
    for (const entry of batch.entries) {
      console.log(
        `  ${entry.file}:${entry.startLine + 1}-${entry.endLine + 1}  ${entry.shortName}  (${entry.loc} LOC)`,
      );
    }
    if (batch.filesEmptied.length > 0) {
      console.log(`  -> empties: ${batch.filesEmptied.join(', ')}`);
    }
    console.log('');
  }
  if (result.blocked.length > 0) {
    console.log('Cascade blocked (references outside the removal set):');
    for (const entry of result.blocked) {
      console.log(`  ${entry.shortName}  (${entry.file})  blocked by ${entry.blockingFiles.join(', ')}`);
    }
  }

  if (verification) {
    console.log('\nVerifying batches against the project checker (throwaway worktree at HEAD)...');
    if (verification.checkers.length === 0) {
      console.log(
        '  No checker detected (need tsconfig.json, go.mod, Python project markers, Clojure project markers, or Cargo.toml) -- skipped.',
      );
      return;
    }
    for (const checker of verification.checkers) {
      console.log(`  Checker: ${checker}`);
    }
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
});

export const handleCleanupApply = budgetedDbCommand('cleanup-apply', ({ db, opts, budget }) => {
  if (!booleanOptionValue(opts, 'verified')) {
    console.error('error: cleanup-apply requires --verified so deletions are checked before mutating files.');
    process.exitCode = 1;
    return;
  }
  const all = booleanOptionValue(opts, 'all');
  const batch = numberOptionValue(opts, 'batch');
  if (all === (batch !== undefined)) {
    console.error('error: choose exactly one of --all or --batch <n>.');
    process.exitCode = 1;
    return;
  }
  const result = queries.cleanupPlan(db, {
    scope: stringOptionValue(opts, 'scope'),
    minLoc: definedNumberOption(opts, 'minLoc', 1),
    maxDepth: definedNumberOption(opts, 'maxDepth', 5),
    scanLimit: budget.scanLimit,
  });
  if (result.batches.length === 0) {
    render.empty('Nothing deletable found — no graph-fact dead code to seed a cascade.');
    return;
  }
  const selectedBatches = selectCleanupBatches(result, { all, batch });
  if (selectedBatches.length === 0) {
    console.error(`error: No cleanup batch ${batch} exists.`);
    process.exitCode = 1;
    return;
  }

  const projectRoot = resolveProjectRoot();
  const verification = verifyCleanupPlan(projectRoot, result);
  const failures = cleanupVerificationFailures(verification, selectedBatches, {
    allowDirty: booleanOptionValue(opts, 'forceDirty'),
  });
  if (failures.length > 0) {
    for (const failure of failures) console.error(`error: ${failure}`);
    process.exitCode = 1;
    return;
  }

  applyCleanupBatches(projectRoot, selectedBatches);
  const symbols = selectedBatches.reduce((sum, cleanupBatch) => sum + cleanupBatch.entries.length, 0);
  const loc = selectedBatches.reduce((sum, cleanupBatch) => sum + cleanupBatch.loc, 0);
  console.log(`Applied ${selectedBatches.length} verified cleanup batch(es): ${symbols} symbol(s), ${loc} LOC.`);
});

function verificationOracleSummary(checkers: readonly string[]): string {
  return checkers.join(', ');
}

function verificationLintCaveat(checkers: readonly string[]): string {
  return checkers.some((checker) => /clj-kondo|ruff|compileall/i.test(checker))
    ? ' -- lint-level or syntax-level check, not a type proof'
    : '';
}

export const handleRecentDuplicates = budgetedDbCommand('recent-duplicates', ({ db, args, opts, budget }) => {
  const result = queries.recentDuplicates(db, {
    windowCommits: definedNumberOption(opts, 'window', 100),
    minSimilarity: numberOptionValue(opts, 'minSimilarity'),
    limit: definedLimitOption(opts, 'limit', 30),
    scope: stringOptionValue(opts, 'scope'),
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('recent-duplicates', args, opts, result);
    return;
  }
  if (!result.available) return render.empty('No git history available (not a repository, or git missing).');
  if (result.findings.length === 0) {
    return render.empty(`No recent re-implementations found (window: last ${result.windowCommits} commits).`);
  }
  renderHeuristicNotice('recent re-implementation candidates');
  console.log(`Recent re-implementations (window: last ${result.windowCommits} commits):\n`);
  const multiFindingGroups = result.rootCauseGroups?.filter((group) => group.count > 1) ?? [];
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
    const snapshotLabel = finding.snapshotExcluded ? '  [snapshot (excluded by policy)]' : '';
    console.log(`  staleness ${finding.staleness}  ${finding.doc}${snapshotLabel}`);
    for (const broken of finding.brokenReferences.slice(0, 4)) {
      console.log(`    BROKEN REFERENCE: cites ${broken} — that file no longer exists`);
    }
    for (const subject of finding.subjects.slice(0, 4)) {
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
  }
  console.log('\nStale standards docs are worse than none — agents implement to a dead spec.');
});

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
