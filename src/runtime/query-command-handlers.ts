import { formatBytes, queries } from './cli-context.js';
import { renderHeuristicNotice } from './cli-support.js';
import {
  budgetedDbCommand,
  budgetedGroupedByFileCommand,
  budgetedListCommand,
  budgetedTableCommand,
  booleanOptionValue,
  dbCommand,
  definedNumberOption,
  groupedByFileCommand,
  listCommand,
  optionalStringArg,
  stringArg,
  stringOptionValue,
  tableCommand,
} from './command-execution.js';
import { displayLine, displayPathRange, displayRange, render } from './render.js';

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

export const handleFiles = listCommand({
  query: ({ db, args }) => queries.files(db, stringArg(args, 0)),
  format: (r) => r.relativePath,
});

export const handleSymbols = listCommand({
  query: ({ db, args }) => queries.symbols(db, stringArg(args, 0)),
  format: (r) => {
    const sig = r.signature ? `  — ${r.signature}` : '';
    return `  ${displayRange(r.startLine, r.endLine)}  ${r.shortName}${sig}`;
  },
});

export const handleMethods = listCommand({
  query: ({ db, args }) => queries.methods(db, stringArg(args, 0)),
  format: (r) => `  ${displayRange(r.startLine, r.endLine)}  ${r.name}`,
});

export const handleDeps = listCommand({
  query: ({ db, args }) => queries.deps(db, stringArg(args, 0)),
  format: (r) => r.relativePath,
});

export const handleRdeps = listCommand({
  query: ({ db, args }) => queries.rdeps(db, stringArg(args, 0)),
  format: (r) => r.relativePath,
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

export const handleSurface = listCommand({
  query: ({ db, args }) => queries.surface(db, stringArg(args, 0)),
  format: (r) => `  ${r.consumer} → ${r.shortName}`,
});

export const handleHotspots = tableCommand({
  headers: ['refs', 'files', 'symbol'],
  query: ({ db, opts }) => queries.hotspots(db, {
    limit: definedNumberOption(opts, 'limit', 30),
    scope: stringOptionValue(opts, 'scope'),
  }),
  format: (r) => `  ${String(r.refCount).padStart(4)}  ${String(r.fileCount).padStart(5)}  ${r.shortName}`,
});

export const handleImportedBy = listCommand({
  query: ({ db, args }) => queries.importedBy(db, stringArg(args, 0)),
  format: (r) => `  ${r.fromFile}`,
});

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

export const handleMembers = listCommand({
  query: ({ db, args }) => queries.members(db, stringArg(args, 0)),
  format: (r) => `  ${displayRange(r.startLine, r.endLine)}  [${r.kind}]  ${r.shortName}`,
});

export const handleByKind = listCommand({
  query: ({ db, args, opts }) => queries.byKind(db, stringArg(args, 0), {
    scope: stringOptionValue(opts, 'scope'),
    limit: definedNumberOption(opts, 'limit', 100),
  }),
  format: (r) => `  ${displayPathRange(r.relativePath, r.startLine, r.endLine)}  [${r.kindName}]  ${r.shortName}`,
  emptyMessage: ({ args }) => `No symbols found for kind "${stringArg(args, 0)}". Use "kind-counts" to see available kinds.`,
  after: (rows) => console.log(`\n${rows.length} symbol(s)`),
});

export const handleKindCounts = tableCommand({
  headers: ['count', 'kind'],
  query: ({ db, opts }) => queries.kindCounts(db, { scope: stringOptionValue(opts, 'scope') }),
  format: (r) => `  ${String(r.count).padStart(5)}  ${r.kindName} (${r.kind})`,
});

export const handleHierarchy = listCommand({
  query: ({ db, args }) => queries.hierarchy(db, stringArg(args, 0)),
  format: (node) => `${'  '.repeat(node.depth)}${node.shortName}`,
  emptyMessage: () => 'Symbol not found.',
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

export const handleRedundantReexports = groupedByFileCommand({
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
