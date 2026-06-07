import { formatBytes } from './cli-context.js';
import { renderHeuristicNotice } from './cli-support.js';
import type { DeadOptions } from '../domain/types.js';
import * as queries from '../queries/index.js';
import type { CommandDescriptor } from './command-descriptor-types.js';
import { doc, option, parseInteger, parseNumber, parsePositiveInteger } from './command-spec-builders.js';
import {
  budgetedDbCommand,
  budgetedGroupedByFileCommand,
  budgetedListCommand,
  budgetedReportCommand,
  budgetedTableCommand,
  booleanOptionValue,
  dbCommand,
  definedNumberOption,
  groupedByFileCommand,
  listCommand,
  numberOptionValue,
  optionalStringArg,
  reportCommand,
  stringArg,
  stringOptionValue,
  tableCommand,
} from './command-execution.js';
import { displayLine, displayPathRange, displayRange, render } from './render.js';

type QueryCommandMetadata = Omit<CommandDescriptor, 'handler' | 'renderShape'>;

function listQueryCommand<Row>({
  query,
  format,
  emptyMessage,
  heuristicLabel,
  after,
  ...metadata
}: QueryCommandMetadata & Parameters<typeof listCommand<Row>>[0]): CommandDescriptor {
  return {
    ...metadata,
    renderShape: 'list',
    handler: listCommand({ query, format, emptyMessage, heuristicLabel, after }),
  };
}

function tableQueryCommand<Row>({
  query,
  format,
  emptyMessage,
  heuristicLabel,
  after,
  headers,
  dashWidths,
  ...metadata
}: QueryCommandMetadata & Parameters<typeof tableCommand<Row>>[0]): CommandDescriptor {
  return {
    ...metadata,
    renderShape: 'table',
    handler: tableCommand({ query, format, emptyMessage, heuristicLabel, after, headers, dashWidths }),
  };
}

function groupedQueryCommand<Row>({
  query,
  format,
  emptyMessage,
  heuristicLabel,
  after,
  key,
  ...metadata
}: QueryCommandMetadata & Parameters<typeof groupedByFileCommand<Row>>[0]): CommandDescriptor {
  return {
    ...metadata,
    renderShape: 'grouped-by-file',
    handler: groupedByFileCommand({ query, format, emptyMessage, heuristicLabel, after, key }),
  };
}

export const handleStats = dbCommand(({ db }) => {
  const s = queries.stats(db);
  console.log(`Documents:   ${s.documents}`);
  console.log(`Symbols:     ${s.symbols}`);
  console.log(`Definitions: ${s.definitions}`);
  console.log(`References:  ${s.references}`);
  console.log(`Index size:  ${formatBytes(s.indexSizeBytes)}`);
  if (s.lastBuilt) {
    console.log(`Last built:  ${s.lastBuilt.toISOString().replace('T', ' ').slice(0, 19)}`);
  }
});

export const handleSystem = dbCommand(({ db, args }) => {
  const result = queries.system(db, stringArg(args, 0));
  render.sectionedReport([
    { title: 'FILES', rows: result.files },
    {
      title: 'EXPORTED SYMBOLS',
      rows: result.symbols.map((s) => `  ${displayRange(s.startLine, s.endLine)}  ${s.shortName}`),
    },
    { title: 'DEPENDS ON (internal)', rows: result.dependsOn.map((d) => `  ${d}`) },
    { title: 'DEPENDED ON BY', rows: result.dependedOnBy.map((d) => `  ${d}`) },
  ]);
});

export const handleTrace = budgetedDbCommand('trace', ({ db, args, budget }) => {
  const result = queries.trace(db, stringArg(args, 0), { semantic: budget.semantic });

  const definitionRows: string[] = [];
  for (const d of result.definitions) {
    const sig = d.signature ? `  — ${d.signature}` : '';
    definitionRows.push(`  ${displayPathRange(d.relativePath, d.startLine, d.endLine)}${sig}`);
    if (d.source) {
      definitionRows.push(d.source
        .split('\n')
        .map((line, index) => `    ${displayLine(d.startLine + index)}  ${line}`)
        .join('\n'));
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

  render.sectionedReport([
    { title: 'DEFINITION', rows: definitionRows },
    { title: 'REFERENCED BY', rows: refRows },
  ]);
});

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

export const handleOutline = dbCommand(({ db, args }) => {
  const roots = queries.outline(db, stringArg(args, 0));
  function printTree(nodes: typeof roots, indent: number): void {
    for (const n of nodes) {
      const prefix = '  '.repeat(indent);
      console.log(`${prefix}${displayRange(n.startLine, n.endLine)}  ${n.shortName}`);
      printTree(n.children, indent + 1);
    }
  }
  printTree(roots, 0);
});

export const handleImports = budgetedListCommand('imports', {
  query: ({ db, args, budget }) => queries.imports(db, stringArg(args, 0), { semantic: budget.semantic }),
  format: (r) => `  ${r.shortName}  ← ${r.fromFile}`,
  emptyMessage: () => 'No imports found (indexer may not emit role=2 for this language).',
});

export const handleUnusedImports = budgetedListCommand('unused-imports', {
  query: ({ db, args, budget }) => queries.unusedImports(db, stringArg(args, 0), { semantic: budget.semantic }),
  format: (r) => `  ${r.shortName}  in ${r.importedIn}`,
  emptyMessage: () => 'No unused imports found.',
  after: (rows) => console.log(`\n${rows.length} unused import(s)`),
});

export const handleBottlenecks = budgetedTableCommand('bottlenecks', {
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

export const handleIsolated = budgetedGroupedByFileCommand('isolated', {
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

export const handleCallGraph = budgetedDbCommand('call-graph', ({ db, args, budget }) => {
  const result = queries.callGraph(db, stringArg(args, 0), { semantic: budget.semantic });
  if (!result) return render.empty('Symbol not found.');
  console.log(`Symbol: ${result.shortName}\n`);
  render.sectionedReport([
    { title: `CALLERS (${result.callers.length})`, rows: result.callers.map((c) => `  ${c.file}  ${c.shortName}`) },
    { title: `CALLEES (${result.callees.length})`, rows: result.callees.map((c) => `  ${c.file}  ${c.shortName}`) },
  ]);
});

export const handleExtractCandidates = budgetedDbCommand('extract-candidates', ({ db, opts, budget }) => {
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

export const handleChangeSurface = budgetedDbCommand('change-surface', ({ db, args, budget }) => {
  const result = queries.changeSurface(db, stringArg(args, 0), { semantic: budget.semantic });
  if (!result) return render.empty('File not found in index.');
  console.log(`File: ${result.file}`);
  console.log(`External consumers: ${result.totalExternalConsumers}\n`);
  render.list(result.symbols, (s) => {
    const risk = s.riskLevel === 'high' ? ' *** HIGH RISK ***' : s.riskLevel === 'medium' ? ' * medium risk *' : '';
    return `  ${displayRange(s.startLine, s.endLine)}  ${s.shortName}  [${s.externalConsumers} consumers]${risk}`;
  });
});

export const handleWrapperCandidates = budgetedListCommand('wrapper-candidates', {
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

export const handlePassthroughCandidates = budgetedListCommand('passthrough-candidates', {
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

export const handleStaleAbstractions = budgetedListCommand('stale-abstractions', {
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

export const handleComplexityHotspots = budgetedTableCommand('complexity-hotspots', {
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

export const handleRefs = budgetedGroupedByFileCommand('refs', {
  query: ({ db, args, budget }) => queries.refs(db, stringArg(args, 0), { semantic: budget.semantic }),
  format: (r) => `  line ${displayLine(r.line)}`,
});

export const handleFanIn = dbCommand(({ db, args, opts }) => {
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

export const handleFanOut = dbCommand(({ db, args, opts }) => {
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

export const handleCoupling = dbCommand(({ db, args, opts }) => {
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

export const handleCycles = reportCommand({
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

export const handleDeepChains = reportCommand({
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

export const handleAffected = dbCommand(({ db, args, opts }) => {
  const results = queries.affected(db, stringArg(args, 0), {
    maxDepth: definedNumberOption(opts, 'maxDepth', 5),
    scope: stringOptionValue(opts, 'scope'),
  });
  if (results.length === 0) return render.empty('No affected symbols found.');
  let prevDepth = -1;
  for (const r of results) {
    if (r.depth !== prevDepth) {
      console.log(`\n  ── Depth ${r.depth} ──`);
      prevDepth = r.depth;
    }
    console.log(`  ${r.file}  ${r.shortName}`);
  }
  console.log(`\n${results.length} affected symbol(s) across ${new Set(results.map((r) => r.file)).size} files.`);
});

export const handleCode = dbCommand(({ db, args, opts }) => {
  const result = queries.code(db, stringArg(args, 0), { context: definedNumberOption(opts, 'context', 0) });
  if (!result) return render.empty('Symbol not found or file unreadable.');
  console.log(`${displayPathRange(result.relativePath, result.startLine, result.endLine)}  ${result.shortName}  [${result.language ?? 'unknown'}]\n`);
  const lines = result.source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    console.log(`  ${String(displayLine(result.startLine + i)).padStart(4)}  ${lines[i]}`);
  }
});

export const handleComplexity = budgetedDbCommand('complexity', ({ db, args, budget }) => {
  const result = queries.complexity(db, stringArg(args, 0), { semantic: budget.semantic });
  if (!result) return render.empty('Symbol not found.');
  console.log(`${displayPathRange(result.relativePath, result.startLine, result.endLine)}  ${result.shortName}\n`);
  console.log(`  LOC:                  ${result.loc}`);
  console.log(`  Branches:             ${result.branches}`);
  console.log(`  Cyclomatic estimate:  ${result.cyclomaticEstimate}`);
  console.log(`  Callees:              ${result.calleeCount}`);
  console.log(`  Fan-in:               ${result.fanIn}`);
  console.log(`  Fan-out:              ${result.fanOut}`);
});

export const handleSimilar = budgetedReportCommand('similar', {
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

export const handleSimilarFiles = reportCommand({
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

export const handleSimilarChains = reportCommand({
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

export const handleDataflow = budgetedDbCommand('dataflow', ({ db, args, budget }) => {
  const result = queries.dataflow(db, stringArg(args, 0), { semantic: budget.semantic });
  if (!result) return render.empty('Symbol not found.');
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

export const handleDrift = budgetedReportCommand('drift', {
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

export const handleConvergence = budgetedReportCommand('convergence', {
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

export const handleSlice = budgetedDbCommand('slice', ({ db, args, opts, budget }) => {
  const direction = booleanOptionValue(opts, 'forward') ? 'forward' : 'backward';
  const result = queries.slice(db, stringArg(args, 0), {
    direction,
    maxDepth: definedNumberOption(opts, 'depth', 3),
    semantic: budget.semantic,
  });
  if (!result) return render.empty('Symbol not found.');
  console.log(`${result.direction} slice of ${result.shortName}\n`);
  if (result.connectedSymbols.length === 0) {
    console.log('  No connected symbols found.');
    return;
  }
  render.list(result.connectedSymbols, (s) => `  ${s.file}  ${s.shortName}\n    ${s.relationship}`);
  console.log(`\n${result.connectedSymbols.length} connected symbol(s).`);
});

export const handleSimilarSignatures = budgetedListCommand('similar-signatures', {
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

export const queryCommandDescriptors: CommandDescriptor[] = [
  {
    id: 'stats',
    command: 'stats',
    description: 'Show index statistics',
    renderShape: 'custom',
    docs: doc('Core'),
    handler: handleStats,
  },
  listQueryCommand({
    id: 'files',
    command: 'files <pattern>',
    description: 'Find files matching a pattern',
    docs: doc('Navigation', ['scip-query files auth']),
    query: ({ db, args }) => queries.files(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  listQueryCommand({
    id: 'symbols',
    command: 'symbols <file>',
    description: 'List symbols defined in a file (with line ranges + signatures)',
    docs: doc('Navigation', ['scip-query symbols src/runtime/cli.ts']),
    query: ({ db, args }) => queries.symbols(db, stringArg(args, 0)),
    format: (r) => {
      const sig = r.signature ? `  — ${r.signature}` : '';
      return `  ${displayRange(r.startLine, r.endLine)}  ${r.shortName}${sig}`;
    },
  }),
  listQueryCommand({
    id: 'methods',
    command: 'methods <className>',
    description: 'List methods of a class (with line ranges)',
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.methods(db, stringArg(args, 0)),
    format: (r) => `  ${displayRange(r.startLine, r.endLine)}  ${r.name}`,
  }),
  {
    id: 'refs',
    command: 'refs <symbol>',
    description: 'Find all files referencing a symbol',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    renderShape: 'grouped-by-file',
    docs: doc('Navigation', ['scip-query refs login']),
    handler: handleRefs,
  },
  {
    id: 'trace',
    command: 'trace <symbol>',
    description: 'Trace a symbol: definition + all references',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    renderShape: 'sectioned-report',
    docs: doc('Navigation', ['scip-query trace parseSymbol']),
    handler: handleTrace,
  },
  listQueryCommand({
    id: 'deps',
    command: 'deps <file>',
    description: 'Files this file depends on (internal)',
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.deps(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  listQueryCommand({
    id: 'rdeps',
    command: 'rdeps <file>',
    description: 'Files that depend on this file/module',
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.rdeps(db, stringArg(args, 0)),
    format: (r) => r.relativePath,
  }),
  {
    id: 'system',
    command: 'system <module>',
    description: 'Full module map: files, symbols, deps in/out',
    renderShape: 'sectioned-report',
    docs: doc('Navigation', ['scip-query system queries']),
    handler: handleSystem,
  },
  listQueryCommand({
    id: 'surface',
    command: 'surface <module>',
    description: 'What symbols consumers actually use from this module',
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.surface(db, stringArg(args, 0)),
    format: (r) => `  ${r.consumer} → ${r.shortName}`,
  }),
  {
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
  },
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
    id: 'imports',
    command: 'imports <file>',
    description: 'What symbols does this file import?',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    renderShape: 'list',
    docs: doc('Navigation'),
    handler: handleImports,
  },
  listQueryCommand({
    id: 'imported-by',
    command: 'imported-by <symbol>',
    description: 'Which files import this symbol?',
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.importedBy(db, stringArg(args, 0)),
    format: (r) => `  ${r.fromFile}`,
  }),
  {
    id: 'unused-imports',
    command: 'unused-imports <file>',
    description: 'Find imports not referenced in the same file',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    renderShape: 'list',
    docs: doc('Cleanup'),
    handler: handleUnusedImports,
  },
  {
    id: 'outline',
    command: 'outline <file>',
    description: 'Tree view of symbols in a file (using nesting hierarchy)',
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleOutline,
  },
  listQueryCommand({
    id: 'members',
    command: 'members <symbol>',
    description: 'All children of a symbol (methods, fields, nested types)',
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.members(db, stringArg(args, 0)),
    format: (r) => `  ${displayRange(r.startLine, r.endLine)}  [${r.kind}]  ${r.shortName}`,
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
    docs: doc('Cleanup'),
    handler: handleIsolated,
  },
  listQueryCommand({
    id: 'by-kind',
    command: 'by-kind <kind>',
    description: 'Find symbols by SCIP kind (class, interface, enum, function, etc.)',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('-n, --limit <n>', 'Number of results', parseInteger, 100),
    ],
    docs: doc('Navigation'),
    query: ({ db, args, opts }) => queries.byKind(db, stringArg(args, 0), {
      scope: stringOptionValue(opts, 'scope'),
      limit: definedNumberOption(opts, 'limit', 100),
    }),
    format: (r) => `  ${displayPathRange(r.relativePath, r.startLine, r.endLine)}  [${r.kindName}]  ${r.shortName}`,
    emptyMessage: ({ args }) => `No symbols found for kind "${stringArg(args, 0)}". Use "kind-counts" to see available kinds.`,
    after: (rows) => console.log(`\n${rows.length} symbol(s)`),
  }),
  tableQueryCommand({
    id: 'kind-counts',
    command: 'kind-counts',
    description: 'Histogram of symbol kinds in the codebase',
    options: [option('-s, --scope <path>', 'Limit to files matching path')],
    docs: doc('Navigation'),
    headers: ['count', 'kind'],
    query: ({ db, opts }) => queries.kindCounts(db, { scope: stringOptionValue(opts, 'scope') }),
    format: (r) => `  ${String(r.count).padStart(5)}  ${r.kindName} (${r.kind})`,
  }),
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
  listQueryCommand({
    id: 'hierarchy',
    command: 'hierarchy <symbol>',
    description: 'Show a symbol\'s ancestry chain (method → class → module)',
    docs: doc('Navigation'),
    query: ({ db, args }) => queries.hierarchy(db, stringArg(args, 0)),
    format: (node) => `${'  '.repeat(node.depth)}${node.shortName}`,
    emptyMessage: () => 'Symbol not found.',
  }),
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
  {
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
    heuristic: { label: 'similarity candidates' },
    budget: 'candidate-scan',
    renderShape: 'custom',
    docs: doc('Cleanup'),
    handler: handleSimilar,
  },
  {
    id: 'similar-files',
    command: 'similar-files [file]',
    description: 'Find heuristic similar-file candidates from dependency profiles',
    options: [
      option('--min-similarity <n>', 'Minimum Jaccard similarity (0-1)', parseNumber, 0.5),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-deps <n>', 'Minimum dependencies to consider', parseInteger),
    ],
    heuristic: { label: 'similar file candidates' },
    renderShape: 'custom',
    docs: doc('Cleanup'),
    handler: handleSimilarFiles,
  },
  {
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
    heuristic: { label: 'similar chain candidates' },
    renderShape: 'custom',
    docs: doc('Cleanup'),
    handler: handleSimilarChains,
  },
  {
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
    heuristic: { label: 'extraction candidates' },
    budget: 'candidate-scan',
    renderShape: 'custom',
    docs: doc('Cleanup'),
    handler: handleExtractCandidates,
  },
  {
    id: 'affected',
    command: 'affected <symbol>',
    description: 'Transitive closure of symbols that could break if this symbol changes',
    options: [
      option('--max-depth <n>', 'Maximum traversal depth', parseInteger, 5),
      option('-s, --scope <path>', 'Limit to files matching path'),
    ],
    renderShape: 'custom',
    docs: doc('Impact'),
    handler: handleAffected,
  },
  {
    id: 'change-surface',
    command: 'change-surface <file>',
    description: 'Pre-change briefing: exports, consumers, and blast-radius risk',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    renderShape: 'list',
    docs: doc('Impact'),
    handler: handleChangeSurface,
  },
  {
    id: 'drift',
    command: 'drift [module]',
    description: 'Detect heuristic drift candidates: unused imports, layer violations, and pattern deviations',
    options: [
      option('--min-deviation <n>', 'Minimum sibling files before reporting unique dependency deviations', parsePositiveInteger, 5),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    heuristic: { label: 'drift candidates' },
    budget: 'semantic',
    renderShape: 'grouped-by-file',
    docs: doc('Cleanup'),
    handler: handleDrift,
  },
  {
    id: 'wrapper-candidates',
    command: 'wrapper-candidates',
    description: 'Find heuristic wrapper candidates only called by one consumer',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--max-loc <n>', 'Maximum LOC for candidates', parseInteger, 15),
      option('-n, --limit <n>', 'Number of results', parseInteger, 30),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    heuristic: { label: 'wrapper candidates' },
    budget: 'candidate-scan',
    renderShape: 'list',
    docs: doc('Cleanup'),
    handler: handleWrapperCandidates,
  },
  {
    id: 'passthrough-candidates',
    command: 'passthrough-candidates',
    description: 'Find heuristic passthrough candidates that forward to one callee',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--max-loc <n>', 'Maximum LOC for candidates', parseInteger, 15),
      option('-n, --limit <n>', 'Number of results', parseInteger, 30),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    heuristic: { label: 'passthrough candidates' },
    budget: 'candidate-scan',
    renderShape: 'list',
    docs: doc('Cleanup'),
    handler: handlePassthroughCandidates,
  },
  {
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
    heuristic: { label: 'stale abstraction candidates' },
    budget: 'candidate-scan',
    renderShape: 'list',
    docs: doc('Cleanup'),
    handler: handleStaleAbstractions,
  },
  {
    id: 'complexity-hotspots',
    command: 'complexity-hotspots',
    description: 'Find heuristic complexity hotspot candidates from LOC x fan-in x fan-out',
    options: [
      option('-s, --scope <path>', 'Limit to files matching path'),
      option('--min-loc <n>', 'Minimum LOC', parseInteger, 10),
      option('-n, --limit <n>', 'Number of results', parseInteger, 20),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    heuristic: { label: 'complexity hotspot candidates' },
    budget: 'candidate-scan',
    renderShape: 'table',
    docs: doc('Cleanup'),
    handler: handleComplexityHotspots,
  },
  {
    id: 'convergence',
    command: 'convergence <symbol1> <symbol2>',
    description: 'Show what a consolidated version of two similar functions would look like',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Cleanup'),
    handler: handleConvergence,
  },
  {
    id: 'code',
    command: 'code <symbol>',
    description: 'Read the source code for a symbol (bounded to its definition range)',
    options: [option('-C, --context <n>', 'Extra lines of context above/below', parseInteger, 0)],
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleCode,
  },
  {
    id: 'complexity',
    command: 'complexity <symbol>',
    description: 'Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Health'),
    handler: handleComplexity,
  },
  {
    id: 'dataflow',
    command: 'dataflow <symbol>',
    description: 'Reference-level dataflow: definition sites, usage sites, producers, consumers',
    options: [option('--full', 'Run unbounded semantic analysis on large indexes')],
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleDataflow,
  },
  {
    id: 'slice',
    command: 'slice <symbol>',
    description: 'Reference-level program slice: what affects this (backward) or what this affects (forward)',
    options: [
      option('--forward', 'Forward slice (what does this affect). Default is backward.'),
      option('--depth <n>', 'Max transitive depth for backward slice', parseInteger, 3),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Navigation'),
    handler: handleSlice,
  },
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
  {
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
    docs: doc('Cleanup'),
    handler: handleSimilarSignatures,
  },
];

const QUERY_COMMANDS_BY_ID = new Map(queryCommandDescriptors.map((descriptor) => [descriptor.id, descriptor]));

export function queryCommandDescriptor(id: string): CommandDescriptor {
  const descriptor = QUERY_COMMANDS_BY_ID.get(id);
  if (!descriptor) throw new Error(`Unknown query command descriptor: ${id}`);
  return descriptor;
}
