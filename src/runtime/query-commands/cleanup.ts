import type { DeadOptions } from '../../domain/types.js';
import * as queries from '../../queries/index.js';
import { resolveProjectRoot } from '../cli-context.js';
import { verifyCleanupPlan } from '../cleanup-verify.js';
import { renderHeuristicNotice } from '../cli-support.js';
import type { CommandDescriptor } from '../command-descriptor-types.js';
import { doc, option, parseInteger, parseNumber, parsePositiveInteger } from '../command-spec-builders.js';
import {
  booleanOptionValue,
  budgetedDbCommand,
  dbCommand,
  budgetedGroupedByFileCommand,
  budgetedListCommand,
  budgetedReportCommand,
  budgetedTableCommand,
  definedNumberOption,
  numberOptionValue,
  optionalStringArg,
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

const handleExtractCandidates = budgetedDbCommand('extract-candidates', ({ db, opts, budget }) => {
  const results = queries.extractCandidates(db, {
    scope: stringOptionValue(opts, 'scope'),
    minLoc: definedNumberOption(opts, 'minLoc', 10),
    minCallees: definedNumberOption(opts, 'minCallees', 6),
    limit: definedNumberOption(opts, 'limit', 20),
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
  });
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
    limit: definedNumberOption(opts, 'limit', 30),
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
    limit: definedNumberOption(opts, 'limit', 30),
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
    limit: definedNumberOption(opts, 'limit', 30),
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
    limit: definedNumberOption(opts, 'limit', 20),
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
          limit: definedNumberOption(opts, 'limit', 20),
          scanLimit: budget.scanLimit,
          semantic: budget.semantic,
        }),
      };
    }
    return {
      mode: 'all' as const,
      rows: queries.similarAll(db, {
        minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.4),
        limit: definedNumberOption(opts, 'limit', 20),
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
  query: ({ db, args, opts }) => queries.similarFiles(db, {
    minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.5),
    limit: definedNumberOption(opts, 'limit', 20),
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

const handleSimilarChains = reportCommand({
  query: ({ db, opts }) => queries.similarChains(db, {
    minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.5),
    limit: definedNumberOption(opts, 'limit', 15),
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
    limit: definedNumberOption(opts, 'limit', 20),
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

const handleCleanupPlan = budgetedDbCommand('cleanup-plan', ({ db, opts, budget }) => {
  const result = queries.cleanupPlan(db, {
    scope: stringOptionValue(opts, 'scope'),
    minLoc: definedNumberOption(opts, 'minLoc', 1),
    maxDepth: definedNumberOption(opts, 'maxDepth', 5),
    scanLimit: budget.scanLimit,
  });
  if (result.batches.length === 0) {
    return render.empty('Nothing deletable found — no graph-fact dead code to seed a cascade.');
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

  if (booleanOptionValue(opts, 'verify')) {
    console.log('\nVerifying batches against the project checker (throwaway worktree at HEAD)...');
    const verification = verifyCleanupPlan(resolveProjectRoot(), result);
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

const handleRecentDuplicates = budgetedDbCommand('recent-duplicates', ({ db, opts, budget }) => {
  const result = queries.recentDuplicates(db, {
    windowCommits: definedNumberOption(opts, 'window', 100),
    minSimilarity: numberOptionValue(opts, 'minSimilarity') ?? 0.7,
    limit: definedNumberOption(opts, 'limit', 30),
    scope: stringOptionValue(opts, 'scope'),
    scanLimit: budget.scanLimit,
    semantic: budget.semantic,
  });
  if (!result.available) return render.empty('No git history available (not a repository, or git missing).');
  if (result.findings.length === 0) {
    return render.empty(`No recent re-implementations found (window: last ${result.windowCommits} commits).`);
  }
  console.log(`Recent re-implementations (window: last ${result.windowCommits} commits):\n`);
  for (const finding of result.findings) {
    if (finding.kind === 'echo') {
      console.log(`  ${Math.round(finding.similarity * 100)}%  ECHO  ${finding.echoFile}  ${finding.echoSymbol}  (added ${finding.echoAgeCommits} commits ago)`);
      console.log(`        duplicates established  ${finding.establishedFile}  ${finding.establishedSymbol}`);
    } else {
      console.log(`  ${Math.round(finding.similarity * 100)}%  TWIN  ${finding.echoFile}  ${finding.echoSymbol}`);
      console.log(`        and                     ${finding.establishedFile}  ${finding.establishedSymbol}  (both new — consolidate before they diverge)`);
    }
  }
  console.log(`\n${result.findings.length} finding(s). ECHO: prefer extending the established side and deleting the echo.`);
});

const handleDocDrift = dbCommand(({ db, args, opts }) => {
  const result = queries.docDrift(db, {
    doc: args[0] === undefined ? undefined : stringArg(args, 0),
    limit: definedNumberOption(opts, 'limit', 20),
    minCoupling: definedNumberOption(opts, 'minCoupling', 3),
  });
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
    limit: definedNumberOption(opts, 'limit', 30),
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
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('-n, --limit <n>', 'Maximum findings', parseInteger, 30),
      option('--full', 'Run unbounded analysis on large indexes'),
    ],
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
      option('--full', 'Run unbounded analysis on large indexes'),
    ],
    budget: 'candidate-scan',
    renderShape: 'custom',
    docs: doc('Cleanup', ['scip-query cleanup-plan --min-loc 3', 'scip-query cleanup-plan --verify']),
    handler: handleCleanupPlan,
  }),
  cleanupCommand({
    id: 'recent-duplicates',
    command: 'recent-duplicates',
    description: 'Directional duplicate candidates: recent code that re-implements established code',
    options: [
      option('--window <n>', 'How many commits back counts as "recent"', parseInteger, 100),
      option('--min-similarity <n>', 'Minimum similarity (0-1)', parseNumber, 0.7),
      option('-n, --limit <n>', 'Maximum findings', parseInteger, 30),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
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
    options: [
      option('-n, --limit <n>', 'Maximum docs to report', parseInteger, 20),
      option('--min-coupling <n>', 'Minimum historical co-changes to track a subject', parseInteger, 3),
    ],
    heuristic: { label: 'doc drift candidates' },
    renderShape: 'custom',
    docs: doc('Cleanup', ['scip-query doc-drift', 'scip-query doc-drift AGENTS.md']),
    handler: handleDocDrift,
  }),
  cleanupCommand({
    id: 'dead',
    command: 'dead [scope]',
    description: 'Find dead code and file-internal symbols (no cross-file consumers)',
    options: [
      option('--min-loc <n>', 'Only show symbols >= N lines', parseInteger, 1),
      option('--include-tests', 'Include test files'),
      option('--skip-barrels', 'Ignore refs from barrel re-export files'),
      option('--include-members', 'Include class members'),
      option('--only-dead', 'Show only [dead code] symbols (skip [file-internal only])'),
      option('--only-internal', 'Show only [file-internal only] symbols (skip [dead code])'),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    budget: 'candidate-scan',
    renderShape: 'custom',
    docs: doc('Cleanup', ['scip-query dead --min-loc 10']),
    handler: handleDead,
  }),
  cleanupCommand({
    id: 'unused-imports',
    command: 'unused-imports <file>',
    description: 'Find imports not referenced in the same file',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    renderShape: 'list',
    handler: handleUnusedImports,
  }),
  cleanupCommand({
    id: 'isolated',
    command: 'isolated',
    description: 'Find completely orphaned symbols (no references at all)',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-loc <n>', 'Minimum lines of code', parseInteger, 3),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    budget: 'candidate-scan',
    renderShape: 'grouped-by-file',
    handler: handleIsolated,
  }),
  heuristicCleanupCommand({
    id: 'similar',
    command: 'similar [symbol]',
    description: 'Find heuristic function similarity candidates from callee fingerprints',
    options: [
      option('--min-similarity <n>', 'Minimum Jaccard similarity (0-1)', parseNumber, 0.4),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-callees <n>', 'Minimum callees to consider', parseInteger, 4),
      option('--cross-file-only', 'Only show cross-file pairs (skip same-file matches)'),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    heuristicLabel: 'similarity candidates',
    budget: 'candidate-scan',
    renderShape: 'custom',
    handler: handleSimilar,
  }),
  heuristicCleanupCommand({
    id: 'similar-files',
    command: 'similar-files [file]',
    description: 'Find heuristic similar-file candidates from dependency profiles',
    options: [
      option('--min-similarity <n>', 'Minimum Jaccard similarity (0-1)', parseNumber, 0.5),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-deps <n>', 'Minimum dependencies to consider', parseInteger),
    ],
    heuristicLabel: 'similar file candidates',
    renderShape: 'custom',
    handler: handleSimilarFiles,
  }),
  heuristicCleanupCommand({
    id: 'similar-chains',
    command: 'similar-chains',
    description: 'Find heuristic similar-chain candidates from dependency flows',
    options: [
      option('--min-similarity <n>', 'Minimum chain similarity (0-1)', parseNumber, 0.5),
      option('-n, --limit <n>', 'Number of results', parseInteger, 15),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-length <n>', 'Minimum chain length', parseInteger, 3),
      option('--max-length <n>', 'Maximum chain length', parseInteger, 8),
    ],
    heuristicLabel: 'similar chain candidates',
    renderShape: 'custom',
    handler: handleSimilarChains,
  }),
  heuristicCleanupCommand({
    id: 'extract-candidates',
    command: 'extract-candidates',
    description: 'Find heuristic extraction candidates from isolated callee clusters',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-loc <n>', 'Minimum function LOC', parseInteger, 10),
      option('--min-callees <n>', 'Minimum callees to analyze', parseInteger, 6),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    heuristicLabel: 'extraction candidates',
    budget: 'candidate-scan',
    renderShape: 'custom',
    handler: handleExtractCandidates,
  }),
  heuristicCleanupCommand({
    id: 'drift',
    command: 'drift [module]',
    description: 'Detect heuristic drift candidates: unused imports, layer violations, and pattern deviations',
    options: [
      option('--min-deviation <n>', 'Minimum sibling files before reporting unique dependency deviations', parsePositiveInteger, 5),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    heuristicLabel: 'drift candidates',
    budget: 'semantic',
    renderShape: 'grouped-by-file',
    handler: handleDrift,
  }),
  heuristicCleanupCommand({
    id: 'wrapper-candidates',
    command: 'wrapper-candidates',
    description: 'Find heuristic wrapper candidates only called by one consumer',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--max-loc <n>', 'Maximum LOC for candidates', parseInteger, 15),
      option('-n, --limit <n>', 'Number of results', parseInteger, 30),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    heuristicLabel: 'wrapper candidates',
    budget: 'candidate-scan',
    renderShape: 'list',
    handler: handleWrapperCandidates,
  }),
  heuristicCleanupCommand({
    id: 'passthrough-candidates',
    command: 'passthrough-candidates',
    description: 'Find heuristic passthrough candidates that forward to one callee',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--max-loc <n>', 'Maximum LOC for candidates', parseInteger, 15),
      option('-n, --limit <n>', 'Number of results', parseInteger, 30),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    heuristicLabel: 'passthrough candidates',
    budget: 'candidate-scan',
    renderShape: 'list',
    handler: handlePassthroughCandidates,
  }),
  heuristicCleanupCommand({
    id: 'stale-abstractions',
    command: 'stale-abstractions',
    description: 'Find heuristic stale abstraction candidates with 0-1 consumers',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-loc <n>', 'Minimum LOC', parseInteger, 3),
      option('-n, --limit <n>', 'Number of results', parseInteger, 30),
      option('--include-low-confidence', 'Include 1-consumer classes (usually encapsulation, not stale)', undefined, false),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    heuristicLabel: 'stale abstraction candidates',
    budget: 'candidate-scan',
    renderShape: 'list',
    handler: handleStaleAbstractions,
  }),
  heuristicCleanupCommand({
    id: 'complexity-hotspots',
    command: 'complexity-hotspots',
    description: 'Find heuristic complexity hotspot candidates from LOC x fan-in x fan-out',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-loc <n>', 'Minimum LOC', parseInteger, 10),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    heuristicLabel: 'complexity hotspot candidates',
    budget: 'candidate-scan',
    renderShape: 'table',
    handler: handleComplexityHotspots,
  }),
  cleanupCommand({
    id: 'convergence',
    command: 'convergence <symbol1> <symbol2>',
    description: 'Show what a consolidated version of two similar functions would look like',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
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
    ],
    docs: doc('Cleanup'),
    query: ({ db, opts }) => queries.redundantReexports(db, {
      scope: stringOptionValue(opts, 'scope'),
      limit: definedNumberOption(opts, 'limit', 30),
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
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-loc <n>', 'Minimum LOC per function', parseInteger, 3),
      option('-n, --limit <n>', 'Number of groups', parseInteger, 20),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    budget: 'candidate-scan',
    renderShape: 'list',
    handler: handleSimilarSignatures,
  }),
];
