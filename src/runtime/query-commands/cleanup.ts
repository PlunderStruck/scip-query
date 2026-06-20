import type { DeadOptions } from '../../domain/types.js';
import * as queries from '../../queries/index.js';
import { resolveProjectRoot } from '../cli-context.js';
import {
  applyCleanupBatches,
  cleanupVerificationFailures,
  createCleanupPatch,
  selectCleanupBatches,
  verifyCleanupPlan,
} from '../cleanup-verify.js';
import { renderHeuristicNotice } from '../cli-support.js';
import type { CommandDescriptor } from '../command-descriptor-types.js';
import { doc, option, parseInteger, parseNumber, parsePositiveInteger, withJsonOption } from '../command-spec-builders.js';
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
} from '../command-execution.js';
import { groupedQueryCommand } from '../query-command-builders.js';
import { displayPathRange, displayRange, render } from '../render.js';

const handleDead = budgetedDbCommand('dead', ({ db, args, opts, budget }) => {
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
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('dead', args, opts, {
      ...result,
      shown: {
        deadCode: shownDeadCode,
        fileInternal: shownFileInternal,
      },
      totals: {
        deadCode: deadCode.length,
        fileInternal: fileInternal.length,
      },
    });
    return;
  }

  if (shownDeadCode.length === 0 && shownFileInternal.length === 0) {
    render.empty('No matching dead-code symbols found.');
    return;
  }

  const deadLoc = shownDeadCode.reduce((sum, s) => sum + s.loc, 0);
  const fiLoc = shownFileInternal.reduce((sum, s) => sum + s.loc, 0);
  if (shownDeadCode.length > 0) {
    renderDeadGroup(
      shownDeadCode,
      'DEAD CODE',
      '  Zero references anywhere — no cross-file callers AND no same-file uses.\n  Safe to delete.',
      deadLoc,
    );
  }
  if (shownFileInternal.length > 0) {
    if (shownDeadCode.length > 0) console.log('');
    renderDeadGroup(
      shownFileInternal,
      'FILE-INTERNAL ONLY',
      '  Used only within the same file (no cross-file callers). Could be a\n  single-use helper, an abstraction-in-progress, or a callback registered\n  through a framework path that static analysis cannot trace (signal\n  handlers, event listeners, dependency injection). NOT necessarily dead —\n  review case by case.',
      fiLoc,
    );
  }

  const totalParts: string[] = [];
  if (showDead) totalParts.push(`${shownDeadCode.length} dead code (${deadLoc} LOC)`);
  if (showInternal) totalParts.push(`${shownFileInternal.length} file-internal (${fiLoc} LOC)`);
  console.log('\n───────────────────────────');
  console.log(`Total: ${shownDeadCode.length + shownFileInternal.length} symbols — ${totalParts.join(' + ')}`);
});

function renderDeadGroup(
  rows: ReturnType<typeof queries.dead>['symbols'],
  title: string,
  explanation: string,
  loc: number,
): void {
  console.log(`═══ ${title} (${rows.length}, ${loc} LOC) ═══`);
  console.log(explanation);
  console.log('');
  const byFile = new Map<string, typeof rows>();
  for (const s of rows) {
    const bucket = byFile.get(s.relativePath) ?? [];
    bucket.push(s);
    byFile.set(s.relativePath, bucket);
  }
  const fileOrder = [...byFile.entries()]
    .map(([file, bucket]) => ({
      file,
      bucket,
      totalLoc: bucket.reduce((sum, s) => sum + s.loc, 0),
    }))
    .sort((a, b) => b.totalLoc - a.totalLoc || a.file.localeCompare(b.file));

  let first = true;
  for (const { file, bucket } of fileOrder) {
    if (!first) console.log('');
    first = false;
    console.log(`  ${file}`);
    bucket.sort((a, b) => a.startLine - b.startLine);
    for (const s of bucket) {
      console.log(`    ${displayRange(s.startLine, s.endLine)}  (${s.loc} LOC)  ${s.shortName}`);
    }
  }
}

const handleUnusedImports = budgetedListCommand('unused-imports', {
  query: ({ db, args, budget }) => queries.unusedImports(db, stringArg(args, 0), { semantic: budget.semantic }),
  format: (r) => `  ${r.shortName}  in ${r.importedIn}`,
  emptyMessage: () => 'No unused imports found.',
  after: (rows) => console.log(`\n${rows.length} unused import(s)`),
});

const handleIsolated = budgetedGroupedByFileCommand('isolated', {
  query: ({ db, opts, budget }) => queries.isolated(db, {
    scope: stringOptionValue(opts, 'scope'),
    minLoc: definedNumberOption(opts, 'minLoc', 3),
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
  }),
  format: (r) => `  ${displayRange(r.startLine, r.endLine)}  (${r.loc} LOC)  ${r.shortName}`,
  emptyMessage: () => 'No isolated symbols found.',
  after: (rows) => console.log(`\n${rows.length} isolated symbol(s)`),
});

const handleExtractCandidates = budgetedDbCommand('extract-candidates', ({ db, args, opts, budget }) => {
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
    console.log(`\n${displayPathRange(r.relativePath, r.startLine, r.endLine)}  ${r.shortName}  (${r.loc} LOC, ${r.totalCallees} callees)`);
    for (let i = 0; i < r.clusters.length; i++) {
      const c = r.clusters[i]!;
      console.log(`  Cluster ${i + 1} (${Math.round(c.isolation * 100)}% isolated, ${c.callees.length} callees):`);
      for (const callee of c.callees) console.log(`    ${callee}`);
    }
  }
  console.log(`\n${results.length} extraction candidate(s) found.`);
});

const handleWrapperCandidates = budgetedListCommand('wrapper-candidates', {
  query: ({ db, opts, budget }) => queries.wrapperCandidates(db, {
    scope: stringOptionValue(opts, 'scope'),
    maxLoc: definedNumberOption(opts, 'maxLoc', 15),
    limit: definedLimitOption(opts, 'limit', 30),
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
  }),
  format: (r) =>
    `  ${displayPathRange(r.file, r.startLine, r.endLine)}  ${r.shortName}  (${r.loc} LOC)\n` +
    `    Only called by: ${r.singleCallerShort}  (fan-in: ${r.callerFanIn})`,
  emptyMessage: () => 'No wrapper candidates found.',
  heuristicLabel: 'wrapper candidates',
  after: (rows) => console.log(`\n${rows.length} wrapper candidate(s).`),
});

const handlePassthroughCandidates = budgetedListCommand('passthrough-candidates', {
  query: ({ db, opts, budget }) => queries.passthroughCandidates(db, {
    scope: stringOptionValue(opts, 'scope'),
    maxLoc: definedNumberOption(opts, 'maxLoc', 15),
    limit: definedLimitOption(opts, 'limit', 30),
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
  }),
  format: (r) =>
    `  ${displayPathRange(r.file, r.startLine, r.endLine)}  ${r.shortName}  (${r.loc} LOC)\n` +
    `    Forwards to: ${r.forwardsToShort}  (${r.forwardsToFile})`,
  emptyMessage: () => 'No passthrough candidates found.',
  heuristicLabel: 'passthrough candidates',
  after: (rows) => console.log(`\n${rows.length} passthrough candidate(s).`),
});

const handleStaleAbstractions = budgetedListCommand('stale-abstractions', {
  query: ({ db, opts, budget }) => queries.staleAbstractions(db, {
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
      `           ${r.reason}`
    );
  },
  emptyMessage: () => 'No stale abstractions found.',
  heuristicLabel: 'stale abstraction candidates',
  after: (rows) => console.log(`\n${rows.length} stale abstraction(s).`),
});

const handleComplexityHotspots = budgetedTableCommand('complexity-hotspots', {
  headers: ['score', ' LOC', 'fan-in', 'fan-out', 'callees', 'symbol'],
  query: ({ db, opts, budget }) => queries.complexityHotspots(db, {
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

const handleSimilar = budgetedReportCommand('similar', {
  query: ({ db, args, opts, budget }) => {
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
    if (result.rows.length > 0) return undefined;
    return result.mode === 'target' ? 'No similar symbols found.' : 'No similar symbol pairs found.';
  },
  heuristicLabel: 'similarity candidates',
  render: (result) => {
    if (result.mode === 'target') {
      render.list(result.rows, (r) => {
        const basis = r.similarityBasis ?? 'callees';
        const sharedLabel = basis === 'source-tokens' ? 'Shared source tokens' : 'Shared callees';
        const onlyLabel = basis === 'source-tokens' ? 'Only tokens in' : 'Only in';
        const lines = [
          `\n${Math.round(r.similarity * 100)}% similar:`,
          `  A: ${r.shortNameA}  (${r.fileA})`,
          `  B: ${r.shortNameB}  (${r.fileB})`,
          `  ${sharedLabel}: ${r.sharedCallees.join(', ')}`,
        ];
        if (r.uniqueToA.length) lines.push(`  ${onlyLabel} A: ${r.uniqueToA.join(', ')}`);
        if (r.uniqueToB.length) lines.push(`  ${onlyLabel} B: ${r.uniqueToB.join(', ')}`);
        return lines.join('\n');
      });
      return;
    }

    render.list(result.rows, (r) =>
      `\n${Math.round(r.similarity * 100)}% similar:\n` +
      `  A: ${r.shortNameA}  (${r.fileA})\n` +
      `  B: ${r.shortNameB}  (${r.fileB})\n` +
      `  Shared ${r.similarityBasis === 'source-tokens' ? 'source tokens' : 'callees'}: ${r.sharedCallees.join(', ')}`,
    );
    console.log(`\n${result.rows.length} similar pair(s) found.`);
  },
});

const handleSimilarFiles = reportCommand({
  commandName: 'similar-files',
  query: ({ db, args, opts }) => queries.similarFiles(db, {
    minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.5),
    limit: definedLimitOption(opts, 'limit', 20),
    scope: stringOptionValue(opts, 'scope'),
    minDeps: numberOptionValue(opts, 'minDeps'),
    filePattern: optionalStringArg(args, 0),
  }),
  emptyMessage: (results) => results.length === 0 ? 'No similar file pairs found.' : undefined,
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

const handleReactComponentDuplicates = budgetedReportCommand('react-component-duplicates', {
  query: ({ db, args, opts, budget }) => queries.reactComponentDuplicates(db, {
    minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.62),
    minTokens: definedNumberOption(opts, 'minTokens', 8),
    limit: definedLimitOption(opts, 'limit', 20),
    scope: stringOptionValue(opts, 'scope'),
    scanLimit: budget.scanLimit,
    filePattern: optionalStringArg(args, 0),
  }),
  emptyMessage: (results) => results.length === 0 ? 'No duplicated React component structures found.' : undefined,
  heuristicLabel: 'React component duplicate candidates',
  render: (results) => {
    render.list(results, (r) => {
      const lines = [
        `\n${Math.round(r.similarity * 100)}% similar React structure:`,
        `  ${r.componentA}  (${r.fileA})`,
        `  ${r.componentB}  (${r.fileB})`,
      ];
      if (r.sharedComponents.length) lines.push(`  Shared components: ${r.sharedComponents.join(', ')}`);
      if (r.sharedNativeTags.length) lines.push(`  Shared native tags: ${r.sharedNativeTags.join(', ')}`);
      if (r.sharedProps.length) lines.push(`  Shared props: ${r.sharedProps.join(', ')}`);
      if (r.sharedEvents.length) lines.push(`  Shared events: ${r.sharedEvents.join(', ')}`);
      if (r.sharedBindings.length) lines.push(`  Shared bindings: ${r.sharedBindings.slice(0, 20).join(', ')}`);
      return lines.join('\n');
    });
    console.log(`\n${results.length} duplicated React component pair(s) found.`);
  },
});

const handleReactHookCandidates = budgetedReportCommand('react-hook-candidates', {
  query: ({ db, args, opts, budget }) => queries.reactHookCandidates(db, {
    minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.45),
    minSharedBehaviors: definedNumberOption(opts, 'minSharedBehaviors', 6),
    limit: definedLimitOption(opts, 'limit', 20),
    scope: stringOptionValue(opts, 'scope'),
    scanLimit: budget.scanLimit,
    filePattern: optionalStringArg(args, 0),
  }),
  emptyMessage: (results) => results.length === 0 ? 'No duplicated React hook behavior candidates found.' : undefined,
  heuristicLabel: 'React hook extraction candidates',
  render: (results) => {
    render.list(results, (r) => {
      const lines = [
        `\n${Math.round(r.similarity * 100)}% similar React behavior:`,
        `  ${r.componentA}  (${r.fileA})`,
        `  ${r.componentB}  (${r.fileB})`,
        `  ${r.reason}`,
      ];
      if (r.sharedHooks.length) lines.push(`  Shared hooks: ${r.sharedHooks.join(', ')}`);
      if (r.sharedReactHooks.length) lines.push(`  Shared React hooks: ${r.sharedReactHooks.join(', ')}`);
      if (r.sharedEffects.length) lines.push(`  Shared effects: ${r.sharedEffects.join(', ')}`);
      if (r.sharedState.length) lines.push(`  Shared state: ${r.sharedState.join(', ')}`);
      if (r.sharedRequests.length) lines.push(`  Shared requests: ${r.sharedRequests.join(', ')}`);
      if (r.sharedHandlers.length) lines.push(`  Shared handlers: ${r.sharedHandlers.slice(0, 12).join(', ')}`);
      if (r.sharedHandlerVerbs.length) lines.push(`  Shared action verbs: ${r.sharedHandlerVerbs.slice(0, 12).join(', ')}`);
      return lines.join('\n');
    });
    console.log(`\n${results.length} React hook candidate pair(s) found.`);
  },
});

const handleReactLargeComponentPressure = budgetedReportCommand('react-large-component-pressure', {
  query: ({ db, args, opts, budget }) => queries.reactLargeComponentPressure(db, {
    minComponentLines: definedNumberOption(opts, 'minComponentLines', 300),
    minFileLines: definedNumberOption(opts, 'minFileLines', 800),
    minJsxTokens: definedNumberOption(opts, 'minJsxTokens', 80),
    minBehaviorTokens: definedNumberOption(opts, 'minBehaviorTokens', 40),
    limit: definedLimitOption(opts, 'limit', 20),
    scope: stringOptionValue(opts, 'scope'),
    scanLimit: budget.scanLimit,
    filePattern: optionalStringArg(args, 0),
  }),
  emptyMessage: (results) => results.length === 0 ? 'No large React component pressure found.' : undefined,
  heuristicLabel: 'large React component pressure candidates',
  render: (results) => {
    render.list(results, (r) => {
      const lines = [
        `\n${r.componentLines} component line(s): ${r.component}  (${r.file})`,
        `  Dominant pressure: ${r.dominantPressure}`,
        `  File lines: ${r.fileLines}; JSX tokens: ${r.jsxTokens}; behavior tokens: ${r.behaviorTokens}`,
        `  Reasons: ${r.reasons.join('; ')}`,
      ];
      return lines.join('\n');
    });
    console.log(`\n${results.length} large React component(s) found.`);
  },
});

const handleVueComponentDuplicates = budgetedReportCommand('vue-component-duplicates', {
  query: ({ db, args, opts, budget }) => queries.vueComponentDuplicates(db, {
    minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.62),
    minTokens: definedNumberOption(opts, 'minTokens', 8),
    limit: definedLimitOption(opts, 'limit', 20),
    scope: stringOptionValue(opts, 'scope'),
    scanLimit: budget.scanLimit,
    filePattern: optionalStringArg(args, 0),
  }),
  emptyMessage: (results) => results.length === 0 ? 'No duplicated Vue component structures found.' : undefined,
  heuristicLabel: 'Vue component duplicate candidates',
  render: (results) => {
    render.list(results, (r) => {
      const lines = [
        `\n${Math.round(r.similarity * 100)}% similar Vue structure:`,
        `  ${r.fileA}`,
        `  ${r.fileB}`,
      ];
      if (r.sharedComponents.length) lines.push(`  Shared components: ${r.sharedComponents.join(', ')}`);
      if (r.sharedProps.length) lines.push(`  Shared props: ${r.sharedProps.join(', ')}`);
      if (r.sharedEvents.length) lines.push(`  Shared events: ${r.sharedEvents.join(', ')}`);
      if (r.sharedDirectives.length) lines.push(`  Shared directives: ${r.sharedDirectives.join(', ')}`);
      if (r.sharedSlots.length) lines.push(`  Shared slots: ${r.sharedSlots.join(', ')}`);
      if (r.sharedIdentifiers.length) lines.push(`  Shared identifiers: ${r.sharedIdentifiers.slice(0, 20).join(', ')}`);
      return lines.join('\n');
    });
    console.log(`\n${results.length} duplicated Vue component pair(s) found.`);
  },
});

const handleVueComposableCandidates = budgetedReportCommand('vue-composable-candidates', {
  query: ({ db, args, opts, budget }) => queries.vueComposableCandidates(db, {
    minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.45),
    minSharedBehaviors: definedNumberOption(opts, 'minSharedBehaviors', 6),
    limit: definedLimitOption(opts, 'limit', 20),
    scope: stringOptionValue(opts, 'scope'),
    scanLimit: budget.scanLimit,
    filePattern: optionalStringArg(args, 0),
  }),
  emptyMessage: (results) => results.length === 0 ? 'No duplicated Vue behavior candidates found.' : undefined,
  heuristicLabel: 'Vue composable extraction candidates',
  render: (results) => {
    render.list(results, (r) => {
      const lines = [
        `\n${Math.round(r.similarity * 100)}% similar Vue behavior:`,
        `  ${r.fileA}`,
        `  ${r.fileB}`,
        `  ${r.reason}`,
      ];
      if (r.sharedComposables.length) lines.push(`  Shared composables: ${r.sharedComposables.join(', ')}`);
      if (r.sharedStores.length) lines.push(`  Shared stores: ${r.sharedStores.join(', ')}`);
      if (r.sharedRequests.length) lines.push(`  Shared requests: ${r.sharedRequests.join(', ')}`);
      if (r.sharedLifecycle.length) lines.push(`  Shared lifecycle: ${r.sharedLifecycle.join(', ')}`);
      if (r.sharedFunctions.length) lines.push(`  Shared functions: ${r.sharedFunctions.slice(0, 12).join(', ')}`);
      if (r.sharedFunctionVerbs.length) lines.push(`  Shared action verbs: ${r.sharedFunctionVerbs.slice(0, 12).join(', ')}`);
      if (r.sharedBindings.length) lines.push(`  Shared bindings: ${r.sharedBindings.slice(0, 20).join(', ')}`);
      if (r.sharedTemplateEvents.length) lines.push(`  Shared template events: ${r.sharedTemplateEvents.slice(0, 20).join(', ')}`);
      return lines.join('\n');
    });
    console.log(`\n${results.length} Vue composable candidate pair(s) found.`);
  },
});

const handleVueLargeViewPressure = budgetedReportCommand('vue-large-view-pressure', {
  query: ({ db, args, opts, budget }) => queries.vueLargeViewPressure(db, {
    minTotalLines: definedNumberOption(opts, 'minTotalLines', 800),
    minTemplateLines: definedNumberOption(opts, 'minTemplateLines', 300),
    minScriptLines: definedNumberOption(opts, 'minScriptLines', 300),
    minStyleLines: definedNumberOption(opts, 'minStyleLines', 500),
    limit: definedLimitOption(opts, 'limit', 20),
    scope: stringOptionValue(opts, 'scope'),
    scanLimit: budget.scanLimit,
    filePattern: optionalStringArg(args, 0),
  }),
  emptyMessage: (results) => results.length === 0 ? 'No large Vue view pressure found.' : undefined,
  heuristicLabel: 'large Vue view pressure candidates',
  render: (results) => {
    render.list(results, (r) => {
      const lines = [
        `\n${r.totalLines} total line(s): ${r.file}`,
        `  Dominant pressure: ${r.dominantPressure}`,
        `  Blocks: template ${r.templateLines}, script ${r.scriptLines}, style ${r.styleLines}, external script ${r.externalScriptLines}, custom ${r.customBlockLines}`,
      ];
      if (r.externalScriptPaths.length) lines.push(`  External scripts: ${r.externalScriptPaths.join(', ')}`);
      lines.push(`  Reasons: ${r.reasons.join('; ')}`);
      return lines.join('\n');
    });
    console.log(`\n${results.length} large Vue view pressure file(s) found.`);
  },
});

const handleSimilarChains = reportCommand({
  commandName: 'similar-chains',
  query: ({ db, opts }) => queries.similarChains(db, {
    minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.5),
    limit: definedLimitOption(opts, 'limit', 15),
    scope: stringOptionValue(opts, 'scope'),
    minChainLength: definedNumberOption(opts, 'minLength', 3),
    maxChainLength: definedNumberOption(opts, 'maxLength', 8),
  }),
  emptyMessage: (results) => results.length === 0 ? 'No similar chains found.' : undefined,
  heuristicLabel: 'similar chain candidates',
  render: (results) => {
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      console.log(`\n── Chain pair ${i + 1} (${Math.round(r.similarity * 100)}% similar, ${r.divergencePoints.length} divergence point(s)) ──`);
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

const handleDrift = budgetedReportCommand('drift', {
  query: ({ db, args, opts, budget }) => queries.drift(db, {
    scope: optionalStringArg(args, 0),
    minDeviation: definedNumberOption(opts, 'minDeviation', 5),
    semantic: budget.semantic,
  }),
  emptyMessage: (summary) => summary.results.length === 0 ? 'No drift detected.' : undefined,
  heuristicLabel: 'drift candidates',
  render: (summary) => {
    console.log('');
    render.groupedByFile(
      summary.results,
      (r) => {
        const tag = r.kind === 'unused-import' ? 'UNUSED' : r.kind === 'layer-violation' ? 'LAYER' : 'UNIQUE';
        const head = `  [${tag}] ${r.description}`;
        return r.detail ? `${head}\n         ${r.detail}` : head;
      },
      (r) => r.file,
    );
    console.log(`\n${summary.unusedImports} unused import(s), ${summary.layerViolations} layer violation(s), ${summary.patternDeviations} pattern deviation(s)`);
  },
});

const handleConvergence = budgetedReportCommand('convergence', {
  query: ({ db, args, budget }) =>
    queries.convergence(db, stringArg(args, 0), stringArg(args, 1), { semantic: budget.semantic }),
  emptyMessage: (result) => result ? undefined : 'One or both symbols not found.',
  render: (result) => {
    if (!result) return;
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

const handleSimilarSignatures = budgetedListCommand('similar-signatures', {
  query: ({ db, opts, budget }) => queries.similarSignatures(db, {
    scope: stringOptionValue(opts, 'scope'),
    minLoc: definedNumberOption(opts, 'minLoc', 3),
    limit: definedLimitOption(opts, 'limit', 20),
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
  }),
  format: (g) => {
    const head = `\nSignature: ${g.signature}  (${g.functions.length} functions)`;
    const body = g.functions
      .map((f) => `  ${displayPathRange(f.file, f.startLine, f.endLine)}  ${f.shortName}  (${f.loc} LOC)`)
      .join('\n');
    return `${head}\n${body}`;
  },
  emptyMessage: () => 'No same-shape function groups found.',
  after: (groups) => console.log(`\n${groups.length} group(s) found.`),
});

type CleanupCommandDescriptor = Omit<CommandDescriptor, 'docs'> & {
  docs?: CommandDescriptor['docs'];
};

type HeuristicCleanupCommandDescriptor = Omit<CleanupCommandDescriptor, 'heuristic'> & {
  heuristicLabel: string;
};

function cleanupCommand(descriptor: CleanupCommandDescriptor): CommandDescriptor {
  return {
    docs: doc('Cleanup'),
    ...descriptor,
  };
}

function heuristicCleanupCommand({
  heuristicLabel,
  ...descriptor
}: HeuristicCleanupCommandDescriptor): CommandDescriptor {
  return cleanupCommand({
    ...descriptor,
    heuristic: { label: heuristicLabel },
  });
}

const handleCleanupPlan = budgetedDbCommand('cleanup-plan', ({ db, args, opts, budget }) => {
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
    console.error(`cleanup-plan --patch: ${selectedBatches.length} compiler-verified batch(es), ${result.totalLoc} LOC.`);
    console.log(patch);
    return;
  }

  console.log(`Cleanup plan: ${result.totalSymbols} symbol(s), ${result.totalLoc} LOC across ${result.batches.length} batch(es).`);
  console.log('Apply one batch at a time; run your typecheck between batches.\n');
  for (const batch of result.batches) {
    const header = batch.depth === 0
      ? `── Batch 0: deletable now (graph-fact, ${batch.loc} LOC) ──`
      : `── Batch ${batch.depth}: dead once batch ${batch.depth - 1} lands (cascade, ${batch.loc} LOC) ──`;
    console.log(header);
    for (const entry of batch.entries) {
      console.log(`  ${entry.file}:${entry.startLine + 1}-${entry.endLine + 1}  ${entry.shortName}  (${entry.loc} LOC)`);
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
      console.log('  No checker detected (need tsconfig.json or a Cargo.toml) — skipped.');
      return;
    }
    for (const checker of verification.checkers) {
      console.log(`  Checker: ${checker}`);
    }
    if (verification.uncoveredFiles.length > 0) {
      console.log(`  WARNING: no checker covers these plan files (entries there are NOT verified): ${verification.uncoveredFiles.join(', ')}`);
    }
    if (verification.baselineErrors > 0) {
      console.log(`  Baseline has ${verification.baselineErrors} pre-existing error(s) — verifying differentially (no NEW errors).`);
    }
    if (verification.dirtyOverlap.length > 0) {
      console.log(`  WARNING: plan files dirty in working tree (verification runs at HEAD): ${verification.dirtyOverlap.join(', ')}`);
    }
    for (const batch of verification.batches) {
      if (batch.status === 'verified') {
        console.log(`  Batch ${batch.depth}: COMPILER-VERIFIED`);
      } else {
        console.log(`  Batch ${batch.depth}: FAILED — the errors below name references the static evidence missed:`);
        for (const error of batch.errors ?? []) {
          console.log(`    ${error}`);
        }
      }
    }
  }
});

const handleCleanupApply = budgetedDbCommand('cleanup-apply', ({ db, opts, budget }) => {
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
  console.log(`Applied ${selectedBatches.length} compiler-verified cleanup batch(es): ${symbols} symbol(s), ${loc} LOC.`);
});

const handleRecentDuplicates = budgetedDbCommand('recent-duplicates', ({ db, args, opts, budget }) => {
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
  console.log(`Recent re-implementations (window: last ${result.windowCommits} commits):\n`);
  for (const finding of result.findings) {
    const evidence = finding.sharedEvidence.slice(0, 16).join(', ');
    if (finding.kind === 'echo') {
      console.log(`  ${Math.round(finding.similarity * 100)}%  ECHO  ${finding.domain}  ${finding.echoFile}  ${finding.echoSymbol}  (added ${finding.echoAgeCommits} commits ago)`);
      console.log(`        duplicates established  ${finding.establishedFile}  ${finding.establishedSymbol}`);
    } else {
      console.log(`  ${Math.round(finding.similarity * 100)}%  TWIN  ${finding.domain}  ${finding.echoFile}  ${finding.echoSymbol}`);
      console.log(`        and                     ${finding.establishedFile}  ${finding.establishedSymbol}  (both new — consolidate before they diverge)`);
    }
    console.log(`        basis: ${finding.basis}`);
    if (evidence.length > 0) console.log(`        shared: ${evidence}`);
  }
  console.log(`\n${result.findings.length} finding(s). ECHO: prefer extending the established side and deleting the echo.`);
});

const handleDocDrift = dbCommand(({ db, args, opts }) => {
  const result = queries.docDrift(db, {
    doc: args[0] === undefined ? undefined : stringArg(args, 0),
    limit: definedLimitOption(opts, 'limit', 20),
    minCoupling: definedNumberOption(opts, 'minCoupling', 3),
  });
  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('doc-drift', args, opts, result);
    return;
  }
  if (!result.available) return render.empty('No git history available (not a repository, or git missing).');
  if (result.findings.length === 0) {
    return render.empty(`No drifting docs found across ${result.docsScanned} doc(s) — referenced and co-changed code has not moved since each doc last changed.`);
  }
  console.log(`Docs whose referenced or co-changed code moved on without them (${result.docsScanned} docs scanned, ${result.commitsAnalyzed} commits analyzed):\n`);
  for (const finding of result.findings) {
    console.log(`  staleness ${finding.staleness}  ${finding.doc}`);
    for (const broken of finding.brokenReferences.slice(0, 4)) {
      console.log(`    BROKEN REFERENCE: cites ${broken} — that file no longer exists`);
    }
    for (const subject of finding.subjects.slice(0, 4)) {
      const evidence = subject.evidence === 'both'
        ? `referenced by doc + coupled ${subject.coChanges}x`
        : subject.evidence === 'reference'
          ? 'referenced by doc'
          : `coupled ${subject.coChanges}x historically`;
      console.log(`    ${subject.changesSinceDocUpdate} change(s) since doc update  ${subject.file}  (${evidence})`);
    }
  }
  console.log('\nStale standards docs are worse than none — agents implement to a dead spec.');
});

const handleUnusedParams = budgetedListCommand('unused-params', {
  query: ({ db, opts, budget }) => queries.unusedParams(db, {
    scope: stringOptionValue(opts, 'scope'),
    limit: definedLimitOption(opts, 'limit', 30),
    scanLimit: budget.scanLimit,
  }),
  format: (r) =>
    `  ${displayPathRange(r.file, r.startLine, r.endLine)}  ${r.shortName}\n` +
    `    trailing unused: ${r.unusedTrailing.join(', ')}  (${r.unusedTrailing.length} of ${r.paramCount} params — safe to drop)`,
  emptyMessage: () => 'No trailing unused parameters found.',
  heuristicLabel: 'unused trailing parameter candidates',
  after: (rows) => console.log(`\n${rows.length} function(s) with trailing unused parameters.`),
});

export const cleanupQueryCommandDescriptors: CommandDescriptor[] = [
  cleanupCommand({
    id: 'unused-params',
    command: 'unused-params',
    description: 'Speculative-generality candidates: trailing parameters no body ever uses (TS/JS)',
    options: withJsonOption([
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('-n, --limit <n>', 'Maximum findings', parseInteger, 30),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    budget: 'candidate-scan',
    heuristic: { label: 'unused trailing parameter candidates' },
    renderShape: 'list',
    docs: doc('Cleanup', ['scip-query unused-params -s src/services']),
    handler: handleUnusedParams,
  }),
  cleanupCommand({
    id: 'cleanup-plan',
    command: 'cleanup-plan',
    description: 'Ordered, batched deletion plan: graph-fact dead code plus the cascade candidates it unlocks',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-loc <n>', 'Only include symbols >= N lines', parseInteger, 1),
      option('--max-depth <n>', 'Maximum cascade depth', parseInteger, 5),
      option('--verify', 'Apply batches in a throwaway worktree and run the project checker (tsc / cargo check)'),
      option('--patch', 'With --verify, print the compiler-verified deletion patch to stdout'),
      option('--json', 'Output as JSON for programmatic consumption'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ],
    budget: 'candidate-scan',
    renderShape: 'custom',
    docs: doc('Cleanup', ['scip-query cleanup-plan --min-loc 3', 'scip-query cleanup-plan --verify']),
    handler: handleCleanupPlan,
  }),
  cleanupCommand({
    id: 'cleanup-apply',
    command: 'cleanup-apply',
    description: 'Apply a compiler-verified cleanup-plan batch to the working tree',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-loc <n>', 'Only include symbols >= N lines', parseInteger, 1),
      option('--max-depth <n>', 'Maximum cascade depth', parseInteger, 5),
      option('--verified', 'Required: verify the selected cleanup batch before applying it'),
      option('--batch <n>', 'Apply one batch depth', parseInteger),
      option('--all', 'Apply every compiler-verified batch in the plan'),
      option('--force-dirty', 'Allow applying when plan files already have working-tree edits'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ],
    budget: 'candidate-scan',
    renderShape: 'custom',
    docs: doc('Cleanup', ['scip-query cleanup-apply --verified --batch 0']),
    handler: handleCleanupApply,
  }),
  cleanupCommand({
    id: 'recent-duplicates',
    command: 'recent-duplicates',
    description: 'Directional duplicate candidates: recent code that re-implements established callable, React, or Vue code',
    options: withJsonOption([
      option('--window <n>', 'How many commits back counts as "recent"', parseInteger, 100),
      option('--min-similarity <n>', 'Minimum similarity (0-1); omitted uses detector defaults', parseNumber),
      option('-n, --limit <n>', 'Maximum findings', parseInteger, 30),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    budget: 'candidate-scan',
    heuristic: { label: 'recent re-implementation candidates' },
    renderShape: 'custom',
    docs: doc('Cleanup', ['scip-query recent-duplicates --window 50']),
    handler: handleRecentDuplicates,
  }),
  cleanupCommand({
    id: 'doc-drift',
    command: 'doc-drift [doc]',
    description: 'Stale-doc candidates: code the doc references or co-changed with kept changing after the doc stopped',
      options: withJsonOption([
        option('-n, --limit <n>', 'Maximum docs to report', parseInteger, 20),
        option('--min-coupling <n>', 'Minimum historical co-changes to track a subject', parseInteger, 3),
        option('--full', 'Run unbounded analysis on large indexes'),
      ]),
    heuristic: { label: 'doc drift candidates' },
    renderShape: 'custom',
    docs: doc('Cleanup', ['scip-query doc-drift', 'scip-query doc-drift AGENTS.md']),
    handler: handleDocDrift,
  }),
  cleanupCommand({
    id: 'dead',
    command: 'dead [scope]',
    description: 'Find dead code and file-internal symbols (no cross-file consumers)',
    options: withJsonOption([
      option('--min-loc <n>', 'Only show symbols >= N lines', parseInteger, 1),
      option('--include-tests', 'Include test files'),
      option('--skip-barrels', 'Ignore refs from barrel re-export files'),
      option('--include-members', 'Include class members'),
      option('--only-dead', 'Show only [dead code] symbols (skip [file-internal only])'),
      option('--only-internal', 'Show only [file-internal only] symbols (skip [dead code])'),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    budget: 'candidate-scan',
    renderShape: 'custom',
    docs: doc('Cleanup', ['scip-query dead --min-loc 10']),
    handler: handleDead,
  }),
  cleanupCommand({
    id: 'unused-imports',
    command: 'unused-imports <file>',
    description: 'Find imports not referenced in the same file',
    options: withJsonOption([option('--full', 'Run unbounded semantic analysis on large indexes')]),
    budget: 'semantic',
    renderShape: 'list',
    handler: handleUnusedImports,
  }),
  cleanupCommand({
    id: 'isolated',
    command: 'isolated',
    description: 'Find completely orphaned symbols (no references at all)',
    options: withJsonOption([
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-loc <n>', 'Minimum lines of code', parseInteger, 3),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    budget: 'candidate-scan',
    renderShape: 'grouped-by-file',
    handler: handleIsolated,
  }),
  heuristicCleanupCommand({
    id: 'similar',
    command: 'similar [symbol]',
    description: 'Find heuristic function similarity candidates from callee fingerprints',
    options: withJsonOption([
      option('--min-similarity <n>', 'Minimum Jaccard similarity (0-1)', parseNumber, 0.4),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-callees <n>', 'Minimum callees to consider', parseInteger, 4),
      option('--cross-file-only', 'Only show cross-file pairs (skip same-file matches)'),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    heuristicLabel: 'similarity candidates',
    budget: 'candidate-scan',
    renderShape: 'custom',
    handler: handleSimilar,
  }),
  heuristicCleanupCommand({
    id: 'similar-files',
    command: 'similar-files [file]',
    description: 'Find heuristic similar-file candidates from dependency profiles',
      options: withJsonOption([
        option('--min-similarity <n>', 'Minimum Jaccard similarity (0-1)', parseNumber, 0.5),
        option('-n, --limit <n>', 'Number of results', parseInteger, 20),
        option('-s, --scope <path>', 'Limit to files matching path'),
        option('--min-deps <n>', 'Minimum dependencies to consider', parseInteger),
        option('--full', 'Run unbounded analysis on large indexes'),
      ]),
    heuristicLabel: 'similar file candidates',
    renderShape: 'custom',
    handler: handleSimilarFiles,
  }),
  heuristicCleanupCommand({
    id: 'react-component-duplicates',
    command: 'react-component-duplicates [file]',
    description: 'Find heuristic duplicated React component structure candidates from JSX tags, props, events, and bindings',
    options: withJsonOption([
      option('--min-similarity <n>', 'Minimum JSX structure similarity (0-1)', parseNumber, 0.62),
      option('--min-tokens <n>', 'Minimum structural tokens to consider', parseInteger, 8),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    heuristicLabel: 'React component duplicate candidates',
    budget: 'candidate-scan',
    renderShape: 'custom',
    handler: handleReactComponentDuplicates,
  }),
  heuristicCleanupCommand({
    id: 'react-hook-candidates',
    command: 'react-hook-candidates [file]',
    description: 'Find heuristic React hook extraction candidates from shared state, effects, requests, and handlers',
    options: withJsonOption([
      option('--min-similarity <n>', 'Minimum behavior similarity (0-1)', parseNumber, 0.45),
      option('--min-shared-behaviors <n>', 'Minimum shared behavior tokens', parseInteger, 6),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    heuristicLabel: 'React hook extraction candidates',
    budget: 'candidate-scan',
    renderShape: 'custom',
    handler: handleReactHookCandidates,
  }),
  heuristicCleanupCommand({
    id: 'react-large-component-pressure',
    command: 'react-large-component-pressure [file]',
    description: 'Find heuristic large React component pressure candidates from component lines, JSX structure, and hook behavior',
    options: withJsonOption([
      option('--min-component-lines <n>', 'Minimum component lines', parseInteger, 300),
      option('--min-file-lines <n>', 'Minimum file lines', parseInteger, 800),
      option('--min-jsx-tokens <n>', 'Minimum JSX structure tokens', parseInteger, 80),
      option('--min-behavior-tokens <n>', 'Minimum behavior tokens', parseInteger, 40),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    heuristicLabel: 'large React component pressure candidates',
    budget: 'candidate-scan',
    renderShape: 'custom',
    handler: handleReactLargeComponentPressure,
  }),
  heuristicCleanupCommand({
    id: 'vue-component-duplicates',
    command: 'vue-component-duplicates [file]',
    description: 'Find heuristic duplicated Vue component structure candidates from template tags, bindings, slots, and directives',
    options: withJsonOption([
      option('--min-similarity <n>', 'Minimum template similarity (0-1)', parseNumber, 0.62),
      option('--min-tokens <n>', 'Minimum structural tokens to consider', parseInteger, 8),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    heuristicLabel: 'Vue component duplicate candidates',
    budget: 'candidate-scan',
    renderShape: 'custom',
    handler: handleVueComponentDuplicates,
  }),
  heuristicCleanupCommand({
    id: 'vue-composable-candidates',
    command: 'vue-composable-candidates [file]',
    description: 'Find heuristic Vue composable extraction candidates from shared state, effects, requests, and template bindings',
    options: withJsonOption([
      option('--min-similarity <n>', 'Minimum behavior similarity (0-1)', parseNumber, 0.45),
      option('--min-shared-behaviors <n>', 'Minimum shared behavior tokens', parseInteger, 6),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    heuristicLabel: 'Vue composable extraction candidates',
    budget: 'candidate-scan',
    renderShape: 'custom',
    handler: handleVueComposableCandidates,
  }),
  heuristicCleanupCommand({
    id: 'vue-large-view-pressure',
    command: 'vue-large-view-pressure [file]',
    description: 'Find heuristic large Vue view pressure candidates from template, script, style, and external script line counts',
    options: withJsonOption([
      option('--min-total-lines <n>', 'Minimum total component lines', parseInteger, 800),
      option('--min-template-lines <n>', 'Minimum template lines', parseInteger, 300),
      option('--min-script-lines <n>', 'Minimum script lines', parseInteger, 300),
      option('--min-style-lines <n>', 'Minimum style lines', parseInteger, 500),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--full', 'Run unbounded analysis on large indexes'),
    ]),
    heuristicLabel: 'large Vue view pressure candidates',
    budget: 'candidate-scan',
    renderShape: 'custom',
    handler: handleVueLargeViewPressure,
  }),
  heuristicCleanupCommand({
    id: 'similar-chains',
    command: 'similar-chains',
    description: 'Find heuristic similar-chain candidates from dependency flows',
      options: withJsonOption([
        option('--min-similarity <n>', 'Minimum chain similarity (0-1)', parseNumber, 0.5),
        option('-n, --limit <n>', 'Number of results', parseInteger, 15),
        option('-s, --scope <path>', 'Limit to files matching path'),
        option('--min-length <n>', 'Minimum chain length', parseInteger, 3),
        option('--max-length <n>', 'Maximum chain length', parseInteger, 8),
        option('--full', 'Run unbounded analysis on large indexes'),
      ]),
    heuristicLabel: 'similar chain candidates',
    renderShape: 'custom',
    handler: handleSimilarChains,
  }),
  heuristicCleanupCommand({
    id: 'extract-candidates',
    command: 'extract-candidates',
    description: 'Find heuristic extraction candidates from isolated callee clusters',
    options: withJsonOption([
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-loc <n>', 'Minimum function LOC', parseInteger, 10),
      option('--min-callees <n>', 'Minimum callees to analyze', parseInteger, 6),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    heuristicLabel: 'extraction candidates',
    budget: 'candidate-scan',
    renderShape: 'custom',
    handler: handleExtractCandidates,
  }),
  heuristicCleanupCommand({
    id: 'drift',
    command: 'drift [module]',
    description: 'Detect heuristic drift candidates: unused imports, layer violations, and pattern deviations',
    options: withJsonOption([
      option('--min-deviation <n>', 'Minimum sibling files before reporting unique dependency deviations', parsePositiveInteger, 5),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    heuristicLabel: 'drift candidates',
    budget: 'semantic',
    renderShape: 'grouped-by-file',
    handler: handleDrift,
  }),
  heuristicCleanupCommand({
    id: 'wrapper-candidates',
    command: 'wrapper-candidates',
    description: 'Find heuristic wrapper candidates only called by one consumer',
    options: withJsonOption([
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--max-loc <n>', 'Maximum LOC for candidates', parseInteger, 15),
      option('-n, --limit <n>', 'Number of results', parseInteger, 30),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    heuristicLabel: 'wrapper candidates',
    budget: 'candidate-scan',
    renderShape: 'list',
    handler: handleWrapperCandidates,
  }),
  heuristicCleanupCommand({
    id: 'passthrough-candidates',
    command: 'passthrough-candidates',
    description: 'Find heuristic passthrough candidates that forward to one callee',
    options: withJsonOption([
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--max-loc <n>', 'Maximum LOC for candidates', parseInteger, 15),
      option('-n, --limit <n>', 'Number of results', parseInteger, 30),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    heuristicLabel: 'passthrough candidates',
    budget: 'candidate-scan',
    renderShape: 'list',
    handler: handlePassthroughCandidates,
  }),
  heuristicCleanupCommand({
    id: 'stale-abstractions',
    command: 'stale-abstractions',
    description: 'Find heuristic stale abstraction candidates with 0-1 consumers',
    options: withJsonOption([
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-loc <n>', 'Minimum LOC', parseInteger, 3),
      option('-n, --limit <n>', 'Number of results', parseInteger, 30),
      option('--include-low-confidence', 'Include 1-consumer classes (usually encapsulation, not stale)', undefined, false),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    heuristicLabel: 'stale abstraction candidates',
    budget: 'candidate-scan',
    renderShape: 'list',
    handler: handleStaleAbstractions,
  }),
  heuristicCleanupCommand({
    id: 'complexity-hotspots',
    command: 'complexity-hotspots',
    description: 'Find heuristic complexity hotspot candidates from LOC x fan-in x fan-out',
    options: withJsonOption([
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-loc <n>', 'Minimum LOC', parseInteger, 10),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    heuristicLabel: 'complexity hotspot candidates',
    budget: 'candidate-scan',
    renderShape: 'table',
    handler: handleComplexityHotspots,
  }),
  cleanupCommand({
    id: 'convergence',
    command: 'convergence <symbol1> <symbol2>',
    description: 'Show what a consolidated version of two similar functions would look like',
    options: withJsonOption([option('--full', 'Run unbounded semantic analysis on large indexes')]),
    budget: 'semantic',
    renderShape: 'custom',
    handler: handleConvergence,
  }),
  groupedQueryCommand({
    id: 'redundant-reexports',
    command: 'redundant-reexports',
    description: 'Find barrel re-exports that nobody imports through',
      options: [
        option('-s, --scope <path>', 'Limit to files matching path'),
        option('-n, --limit <n>', 'Number of results', parseInteger, 30),
        option('--full', 'Run unbounded analysis on large indexes'),
      ],
    docs: doc('Cleanup'),
      query: ({ db, opts }) => queries.redundantReexports(db, {
        scope: stringOptionValue(opts, 'scope'),
        limit: definedLimitOption(opts, 'limit', 30),
      }),
    format: (r) =>
      `  ${r.shortName}  (from ${r.originalFile})\n` +
      `    barrel: ${r.barrelConsumers} consumer(s) | direct: ${r.directConsumers} consumer(s)`,
    key: (r) => r.barrelFile,
    emptyMessage: () => 'No redundant re-exports found.',
    after: (rows) => console.log(`\n${rows.length} redundant re-export(s).`),
  }),
  cleanupCommand({
    id: 'similar-signatures',
    command: 'similar-signatures',
    description: 'Find functions with near-identical type signatures (same shape)',
    options: withJsonOption([
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-loc <n>', 'Minimum LOC per function', parseInteger, 3),
      option('-n, --limit <n>', 'Number of groups', parseInteger, 20),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ]),
    budget: 'candidate-scan',
    renderShape: 'list',
    handler: handleSimilarSignatures,
  }),
];
