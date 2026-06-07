import { existsSync } from 'node:fs';
import type { DeadOptions, SupportedLanguage } from '../domain/types.js';
import { augmentAuxiliaryDocuments, augmentVueResolvedReferences, detectLanguages, reindex } from '../reindex/index.js';
import { getProjectReadiness } from '../reindex/readiness.js';
import { loadProjectConfig, resolveIndexPaths, initProjectConfig } from './config.js';
import { Watcher } from './watch.js';
import { BUILTIN_SKILLS, installSkills, isScipInstalled, printScipInstallInstructions } from './setup.js';
import {
  collect,
  formatBytes,
  formatStatus,
  queries,
  resolveActiveDbPath,
  resolveProjectRoot,
  withDb,
} from './cli-context.js';
import { displayLine, displayPathRange, displayRange, render } from './render.js';
import {
  commandAnalysisBudget,
  renderDiffImpactReport,
  renderHealthReport,
  renderHeuristicNotice,
  runIsolatedDiffImpactReport,
  runIsolatedHealthReport,
} from './cli-support.js';

type Options = Record<string, unknown>;

function options(value: unknown): Options {
  return value && typeof value === 'object' ? value as Options : {};
}

function stringOption(opts: Options, key: string): string | undefined {
  const value = opts[key];
  return typeof value === 'string' ? value : undefined;
}

function numberOption(opts: Options, key: string): number | undefined {
  const value = opts[key];
  return typeof value === 'number' ? value : undefined;
}

function booleanOption(opts: Options, key: string): boolean {
  return Boolean(opts[key]);
}

function stringArrayOption(opts: Options, key: string): string[] {
  const value = opts[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function definedNumber(opts: Options, key: string, fallback: number): number {
  return numberOption(opts, key) ?? fallback;
}

const SUPPORTED_LANGUAGES = new Set<SupportedLanguage>([
  'typescript',
  'javascript',
  'java',
  'scala',
  'kotlin',
  'rust',
  'python',
  'ruby',
  'go',
  'cpp',
  'c',
  'csharp',
  'vb',
  'dart',
  'php',
]);

function supportedLanguages(values: readonly string[]): SupportedLanguage[] {
  return values.filter((value): value is SupportedLanguage => SUPPORTED_LANGUAGES.has(value as SupportedLanguage));
}

export async function handleReindex(rawOpts: unknown): Promise<void> {
  const opts = options(rawOpts);
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexPaths(projectRoot, config);
  try {
    const languages = supportedLanguages(stringArrayOption(opts, 'language'));
    const result = await reindex({
      projectRoot,
      languages: languages.length > 0 ? languages : config.languages,
      outputScip: paths.indexPath,
      outputDb: paths.dbPath,
      pnpmWorkspaces: booleanOption(opts, 'pnpmWorkspaces') || config.indexer?.typescript?.pnpmWorkspaces,
      skipIfUnchanged: !booleanOption(opts, 'force'),
      allowPartial: booleanOption(opts, 'allowPartial'),
      indexerConcurrency: numberOption(opts, 'indexerConcurrency'),
    });
    console.log(`${result.reused ? 'Reused' : 'Indexed'} ${result.languages.join(', ')} in ${(result.durationMs / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function handleAugmentSources(): void {
  const projectRoot = resolveProjectRoot();
  const dbPath = resolveActiveDbPath(projectRoot);
  try {
    const result = augmentAuxiliaryDocuments({
      projectRoot,
      dbPath,
      onStatus: (message) => console.log(message),
    });
    console.log(`Scanned ${result.scanned} auxiliary source files; inserted ${result.inserted}.`);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function handleAugmentVue(rawOpts: unknown): void {
  const opts = options(rawOpts);
  const projectRoot = resolveProjectRoot();
  const dbPath = resolveActiveDbPath(projectRoot);
  try {
    const result = augmentVueResolvedReferences({
      projectRoot,
      dbPath,
      tsconfig: stringOption(opts, 'project') ?? 'frontend/tsconfig.scip.json',
      onStatus: (message) => console.log(message),
    });
    console.log(
      `Vue files: ${result.vueFiles}; resolved references: ${result.resolvedReferences}; inserted mentions: ${result.insertedMentions}.`,
    );
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function handleRefs(symbol: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'refs', booleanOption(opts, 'full'));
    render.groupedByFile(queries.refs(db, String(symbol), { semantic: budget.semantic }), (r) => `  line ${displayLine(r.line)}`);
  });
}

export function handleTrace(symbol: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'trace', booleanOption(opts, 'full'));
    const result = queries.trace(db, String(symbol), { semantic: budget.semantic });

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
}

export function handleDead(scope: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'dead', booleanOption(opts, 'full'));
    const scopeValue = typeof scope === 'string' ? scope : undefined;
    const deadOpts: DeadOptions = {
      scope: scopeValue || undefined,
      minLoc: definedNumber(opts, 'minLoc', 1),
      includeTests: booleanOption(opts, 'includeTests'),
      skipBarrels: booleanOption(opts, 'skipBarrels'),
      includeMembers: booleanOption(opts, 'includeMembers'),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    };

    const result = queries.dead(db, deadOpts);
    const deadCode = result.symbols.filter((s) => s.kind === 'dead-code');
    const fileInternal = result.symbols.filter((s) => s.kind !== 'dead-code');
    const showDead = !booleanOption(opts, 'onlyInternal');
    const showInternal = !booleanOption(opts, 'onlyDead');
    const shownDeadCode = showDead ? deadCode : [];
    const shownFileInternal = showInternal ? fileInternal : [];

    if (shownDeadCode.length === 0 && shownFileInternal.length === 0) {
      return render.empty('No matching dead-code symbols found.');
    }

    const renderGroup = (
      rows: typeof result.symbols,
      title: string,
      explanation: string,
      loc: number,
    ): void => {
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
    };

    const deadLoc = shownDeadCode.reduce((sum, s) => sum + s.loc, 0);
    const fiLoc = shownFileInternal.reduce((sum, s) => sum + s.loc, 0);
    if (shownDeadCode.length > 0) {
      renderGroup(
        shownDeadCode,
        'DEAD CODE',
        '  Zero references anywhere — no cross-file callers AND no same-file uses.\n  Safe to delete.',
        deadLoc,
      );
    }
    if (shownFileInternal.length > 0) {
      if (shownDeadCode.length > 0) console.log('');
      renderGroup(
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
}

export function handleImports(file: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'imports', booleanOption(opts, 'full'));
    const results = queries.imports(db, String(file), { semantic: budget.semantic });
    if (results.length === 0) {
      render.empty('No imports found (indexer may not emit role=2 for this language).');
      return;
    }
    render.list(results, (r) => `  ${r.shortName}  ← ${r.fromFile}`);
  });
}

export function handleUnusedImports(file: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'unused-imports', booleanOption(opts, 'full'));
    const results = queries.unusedImports(db, String(file), { semantic: budget.semantic });
    if (results.length === 0) return render.empty('No unused imports found.');
    render.list(results, (r) => `  ${r.shortName}  in ${r.importedIn}`);
    console.log(`\n${results.length} unused import(s)`);
  });
}

export function handleFanIn(symbol: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    if (typeof symbol === 'string') {
      const results = queries.fanIn(db, symbol);
      if (results.length === 0) return render.empty(`No fan-in for ${symbol}.`);
      render.list(results, (r) => `  ${String(r.count).padStart(4)} files  ${r.name}`);
    } else {
      render.table(
        ['files', 'symbol'],
        queries.topFanIn(db, { limit: definedNumber(opts, 'limit', 30), scope: stringOption(opts, 'scope') }).map(
          (r) => `  ${String(r.count).padStart(5)}  ${r.name}`,
        ),
      );
    }
  });
}

export function handleFanOut(file: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    if (typeof file === 'string') {
      const results = queries.fanOut(db, file);
      if (results.length === 0) return render.empty(`No fan-out for ${file}.`);
      render.list(results, (r) => `  ${String(r.count).padStart(4)} symbols  ${r.name}`);
    } else {
      render.table(
        ['symbols', 'file'],
        queries.topFanOut(db, { limit: definedNumber(opts, 'limit', 30), scope: stringOption(opts, 'scope') }).map(
          (r) => `  ${String(r.count).padStart(7)}  ${r.name}`,
        ),
      );
    }
  });
}

export function handleCoupling(file1: unknown, file2: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    if (typeof file1 === 'string' && typeof file2 === 'string') {
      const result = queries.coupling(db, file1, file2);
      console.log(`${result.file1} ↔ ${result.file2}: ${result.sharedSymbols} shared symbols`);
    } else {
      render.table(
        ['shared', 'file1 → file2'],
        queries.topCoupling(db, { limit: definedNumber(opts, 'limit', 20), scope: stringOption(opts, 'scope') }).map(
          (r) => `  ${String(r.sharedSymbols).padStart(6)}  ${r.file1} → ${r.file2}`,
        ),
      );
    }
  });
}

export function handleCycles(rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const results = queries.cycles(db, { scope: stringOption(opts, 'scope'), maxDepth: definedNumber(opts, 'maxDepth', 10) });
    if (results.length === 0) return render.empty('No circular dependencies found.');
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
  });
}

export function handleBottlenecks(rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'bottlenecks', booleanOption(opts, 'full'));
    const results = queries.bottlenecks(db, {
      limit: definedNumber(opts, 'limit', 20),
      scope: stringOption(opts, 'scope'),
      minFanIn: definedNumber(opts, 'minFanIn', 2),
      minFanOut: definedNumber(opts, 'minFanOut', 2),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    });
    if (results.length === 0) return render.empty('No bottlenecks found.');
    render.table(
      ['score', 'fan-in', 'fan-out', 'symbol'],
      results.map((r) => `  ${String(r.score).padStart(5)}  ${String(r.fanIn).padStart(6)}  ${String(r.fanOut).padStart(7)}  ${r.shortName}`),
    );
  });
}

export function handleIsolated(rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'isolated', booleanOption(opts, 'full'));
    const results = queries.isolated(db, {
      scope: stringOption(opts, 'scope'),
      minLoc: definedNumber(opts, 'minLoc', 3),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    });
    if (results.length === 0) return render.empty('No isolated symbols found.');
    render.groupedByFile(results, (r) => `  ${displayRange(r.startLine, r.endLine)}  (${r.loc} LOC)  ${r.shortName}`);
    console.log(`\n${results.length} isolated symbol(s)`);
  });
}

export function handleDeepChains(rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const results = queries.deepChains(db, {
      limit: definedNumber(opts, 'limit', 10),
      scope: stringOption(opts, 'scope'),
      minDepth: definedNumber(opts, 'minDepth', 3),
    });
    if (results.length === 0) return render.empty('No deep chains found.');
    for (let i = 0; i < results.length; i++) {
      console.log(`\nChain ${i + 1} (depth ${results[i]!.depth}):`);
      for (const file of results[i]!.chain) console.log(`  → ${file}`);
    }
  });
}

export function handleCallGraph(symbol: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'call-graph', booleanOption(opts, 'full'));
    const result = queries.callGraph(db, String(symbol), { semantic: budget.semantic });
    if (!result) return render.empty('Symbol not found.');
    console.log(`Symbol: ${result.shortName}\n`);
    render.sectionedReport([
      { title: `CALLERS (${result.callers.length})`, rows: result.callers.map((c) => `  ${c.file}  ${c.shortName}`) },
      { title: `CALLEES (${result.callees.length})`, rows: result.callees.map((c) => `  ${c.file}  ${c.shortName}`) },
    ]);
  });
}

export function handleSimilar(symbol: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'similar', booleanOption(opts, 'full'));
    if (typeof symbol === 'string') {
      const results = queries.similar(db, symbol, {
        minSimilarity: definedNumber(opts, 'minSimilarity', 0.4),
        limit: definedNumber(opts, 'limit', 20),
        scanLimit: budget.scanLimit,
        semantic: budget.semantic,
      });
      if (results.length === 0) return render.empty('No similar symbols found.');
      renderHeuristicNotice('similarity candidates');
      render.list(results, (r) => {
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
    } else {
      const results = queries.similarAll(db, {
        minSimilarity: definedNumber(opts, 'minSimilarity', 0.4),
        limit: definedNumber(opts, 'limit', 20),
        scope: stringOption(opts, 'scope'),
        minCallees: definedNumber(opts, 'minCallees', 4),
        crossFileOnly: booleanOption(opts, 'crossFileOnly'),
        scanLimit: budget.scanLimit,
        semantic: budget.semantic,
      });
      if (results.length === 0) return render.empty('No similar symbol pairs found.');
      renderHeuristicNotice('similarity candidates');
      render.list(results, (r) =>
        `\n${Math.round(r.similarity * 100)}% similar:\n` +
        `  A: ${r.shortNameA}  (${r.fileA})\n` +
        `  B: ${r.shortNameB}  (${r.fileB})\n` +
        `  Shared ${r.similarityBasis === 'source-tokens' ? 'source tokens' : 'callees'}: ${r.sharedCallees.join(', ')}`,
      );
      console.log(`\n${results.length} similar pair(s) found.`);
    }
  });
}

export function handleSimilarFiles(file: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const results = queries.similarFiles(db, {
      minSimilarity: definedNumber(opts, 'minSimilarity', 0.5),
      limit: definedNumber(opts, 'limit', 20),
      scope: stringOption(opts, 'scope'),
      minDeps: numberOption(opts, 'minDeps'),
      filePattern: typeof file === 'string' ? file : undefined,
    });
    if (results.length === 0) return render.empty('No similar file pairs found.');
    renderHeuristicNotice('similar file candidates');
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
  });
}

export function handleSimilarChains(rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const results = queries.similarChains(db, {
      minSimilarity: definedNumber(opts, 'minSimilarity', 0.5),
      limit: definedNumber(opts, 'limit', 15),
      scope: stringOption(opts, 'scope'),
      minChainLength: definedNumber(opts, 'minLength', 3),
      maxChainLength: definedNumber(opts, 'maxLength', 8),
    });
    if (results.length === 0) return render.empty('No similar chains found.');
    renderHeuristicNotice('similar chain candidates');
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
  });
}

export function handleExtractCandidates(rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'extract-candidates', booleanOption(opts, 'full'));
    const results = queries.extractCandidates(db, {
      scope: stringOption(opts, 'scope'),
      minLoc: definedNumber(opts, 'minLoc', 10),
      minCallees: definedNumber(opts, 'minCallees', 6),
      limit: definedNumber(opts, 'limit', 20),
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
}

export function handleAffected(symbol: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const results = queries.affected(db, String(symbol), { maxDepth: definedNumber(opts, 'maxDepth', 5), scope: stringOption(opts, 'scope') });
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
}

export function handleChangeSurface(file: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'change-surface', booleanOption(opts, 'full'));
    const result = queries.changeSurface(db, String(file), { semantic: budget.semantic });
    if (!result) return render.empty('File not found in index.');
    console.log(`File: ${result.file}`);
    console.log(`External consumers: ${result.totalExternalConsumers}\n`);
    render.list(result.symbols, (s) => {
      const risk = s.riskLevel === 'high' ? ' *** HIGH RISK ***' : s.riskLevel === 'medium' ? ' * medium risk *' : '';
      return `  ${displayRange(s.startLine, s.endLine)}  ${s.shortName}  [${s.externalConsumers} consumers]${risk}`;
    });
  });
}

export function handleDiffImpactBatch(rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const files = JSON.parse(process.env['SCIP_QUERY_DIFF_IMPACT_FILES'] ?? '[]') as string[];
    const plan = queries.diffImpactPlan(db, { base: stringOption(opts, 'base') });
    const result = queries.diffImpactPartial(db, files, plan.changedFiles);
    console.log(JSON.stringify(result));
  });
}

export function handleDiffImpact(rawOpts: unknown): void {
  const opts = options(rawOpts);
  try {
    renderDiffImpactReport(runIsolatedDiffImpactReport({ base: stringOption(opts, 'base') }));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function handleDrift(module: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'drift', booleanOption(opts, 'full'));
    const summary = queries.drift(db, {
      scope: typeof module === 'string' ? module : undefined,
      minDeviation: definedNumber(opts, 'minDeviation', 5),
      semantic: budget.semantic,
    });
    if (summary.results.length === 0) return render.empty('No drift detected.');
    renderHeuristicNotice('drift candidates');
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
  });
}

export function handleWrapperCandidates(rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'wrapper-candidates', booleanOption(opts, 'full'));
    const results = queries.wrapperCandidates(db, {
      scope: stringOption(opts, 'scope'),
      maxLoc: definedNumber(opts, 'maxLoc', 15),
      limit: definedNumber(opts, 'limit', 30),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    });
    if (results.length === 0) return render.empty('No wrapper candidates found.');
    renderHeuristicNotice('wrapper candidates');
    render.list(results, (r) =>
      `  ${displayPathRange(r.file, r.startLine, r.endLine)}  ${r.shortName}  (${r.loc} LOC)\n` +
      `    Only called by: ${r.singleCallerShort}  (fan-in: ${r.callerFanIn})`,
    );
    console.log(`\n${results.length} wrapper candidate(s).`);
  });
}

export function handlePassthroughCandidates(rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'passthrough-candidates', booleanOption(opts, 'full'));
    const results = queries.passthroughCandidates(db, {
      scope: stringOption(opts, 'scope'),
      maxLoc: definedNumber(opts, 'maxLoc', 15),
      limit: definedNumber(opts, 'limit', 30),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    });
    if (results.length === 0) return render.empty('No passthrough candidates found.');
    renderHeuristicNotice('passthrough candidates');
    render.list(results, (r) =>
      `  ${displayPathRange(r.file, r.startLine, r.endLine)}  ${r.shortName}  (${r.loc} LOC)\n` +
      `    Forwards to: ${r.forwardsToShort}  (${r.forwardsToFile})`,
    );
    console.log(`\n${results.length} passthrough candidate(s).`);
  });
}

export function handleStaleAbstractions(rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'stale-abstractions', booleanOption(opts, 'full'));
    const results = queries.staleAbstractions(db, {
      scope: stringOption(opts, 'scope'),
      minLoc: definedNumber(opts, 'minLoc', 3),
      limit: definedNumber(opts, 'limit', 30),
      includeLowConfidence: booleanOption(opts, 'includeLowConfidence'),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    });
    if (results.length === 0) return render.empty('No stale abstractions found.');
    renderHeuristicNotice('stale abstraction candidates');
    render.list(results, (r) => {
      const consumerLabel = r.consumers === 0 ? 'unused' : `${r.consumers} consumer`;
      const barrelLabel = r.barrelConsumers > 0 ? `, +${r.barrelConsumers} barrel` : '';
      return (
        `  [${r.confidence}] ${displayPathRange(r.file, r.startLine, r.endLine)}  ${r.shortName}  (${r.kind}, ${r.loc} LOC, ${consumerLabel}${barrelLabel})\n` +
        `           ${r.reason}`
      );
    });
    console.log(`\n${results.length} stale abstraction(s).`);
  });
}

export function handleComplexityHotspots(rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'complexity-hotspots', booleanOption(opts, 'full'));
    const results = queries.complexityHotspots(db, {
      scope: stringOption(opts, 'scope'),
      minLoc: definedNumber(opts, 'minLoc', 10),
      limit: definedNumber(opts, 'limit', 20),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    });
    if (results.length === 0) return render.empty('No complexity hotspots found.');
    renderHeuristicNotice('complexity hotspot candidates');
    render.table(
      ['score', ' LOC', 'fan-in', 'fan-out', 'callees', 'symbol'],
      results.map((r) => `  ${r.score.toFixed(1).padStart(5)}  ${String(r.loc).padStart(4)}  ${String(r.fanIn).padStart(6)}  ${String(r.fanOut).padStart(7)}  ${String(r.calleeCount).padStart(7)}  ${r.shortName}`),
      [5, 4, 6, 7, 7, 6],
    );
  });
}

export function handleHealthPhase(phase: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    if (!queries.HEALTH_PHASES.includes(phase as typeof queries.HEALTH_PHASES[number])) {
      console.error(`error: Unknown health phase: ${phase}`);
      process.exit(1);
    }
    const result = queries.healthPhase(db, phase as typeof queries.HEALTH_PHASES[number], {
      scope: stringOption(opts, 'scope'),
      full: booleanOption(opts, 'full'),
    });
    console.log(JSON.stringify(result));
  });
}

export function handleHealth(rawOpts: unknown): void {
  const opts = options(rawOpts);
  try {
    const report = runIsolatedHealthReport({
      scope: stringOption(opts, 'scope'),
      full: booleanOption(opts, 'full'),
      json: booleanOption(opts, 'json'),
    });
    renderHealthReport(report, booleanOption(opts, 'json'));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function handleConvergence(symbol1: unknown, symbol2: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'convergence', booleanOption(opts, 'full'));
    const result = queries.convergence(db, String(symbol1), String(symbol2), { semantic: budget.semantic });
    if (!result) return render.empty('One or both symbols not found.');
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
  });
}

export function handleCode(symbol: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const result = queries.code(db, String(symbol), { context: definedNumber(opts, 'context', 0) });
    if (!result) return render.empty('Symbol not found or file unreadable.');
    console.log(`${displayPathRange(result.relativePath, result.startLine, result.endLine)}  ${result.shortName}  [${result.language ?? 'unknown'}]\n`);
    const lines = result.source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      console.log(`  ${String(displayLine(result.startLine + i)).padStart(4)}  ${lines[i]}`);
    }
  });
}

export function handleComplexity(symbol: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'complexity', booleanOption(opts, 'full'));
    const result = queries.complexity(db, String(symbol), { semantic: budget.semantic });
    if (!result) return render.empty('Symbol not found.');
    console.log(`${displayPathRange(result.relativePath, result.startLine, result.endLine)}  ${result.shortName}\n`);
    console.log(`  LOC:                  ${result.loc}`);
    console.log(`  Branches:             ${result.branches}`);
    console.log(`  Cyclomatic estimate:  ${result.cyclomaticEstimate}`);
    console.log(`  Callees:              ${result.calleeCount}`);
    console.log(`  Fan-in:               ${result.fanIn}`);
    console.log(`  Fan-out:              ${result.fanOut}`);
  });
}

export function handleDataflow(symbol: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'dataflow', booleanOption(opts, 'full'));
    const result = queries.dataflow(db, String(symbol), { semantic: budget.semantic });
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
}

export function handleSlice(symbol: unknown, rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const direction = booleanOption(opts, 'forward') ? 'forward' : 'backward';
    const budget = commandAnalysisBudget(db, 'slice', booleanOption(opts, 'full'));
    const result = queries.slice(db, String(symbol), {
      direction,
      maxDepth: definedNumber(opts, 'depth', 3),
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
}

export function handleInstallSkills(): void {
  const result = installSkills();
  const total = result.installed.length + result.alreadyLinked.length;
  console.log(`\n${result.installed.length} installed, ${result.alreadyLinked.length} already linked, ${result.skipped.length} skipped.`);
  if (total > 0) {
    console.log('Skills will be available in your next Claude Code / Codex session.');
  }
}

export function handleCheckDeps(): void {
  let hasProblems = false;
  if (isScipInstalled()) {
    console.log('scip CLI: installed');
  } else {
    printScipInstallInstructions();
    hasProblems = true;
  }

  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const readiness = getProjectReadiness(projectRoot, config);
  if (readiness.languages.length === 0) {
    console.log('\nNo supported project languages detected in the current directory.');
    process.exitCode = hasProblems ? 1 : 0;
    return;
  }

  console.log(`\nDetected languages: ${readiness.languages.join(', ')}`);
  console.log('\nIndexer readiness:');
  for (const status of readiness.indexers) {
    const prefix = status.runnable ? '  OK' : status.installed ? '  WARN' : '  MISSING';
    const resolved = status.resolvedBinary ? ` (${status.resolvedBinary})` : '';
    console.log(`${prefix} ${status.language}: ${status.binaryLabel}${resolved}`);
    if (status.note) console.log(`    ${status.note}`);
    if (!status.installed && status.installUrl) console.log(`    install: ${status.installUrl}`);
    if (!status.runnable) hasProblems = true;
  }

  if (readiness.semantic) {
    const status = readiness.semantic;
    const prefix = status.available ? '  OK' : status.dependencyAvailable ? '  WARN' : '  MISSING';
    const configPath = status.tsconfigPaths && status.tsconfigPaths.length > 1
      ? ` (${status.tsconfigPaths.length} tsconfigs)`
      : status.tsconfigPath ? ` (${status.tsconfigPath})` : '';
    console.log('\nSemantic provider readiness:');
    console.log(`${prefix} typescript: ts-morph${configPath}`);
    if (status.reason) console.log(`    ${status.reason}; semantic checks will fall back to SCIP/source evidence`);
  }

  process.exitCode = hasProblems ? 1 : 0;
}

export function handleRedundantReexports(rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const results = queries.redundantReexports(db, { scope: stringOption(opts, 'scope'), limit: definedNumber(opts, 'limit', 30) });
    if (results.length === 0) return render.empty('No redundant re-exports found.');
    render.groupedByFile(
      results,
      (r) =>
        `  ${r.shortName}  (from ${r.originalFile})\n` +
        `    barrel: ${r.barrelConsumers} consumer(s) | direct: ${r.directConsumers} consumer(s)`,
      (r) => r.barrelFile,
    );
    console.log(`\n${results.length} redundant re-export(s).`);
  });
}

export function handleSimilarSignatures(rawOpts: unknown): void {
  const opts = options(rawOpts);
  withDb((db) => {
    const budget = commandAnalysisBudget(db, 'similar-signatures', booleanOption(opts, 'full'));
    const groups = queries.similarSignatures(db, {
      scope: stringOption(opts, 'scope'),
      minLoc: definedNumber(opts, 'minLoc', 3),
      limit: definedNumber(opts, 'limit', 20),
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    });
    if (groups.length === 0) return render.empty('No same-shape function groups found.');
    render.list(groups, (g) => {
      const head = `\nSignature: ${g.signature}  (${g.functions.length} functions)`;
      const body = g.functions
        .map((f) => `  ${displayPathRange(f.file, f.startLine, f.endLine)}  ${f.shortName}  (${f.loc} LOC)`)
        .join('\n');
      return `${head}\n${body}`;
    });
    console.log(`\n${groups.length} group(s) found.`);
  });
}

export function handleInit(): void {
  const projectRoot = resolveProjectRoot();
  const languages = detectLanguages(projectRoot);
  const configPath = initProjectConfig(projectRoot, languages);
  console.log(`Config written to ${configPath}`);
  console.log(`Detected languages: ${languages.join(', ') || '(none)'}`);
}

export function handleWatch(rawOpts: unknown): void {
  const opts = options(rawOpts);
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const debounce = numberOption(opts, 'debounce');
  const cooldown = numberOption(opts, 'cooldown');
  if (debounce) (config.watch ??= {}).debounceMs = debounce;
  if (cooldown) (config.watch ??= {}).cooldownMs = cooldown;

  const watcher = new Watcher({
    projectRoot,
    config,
    languages: config.languages,
    onStatus: (status) => {
      process.stdout.write(`\r\x1b[K${formatStatus(status)}`);
    },
    onReindexComplete: (durationMs) => {
      console.log(`\nReindex complete in ${(durationMs / 1000).toFixed(1)}s`);
    },
    onError: (err) => {
      console.error(`\nWatch error: ${err.message}`);
    },
  });

  console.log(`Watching ${projectRoot}`);
  console.log(`Debounce: ${config.watch?.debounceMs ?? 30000}ms | Cooldown: ${config.watch?.cooldownMs ?? 60000}ms`);
  console.log('Press Ctrl+C to stop.\n');
  watcher.start();

  process.on('SIGINT', () => {
    watcher.stop();
    console.log('\nStopped.');
    process.exit(0);
  });
}

export function handleStatus(): void {
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexPaths(projectRoot, config);
  const dbPath = resolveActiveDbPath(projectRoot);
  const readiness = getProjectReadiness(projectRoot, config);

  console.log(`Project:  ${projectRoot}`);
  console.log(`DB path:  ${dbPath}`);
  if (dbPath !== paths.dbPath) {
    console.log(`Config:   ${paths.dbPath} (fallback to project root index.db)`);
  }
  if (readiness.semantic) {
    const semanticState = readiness.semantic.available ? 'available' : 'fallback';
    const suffix = readiness.semantic.tsconfigPaths && readiness.semantic.tsconfigPaths.length > 1
      ? ` (${readiness.semantic.tsconfigPaths.length} tsconfigs)`
      : readiness.semantic.tsconfigPath ? ` (${readiness.semantic.tsconfigPath})` : '';
    console.log(`TS sem:   ${semanticState}${suffix}`);
    if (readiness.semantic.reason) console.log(`TS note:  ${readiness.semantic.reason}`);
  }
  console.log(`Exists:   ${existsSync(dbPath) ? 'yes' : 'no'}`);

  if (existsSync(dbPath)) {
    withDb((db) => {
      const s = queries.stats(db);
      console.log(`Symbols:  ${s.symbols}`);
      console.log(`Files:    ${s.documents}`);
      console.log(`Size:     ${formatBytes(s.indexSizeBytes)}`);
      if (s.lastBuilt) {
        const ago = Math.round((Date.now() - s.lastBuilt.getTime()) / 1000);
        console.log(`Built:    ${ago}s ago`);
      }
    });
  }
}

export { collect };
