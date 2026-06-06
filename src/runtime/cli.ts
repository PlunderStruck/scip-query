import { program } from 'commander';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig, resolveIndexPaths, initProjectConfig } from './config.js';
import { reindex, detectLanguages, augmentAuxiliaryDocuments, augmentVueResolvedReferences } from '../reindex/index.js';
import { getIndexerConfig } from '../reindex/indexers.js';
import { getIndexerDependencyStatus } from '../reindex/install.js';
import { getTypeScriptSemanticStatus } from '../semantic/typescript/status.js';
import { Watcher } from './watch.js';
import type { DeadOptions } from '../domain/types.js';
import type { ScipDatabase } from '../storage/db.js';
import { BUILTIN_SKILLS, installSkills, isScipInstalled, printScipInstallInstructions } from './setup.js';
import { displayLine, displayPathRange, displayRange, render } from './render.js';
import {
  collect,
  formatBytes,
  formatStatus,
  parseIntSafe,
  parsePositiveInt,
  queries,
  resolveActiveDbPath,
  resolveProjectRoot,
  withDb,
} from './cli-context.js';

const require = createRequire(import.meta.url);
const { version: cliVersion } = loadCliPackageInfo();
const HEALTH_PHASE_COMMAND = '__health-phase';
const DIFF_IMPACT_BATCH_COMMAND = '__diff-impact-batch';
const DIFF_IMPACT_BATCH_SIZE = 10;
const LARGE_COMMAND_SYMBOL_THRESHOLD = 75_000;
const LARGE_COMMAND_DOCUMENT_THRESHOLD = 5_000;
const DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT = 2_500;

function loadCliPackageInfo(): { version: string } {
  for (const path of ['../package.json', '../../package.json']) {
    try {
      return require(path) as { version: string };
    } catch {
      // Source runs from src/runtime; bundled CLI runs from dist.
    }
  }
  return { version: '0.0.0' };
}

type HealthReport = ReturnType<typeof queries.health>;
type HealthPhaseName = typeof queries.HEALTH_PHASES[number];
type HealthPhaseResult = ReturnType<typeof queries.healthPhase>;
type DiffImpactResult = ReturnType<typeof queries.diffImpact>;
type DiffImpactPartial = ReturnType<typeof queries.diffImpactPartial>;

interface HealthCliOptions {
  scope?: string;
  full?: boolean;
  json?: boolean;
}

interface DiffImpactCliOptions {
  base?: string;
}

export function renderHeuristicNotice(label: string): void {
  console.log(`Heuristic ${label}: review before acting; these are candidates, not exact compiler facts.\n`);
}

interface CommandAnalysisBudget {
  scanLimit?: number;
  semantic: boolean;
}

function commandAnalysisBudget(
  db: ScipDatabase,
  commandName: string,
  full: boolean | undefined,
): CommandAnalysisBudget {
  const statsResult = queries.stats(db);
  const isLargeIndex = statsResult.symbols >= LARGE_COMMAND_SYMBOL_THRESHOLD
    || statsResult.documents >= LARGE_COMMAND_DOCUMENT_THRESHOLD;

  if (!isLargeIndex) return { semantic: true };

  if (full) {
    console.error(`Large index detected; ${commandName} is running the unbounded semantic pass because --full was supplied.`);
    return { semantic: true };
  }

  console.error(
    `Large index detected; ${commandName} will scan the highest-priority ${DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT} candidates with semantic enrichment disabled. ` +
    `Run "scip-query ${commandName} --full" for the unbounded semantic pass.`,
  );
  return { scanLimit: DEFAULT_COMMAND_CANDIDATE_SCAN_LIMIT, semantic: false };
}

function runIsolatedHealthReport(opts: HealthCliOptions): HealthReport {
  const phaseResults = queries.HEALTH_PHASES.map((phase) => runHealthPhaseProcess(phase, opts));
  return queries.healthReportFromPhases(phaseResults);
}

function runHealthPhaseProcess(phase: HealthPhaseName, opts: HealthCliOptions): HealthPhaseResult {
  const cliPath = process.argv[1] ?? fileURLToPath(import.meta.url);
  const args = [...process.execArgv, cliPath, HEALTH_PHASE_COMMAND, phase];
  if (opts.scope) args.push('--scope', opts.scope);
  if (opts.full) args.push('--full');

  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`Health phase "${phase}" failed${stderr ? `:\n${stderr}` : ''}`);
  }
  return JSON.parse(result.stdout) as HealthPhaseResult;
}

function renderHealthReport(report: HealthReport, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`\n  Codebase Health Score: ${report.score}/100\n`);
  console.log(`  ${report.overview.documents} files | ${report.overview.symbols} symbols | ${formatBytes(report.overview.indexSizeBytes)}\n`);

  if (report.warnings && report.warnings.length > 0) {
    console.log('  Warnings:');
    for (const warning of report.warnings) {
      console.log(`    ${warning}`);
    }
    console.log('');
  }

  console.log('  Findings:');
  const f = report.findings;
  if (f.deadSymbols > 0) console.log(`    Dead code:            ${f.deadSymbols} symbols (${f.deadLoc} LOC)`);
  if (f.isolatedSymbols > 0) console.log(`    Isolated symbols:     ${f.isolatedSymbols} (${f.isolatedLoc} LOC)`);
  if (f.cycles > 0) console.log(`    Circular deps:        ${f.cycles}`);
  if (f.similarPairs > 0) console.log(`    Similar pairs:        ${f.similarPairs}`);
  if (f.extractionCandidates > 0) console.log(`    Extract candidates:   ${f.extractionCandidates}`);
  if (f.wrappers > 0) console.log(`    Wrapper functions:    ${f.wrappers}`);
  if (f.passthroughs > 0) console.log(`    Passthroughs:         ${f.passthroughs}`);
  if (f.staleTypes > 0) console.log(`    Stale abstractions:   ${f.staleTypes}`);
  if (f.driftedFiles > 0) console.log(`    Pattern drift:        ${f.driftedFiles} files`);
  if (f.complexityHotspotCount > 0) console.log(`    Complexity hotspots:  ${f.complexityHotspotCount}`);

  if (report.actions.length > 0) {
    console.log('\n  Prioritized Actions (highest impact + lowest effort first):');
    for (let i = 0; i < report.actions.length; i++) {
      const a = report.actions[i]!;
      const loc = a.locRecoverable > 0 ? ` (~${a.locRecoverable} LOC recoverable)` : '';
      console.log(`    ${i + 1}. [${a.effort} effort / ${a.impact} impact] ${a.description}${loc}`);
    }
  }

  if (report.topComplexity.length > 0) {
    console.log('\n  Top Complexity Hotspots:');
    for (const c of report.topComplexity) {
      console.log(`    ${c.score.toFixed(1).padStart(6)}  ${c.symbol}`);
    }
  }

  if (report.actions.length === 0) {
    console.log('\n  No issues found. Codebase is clean.');
  }
}

function runIsolatedDiffImpactReport(opts: DiffImpactCliOptions): DiffImpactResult {
  return withDb((db) => {
    const plan = queries.diffImpactPlan(db, { base: opts.base });
    if (plan.note) {
      return queries.diffImpact(db, { base: opts.base });
    }
    if (plan.changedFiles.length === 0) {
      return queries.diffImpact(db, { base: opts.base });
    }

    const partials: DiffImpactPartial[] = [];
    for (const batch of chunked(plan.changedFiles, DIFF_IMPACT_BATCH_SIZE)) {
      partials.push(runDiffImpactBatchProcess(batch, opts));
    }
    return queries.mergeDiffImpactPartials(plan.changedFiles, partials);
  });
}

function runDiffImpactBatchProcess(files: readonly string[], opts: DiffImpactCliOptions): DiffImpactPartial {
  const cliPath = process.argv[1] ?? fileURLToPath(import.meta.url);
  const args = [...process.execArgv, cliPath, DIFF_IMPACT_BATCH_COMMAND];
  if (opts.base) args.push('--base', opts.base);
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SCIP_QUERY_DIFF_IMPACT_FILES: JSON.stringify(files),
    },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`Diff-impact batch failed${stderr ? `:\n${stderr}` : ''}`);
  }
  return JSON.parse(result.stdout) as DiffImpactPartial;
}

function renderDiffImpactReport(result: DiffImpactResult): void {
  console.log(`Changed files: ${result.summary.totalChangedFiles}`);
  console.log(`Changed symbols: ${result.summary.totalChangedSymbols}`);
  console.log(`Affected consumer files: ${result.summary.totalAffectedFiles}`);
  if (result.summary.note) {
    console.log(`Note: ${result.summary.note}`);
  }
  console.log('');
  if (result.changedSymbols.length > 0) {
    console.log('Changed symbols:');
    render.list(result.changedSymbols, (s) => `  ${s.file}  ${s.shortName}  (fan-in: ${s.fanIn})`);
  }
  if (result.affectedConsumers.length > 0) {
    console.log('\nAffected consumer files:');
    render.list(result.affectedConsumers, (c) => `  ${c.file}  (${c.consumedSymbols} symbol(s))`);
  }
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push(items.slice(offset, offset + size));
  }
  return chunks;
}

// ── CLI Definition ─────────────────────────────────────────

program
  .name('scip-query')
  .description('Language-agnostic code intelligence CLI powered by SCIP indexes')
  .version(cliVersion);

// reindex
program
  .command('reindex')
  .description('Index the codebase and convert to SQLite')
  .option('-l, --language <lang>', 'Index only this language (can be repeated)', collect, [])
  .option('--pnpm-workspaces', 'Enable pnpm workspace support (TypeScript)')
  .option('--force', 'Rebuild even if source inputs are unchanged')
  .option('--allow-partial', 'Write an incomplete index when one or more detected languages fail')
  .option('--indexer-concurrency <n>', 'Number of language indexers to run at once', parsePositiveInt)
  .action(async (opts) => {
    const projectRoot = resolveProjectRoot();
    const config = loadProjectConfig(projectRoot);
    const paths = resolveIndexPaths(projectRoot, config);
    try {
      const result = await reindex({
        projectRoot,
        languages: opts.language.length > 0 ? opts.language : config.languages,
        outputScip: paths.indexPath,
        outputDb: paths.dbPath,
        pnpmWorkspaces: opts.pnpmWorkspaces || config.indexer?.typescript?.pnpmWorkspaces,
        skipIfUnchanged: !opts.force,
        allowPartial: opts.allowPartial,
        indexerConcurrency: opts.indexerConcurrency,
      });
      console.log(`${result.reused ? 'Reused' : 'Indexed'} ${result.languages.join(', ')} in ${(result.durationMs / 1000).toFixed(1)}s`);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command('augment-sources')
  .description('Add source files skipped by upstream SCIP indexers to the SQLite documents table')
  .action(() => {
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
  });

program
  .command('augment-vue')
  .description('Add compiler-resolved Vue SFC references to the SQLite index using Volar')
  .option('--project <tsconfig>', 'Vue tsconfig path', 'frontend/tsconfig.scip.json')
  .action((opts) => {
    const projectRoot = resolveProjectRoot();
    const dbPath = resolveActiveDbPath(projectRoot);
    try {
      const result = augmentVueResolvedReferences({
        projectRoot,
        dbPath,
        tsconfig: opts.project,
        onStatus: (message) => console.log(message),
      });
      console.log(
        `Vue files: ${result.vueFiles}; resolved references: ${result.resolvedReferences}; inserted mentions: ${result.insertedMentions}.`,
      );
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// stats — kept inline: fixed key/value layout, not a list/table.
program
  .command('stats')
  .description('Show index statistics')
  .action(() => withDb((db) => {
    const s = queries.stats(db);
    console.log(`Documents:   ${s.documents}`);
    console.log(`Symbols:     ${s.symbols}`);
    console.log(`Definitions: ${s.definitions}`);
    console.log(`References:  ${s.references}`);
    console.log(`Index size:  ${formatBytes(s.indexSizeBytes)}`);
    if (s.lastBuilt) {
      console.log(`Last built:  ${s.lastBuilt.toISOString().replace('T', ' ').slice(0, 19)}`);
    }
  }));

// files
program
  .command('files <pattern>')
  .description('Find files matching a pattern')
  .action((pattern) => withDb((db) => {
    render.list(queries.files(db, pattern), (r) => r.relativePath);
  }));

// symbols
program
  .command('symbols <file>')
  .description('List symbols defined in a file (with line ranges + signatures)')
  .action((file) => withDb((db) => {
    render.list(queries.symbols(db, file), (r) => {
      const sig = r.signature ? `  — ${r.signature}` : '';
      return `  ${displayRange(r.startLine, r.endLine)}  ${r.shortName}${sig}`;
    });
  }));

// methods
program
  .command('methods <className>')
  .description('List methods of a class (with line ranges)')
  .action((className) => withDb((db) => {
    render.list(
      queries.methods(db, className),
      (r) => `  ${displayRange(r.startLine, r.endLine)}  ${r.name}`,
    );
  }));

// refs
program
  .command('refs <symbol>')
  .description('Find all files referencing a symbol')
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((symbol, opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'refs', Boolean(opts.full));
    render.groupedByFile(queries.refs(db, symbol, { semantic: budget.semantic }), (r) => `  line ${displayLine(r.line)}`);
  }));

// trace
program
  .command('trace <symbol>')
  .description('Trace a symbol: definition + all references')
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((symbol, opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'trace', Boolean(opts.full));
    const result = queries.trace(db, symbol, { semantic: budget.semantic });

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

    // Build "REFERENCED BY" rows: groupedByFile but with 2-space file
    // header indent and 4-space line indent.
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
  }));

// deps
program
  .command('deps <file>')
  .description('Files this file depends on (internal)')
  .action((file) => withDb((db) => {
    render.list(queries.deps(db, file), (r) => r.relativePath);
  }));

// rdeps
program
  .command('rdeps <file>')
  .description('Files that depend on this file/module')
  .action((file) => withDb((db) => {
    render.list(queries.rdeps(db, file), (r) => r.relativePath);
  }));

// system
program
  .command('system <module>')
  .description('Full module map: files, symbols, deps in/out')
  .action((module) => withDb((db) => {
    const result = queries.system(db, module);
    render.sectionedReport([
      { title: 'FILES', rows: result.files },
      {
        title: 'EXPORTED SYMBOLS',
        rows: result.symbols.map((s) => `  ${displayRange(s.startLine, s.endLine)}  ${s.shortName}`),
      },
      { title: 'DEPENDS ON (internal)', rows: result.dependsOn.map((d) => `  ${d}`) },
      { title: 'DEPENDED ON BY', rows: result.dependedOnBy.map((d) => `  ${d}`) },
    ]);
  }));

// surface
program
  .command('surface <module>')
  .description('What symbols consumers actually use from this module')
  .action((module) => withDb((db) => {
    render.list(queries.surface(db, module), (r) => `  ${r.consumer} → ${r.shortName}`);
  }));

// dead
program
  .command('dead [scope]')
  .description('Find dead code and file-internal symbols (no cross-file consumers)')
  .option('--min-loc <n>', 'Only show symbols >= N lines', parseIntSafe, 1)
  .option('--include-tests', 'Include test files')
  .option('--skip-barrels', 'Ignore refs from barrel re-export files')
  .option('--include-members', 'Include class members')
  .option('--only-dead', 'Show only [dead code] symbols (skip [file-internal only])')
  .option('--only-internal', 'Show only [file-internal only] symbols (skip [dead code])')
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  // dead — kept inline: section title carries derived counts (`(N, M LOC)`),
  // bodies sort files by per-file total LOC, and a hand-formatted footer
  // sums across both groups. None of those fit a registry shape cleanly.
  .action((scope, opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'dead', Boolean(opts.full));
    const deadOpts: DeadOptions = {
      scope: scope || undefined,
      minLoc: opts.minLoc,
      includeTests: opts.includeTests,
      skipBarrels: opts.skipBarrels,
      includeMembers: opts.includeMembers,
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    };

    const result = queries.dead(db, deadOpts);

    const deadCode = result.symbols.filter((s) => s.kind === 'dead-code');
    const fileInternal = result.symbols.filter((s) => s.kind !== 'dead-code');
    const showDead = !opts.onlyInternal;
    const showInternal = !opts.onlyDead;
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
      // Group by file, sort files by total LOC desc so the worst-offender
      // files surface first. Within a file, keep symbols in source order.
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
    console.log(
      `Total: ${shownDeadCode.length + shownFileInternal.length} symbols — ${totalParts.join(' + ')}`,
    );
  }));

// hotspots
program
  .command('hotspots')
  .description('Most-referenced symbols in the codebase (choke points)')
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 30)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((opts) => withDb((db) => {
    const results = queries.hotspots(db, { limit: opts.limit, scope: opts.scope });
    render.table(
      ['refs', 'files', 'symbol'],
      results.map((r) =>
        `  ${String(r.refCount).padStart(4)}  ${String(r.fileCount).padStart(5)}  ${r.shortName}`,
      ),
    );
  }));

// imports
program
  .command('imports <file>')
  .description('What symbols does this file import?')
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((file, opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'imports', Boolean(opts.full));
    const results = queries.imports(db, file, { semantic: budget.semantic });
    if (results.length === 0) {
      render.empty('No imports found (indexer may not emit role=2 for this language).');
      return;
    }
    render.list(results, (r) => `  ${r.shortName}  ← ${r.fromFile}`);
  }));

// imported-by
program
  .command('imported-by <symbol>')
  .description('Which files import this symbol?')
  .action((symbol) => withDb((db) => {
    render.list(queries.importedBy(db, symbol), (r) => `  ${r.fromFile}`);
  }));

// unused-imports
program
  .command('unused-imports <file>')
  .description('Find imports not referenced in the same file')
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((file, opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'unused-imports', Boolean(opts.full));
    const results = queries.unusedImports(db, file, { semantic: budget.semantic });
    if (results.length === 0) return render.empty('No unused imports found.');
    render.list(results, (r) => `  ${r.shortName}  in ${r.importedIn}`);
    console.log(`\n${results.length} unused import(s)`);
  }));

// outline — kept inline: recursive tree walk doesn't fit a flat list shape.
program
  .command('outline <file>')
  .description('Tree view of symbols in a file (using nesting hierarchy)')
  .action((file) => withDb((db) => {
    const roots = queries.outline(db, file);
    function printTree(nodes: typeof roots, indent: number): void {
      for (const n of nodes) {
        const prefix = '  '.repeat(indent);
        console.log(`${prefix}${displayRange(n.startLine, n.endLine)}  ${n.shortName}`);
        printTree(n.children, indent + 1);
      }
    }
    printTree(roots, 0);
  }));

// members
program
  .command('members <symbol>')
  .description('All children of a symbol (methods, fields, nested types)')
  .action((symbol) => withDb((db) => {
    render.list(
      queries.members(db, symbol),
      (r) => `  ${displayRange(r.startLine, r.endLine)}  [${r.kind}]  ${r.shortName}`,
    );
  }));

// fan-in
program
  .command('fan-in [symbol]')
  .description('How many files reference a symbol (or top fan-in across codebase)')
  .option('-n, --limit <n>', 'Number of results for top mode', parseIntSafe, 30)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((symbol, opts) => withDb((db) => {
    if (symbol) {
      const results = queries.fanIn(db, symbol);
      if (results.length === 0) return render.empty(`No fan-in for ${symbol}.`);
      render.list(results, (r) => `  ${String(r.count).padStart(4)} files  ${r.name}`);
    } else {
      render.table(
        ['files', 'symbol'],
        queries.topFanIn(db, { limit: opts.limit, scope: opts.scope }).map(
          (r) => `  ${String(r.count).padStart(5)}  ${r.name}`,
        ),
      );
    }
  }));

// fan-out
program
  .command('fan-out [file]')
  .description('How many external symbols a file uses (or top fan-out across codebase)')
  .option('-n, --limit <n>', 'Number of results for top mode', parseIntSafe, 30)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((file, opts) => withDb((db) => {
    if (file) {
      const results = queries.fanOut(db, file);
      if (results.length === 0) return render.empty(`No fan-out for ${file}.`);
      render.list(results, (r) => `  ${String(r.count).padStart(4)} symbols  ${r.name}`);
    } else {
      render.table(
        ['symbols', 'file'],
        queries.topFanOut(db, { limit: opts.limit, scope: opts.scope }).map(
          (r) => `  ${String(r.count).padStart(7)}  ${r.name}`,
        ),
      );
    }
  }));

// coupling
program
  .command('coupling [file1] [file2]')
  .description('Coupling between two files, or top coupled pairs in codebase')
  .option('-n, --limit <n>', 'Number of results for top mode', parseIntSafe, 20)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((file1, file2, opts) => withDb((db) => {
    if (file1 && file2) {
      const result = queries.coupling(db, file1, file2);
      console.log(`${result.file1} ↔ ${result.file2}: ${result.sharedSymbols} shared symbols`);
    } else {
      // Header `file1 → file2` is 13 chars; dash row matches.
      render.table(
        ['shared', 'file1 → file2'],
        queries.topCoupling(db, { limit: opts.limit, scope: opts.scope }).map(
          (r) => `  ${String(r.sharedSymbols).padStart(6)}  ${r.file1} → ${r.file2}`,
        ),
      );
    }
  }));

// cycles — kept inline: numbered groups with framed banners + multiple footers.
program
  .command('cycles')
  .description('Detect circular dependency chains between files')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--max-depth <n>', 'Maximum cycle depth', parseIntSafe, 10)
  .action((opts) => withDb((db) => {
    const results = queries.cycles(db, { scope: opts.scope, maxDepth: opts.maxDepth });
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
  }));

// bottlenecks
program
  .command('bottlenecks')
  .description('Find coupling hubs: high fan-in AND high fan-out')
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 20)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-fan-in <n>', 'Minimum fan-in', parseIntSafe, 2)
  .option('--min-fan-out <n>', 'Minimum fan-out', parseIntSafe, 2)
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'bottlenecks', Boolean(opts.full));
    const results = queries.bottlenecks(db, {
      limit: opts.limit,
      scope: opts.scope,
      minFanIn: opts.minFanIn,
      minFanOut: opts.minFanOut,
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    });
    if (results.length === 0) return render.empty('No bottlenecks found.');
    render.table(
      ['score', 'fan-in', 'fan-out', 'symbol'],
      results.map((r) =>
        `  ${String(r.score).padStart(5)}  ${String(r.fanIn).padStart(6)}  ${String(r.fanOut).padStart(7)}  ${r.shortName}`,
      ),
    );
  }));

// isolated
program
  .command('isolated')
  .description('Find completely orphaned symbols (no references at all)')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum lines of code', parseIntSafe, 3)
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'isolated', Boolean(opts.full));
    const results = queries.isolated(db, {
      scope: opts.scope,
      minLoc: opts.minLoc,
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    });
    if (results.length === 0) return render.empty('No isolated symbols found.');
    render.groupedByFile(
      results,
      (r) => `  ${displayRange(r.startLine, r.endLine)}  (${r.loc} LOC)  ${r.shortName}`,
    );
    console.log(`\n${results.length} isolated symbol(s)`);
  }));

// by-kind
program
  .command('by-kind <kind>')
  .description('Find symbols by SCIP kind (class, interface, enum, function, etc.)')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 100)
  .action((kind, opts) => withDb((db) => {
    const results = queries.byKind(db, kind, { scope: opts.scope, limit: opts.limit });
    if (results.length === 0) {
      return render.empty(`No symbols found for kind "${kind}". Use "kind-counts" to see available kinds.`);
    }
    render.list(
      results,
      (r) => `  ${displayPathRange(r.relativePath, r.startLine, r.endLine)}  [${r.kindName}]  ${r.shortName}`,
    );
    console.log(`\n${results.length} symbol(s)`);
  }));

// kind-counts
program
  .command('kind-counts')
  .description('Histogram of symbol kinds in the codebase')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((opts) => withDb((db) => {
    const results = queries.kindCounts(db, { scope: opts.scope });
    render.table(
      ['count', 'kind'],
      results.map((r) => `  ${String(r.count).padStart(5)}  ${r.kindName} (${r.kind})`),
    );
  }));

// deep-chains — kept inline: enumerated headers `Chain N` need the index.
program
  .command('deep-chains')
  .description('Find the longest transitive dependency chains')
  .option('-n, --limit <n>', 'Number of chains to show', parseIntSafe, 10)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-depth <n>', 'Minimum chain depth', parseIntSafe, 3)
  .action((opts) => withDb((db) => {
    const results = queries.deepChains(db, {
      limit: opts.limit,
      scope: opts.scope,
      minDepth: opts.minDepth,
    });
    if (results.length === 0) return render.empty('No deep chains found.');
    for (let i = 0; i < results.length; i++) {
      console.log(`\nChain ${i + 1} (depth ${results[i]!.depth}):`);
      for (const file of results[i]!.chain) {
        console.log(`  → ${file}`);
      }
    }
  }));

// hierarchy
program
  .command('hierarchy <symbol>')
  .description('Show a symbol\'s ancestry chain (method → class → module)')
  .action((symbol) => withDb((db) => {
    const chain = queries.hierarchy(db, symbol);
    if (chain.length === 0) return render.empty('Symbol not found.');
    render.list(chain, (node) => `${'  '.repeat(node.depth)}${node.shortName}`);
  }));

// call-graph
program
  .command('call-graph <symbol>')
  .description('Show incoming callers and outgoing callees for a symbol')
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((symbol, opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'call-graph', Boolean(opts.full));
    const result = queries.callGraph(db, symbol, { semantic: budget.semantic });
    if (!result) return render.empty('Symbol not found.');
    console.log(`Symbol: ${result.shortName}\n`);
    render.sectionedReport([
      {
        title: `CALLERS (${result.callers.length})`,
        rows: result.callers.map((c) => `  ${c.file}  ${c.shortName}`),
      },
      {
        title: `CALLEES (${result.callees.length})`,
        rows: result.callees.map((c) => `  ${c.file}  ${c.shortName}`),
      },
    ]);
  }));

// similar
program
  .command('similar [symbol]')
  .description('Find heuristic function similarity candidates from callee fingerprints')
  .option('--min-similarity <n>', 'Minimum Jaccard similarity (0-1)', parseFloat, 0.4)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 20)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-callees <n>', 'Minimum callees to consider', parseIntSafe, 4)
  .option('--cross-file-only', 'Only show cross-file pairs (skip same-file matches)')
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((symbol, opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'similar', Boolean(opts.full));
    if (symbol) {
      const results = queries.similar(db, symbol, {
        minSimilarity: opts.minSimilarity,
        limit: opts.limit,
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
        minSimilarity: opts.minSimilarity,
        limit: opts.limit,
        scope: opts.scope,
        minCallees: opts.minCallees,
        crossFileOnly: opts.crossFileOnly,
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
  }));

// similar-files
program
  .command('similar-files [file]')
  .description('Find heuristic similar-file candidates from dependency profiles')
  .option('--min-similarity <n>', 'Minimum Jaccard similarity (0-1)', parseFloat, 0.5)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 20)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-deps <n>', 'Minimum dependencies to consider', parseIntSafe)
  .action((file, opts) => withDb((db) => {
    const results = queries.similarFiles(db, {
      minSimilarity: opts.minSimilarity,
      limit: opts.limit,
      scope: opts.scope,
      minDeps: opts.minDeps,
      filePattern: file,
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
  }));

// similar-chains — kept inline: enumerated `Chain pair N` headers need the index.
program
  .command('similar-chains')
  .description('Find heuristic similar-chain candidates from dependency flows')
  .option('--min-similarity <n>', 'Minimum chain similarity (0-1)', parseFloat, 0.5)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 15)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-length <n>', 'Minimum chain length', parseIntSafe, 3)
  .option('--max-length <n>', 'Maximum chain length', parseIntSafe, 8)
  .action((opts) => withDb((db) => {
    const results = queries.similarChains(db, {
      minSimilarity: opts.minSimilarity,
      limit: opts.limit,
      scope: opts.scope,
      minChainLength: opts.minLength,
      maxChainLength: opts.maxLength,
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
      for (const d of r.divergencePoints) {
        console.log(`    [${d.index}] ${d.nodeA}  ↔  ${d.nodeB}`);
      }
    }
    console.log(`\n${results.length} similar chain pair(s) found.`);
  }));

// extract-candidates — kept inline: enumerated `Cluster N` sub-headers need the index.
program
  .command('extract-candidates')
  .description('Find heuristic extraction candidates from isolated callee clusters')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum function LOC', parseIntSafe, 10)
  .option('--min-callees <n>', 'Minimum callees to analyze', parseIntSafe, 6)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 20)
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'extract-candidates', Boolean(opts.full));
    const results = queries.extractCandidates(db, {
      scope: opts.scope,
      minLoc: opts.minLoc,
      minCallees: opts.minCallees,
      limit: opts.limit,
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
        for (const callee of c.callees) {
          console.log(`    ${callee}`);
        }
      }
    }
    console.log(`\n${results.length} extraction candidate(s) found.`);
  }));

// affected
program
  .command('affected <symbol>')
  .description('Transitive closure of symbols that could break if this symbol changes')
  .option('--max-depth <n>', 'Maximum traversal depth', parseIntSafe, 5)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((symbol, opts) => withDb((db) => {
    const results = queries.affected(db, symbol, { maxDepth: opts.maxDepth, scope: opts.scope });
    if (results.length === 0) return render.empty('No affected symbols found.');
    // Grouped by depth (not file) — kept inline since the registry's
    // groupedByFile prints the key as a header line, but here the depth
    // header is `\n  ── Depth N ──` (blank line + framed banner).
    let prevDepth = -1;
    for (const r of results) {
      if (r.depth !== prevDepth) {
        console.log(`\n  ── Depth ${r.depth} ──`);
        prevDepth = r.depth;
      }
      console.log(`  ${r.file}  ${r.shortName}`);
    }
    console.log(`\n${results.length} affected symbol(s) across ${new Set(results.map((r) => r.file)).size} files.`);
  }));

// change-surface
program
  .command('change-surface <file>')
  .description('Pre-change briefing: exports, consumers, and blast-radius risk')
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((file, opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'change-surface', Boolean(opts.full));
    const result = queries.changeSurface(db, file, { semantic: budget.semantic });
    if (!result) return render.empty('File not found in index.');
    console.log(`File: ${result.file}`);
    console.log(`External consumers: ${result.totalExternalConsumers}\n`);
    render.list(result.symbols, (s) => {
      const risk = s.riskLevel === 'high' ? ' *** HIGH RISK ***' : s.riskLevel === 'medium' ? ' * medium risk *' : '';
      return `  ${displayRange(s.startLine, s.endLine)}  ${s.shortName}  [${s.externalConsumers} consumers]${risk}`;
    });
  }));

program
  .command(DIFF_IMPACT_BATCH_COMMAND, { hidden: true })
  .option('--base <ref>', 'Git ref to diff against (default: HEAD)')
  .action((opts) => withDb((db) => {
    const files = JSON.parse(process.env['SCIP_QUERY_DIFF_IMPACT_FILES'] ?? '[]') as string[];
    const plan = queries.diffImpactPlan(db, { base: opts.base });
    const result = queries.diffImpactPartial(db, files, plan.changedFiles);
    console.log(JSON.stringify(result));
  }));

// diff-impact
program
  .command('diff-impact')
  .description('Compute changed symbols and downstream consumers from current git diff')
  .option('--base <ref>', 'Git ref to diff against (default: HEAD)')
  .action((opts) => {
    try {
      renderDiffImpactReport(runIsolatedDiffImpactReport({ base: opts.base }));
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// drift
program
  .command('drift [module]')
  .description('Detect heuristic drift candidates: unused imports, layer violations, and pattern deviations')
  .option('--min-deviation <n>', 'Minimum sibling files before reporting unique dependency deviations', parsePositiveInt, 5)
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((module, opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'drift', Boolean(opts.full));
    const summary = queries.drift(db, {
      scope: module,
      minDeviation: opts.minDeviation,
      semantic: budget.semantic,
    });
    if (summary.results.length === 0) return render.empty('No drift detected.');
    renderHeuristicNotice('drift candidates');
    // Original printed a leading `\n${file}` for every group — replicate by
    // emitting a leading blank line before the first group as well.
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
  }));

// wrapper-candidates
program
  .command('wrapper-candidates')
  .description('Find heuristic wrapper candidates only called by one consumer')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--max-loc <n>', 'Maximum LOC for candidates', parseIntSafe, 15)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 30)
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'wrapper-candidates', Boolean(opts.full));
    const results = queries.wrapperCandidates(db, {
      scope: opts.scope,
      maxLoc: opts.maxLoc,
      limit: opts.limit,
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    });
    if (results.length === 0) return render.empty('No wrapper candidates found.');
    renderHeuristicNotice('wrapper candidates');
    render.list(
      results,
      (r) =>
        `  ${displayPathRange(r.file, r.startLine, r.endLine)}  ${r.shortName}  (${r.loc} LOC)\n` +
        `    Only called by: ${r.singleCallerShort}  (fan-in: ${r.callerFanIn})`,
    );
    console.log(`\n${results.length} wrapper candidate(s).`);
  }));

// passthrough-candidates
program
  .command('passthrough-candidates')
  .description('Find heuristic passthrough candidates that forward to one callee')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--max-loc <n>', 'Maximum LOC for candidates', parseIntSafe, 15)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 30)
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'passthrough-candidates', Boolean(opts.full));
    const results = queries.passthroughCandidates(db, {
      scope: opts.scope,
      maxLoc: opts.maxLoc,
      limit: opts.limit,
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    });
    if (results.length === 0) return render.empty('No passthrough candidates found.');
    renderHeuristicNotice('passthrough candidates');
    render.list(
      results,
      (r) =>
        `  ${displayPathRange(r.file, r.startLine, r.endLine)}  ${r.shortName}  (${r.loc} LOC)\n` +
        `    Forwards to: ${r.forwardsToShort}  (${r.forwardsToFile})`,
    );
    console.log(`\n${results.length} passthrough candidate(s).`);
  }));

// stale-abstractions
program
  .command('stale-abstractions')
  .description('Find heuristic stale abstraction candidates with 0-1 consumers')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum LOC', parseIntSafe, 3)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 30)
  .option('--include-low-confidence', 'Include 1-consumer classes (usually encapsulation, not stale)', false)
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'stale-abstractions', Boolean(opts.full));
    const results = queries.staleAbstractions(db, {
      scope: opts.scope,
      minLoc: opts.minLoc,
      limit: opts.limit,
      includeLowConfidence: Boolean(opts.includeLowConfidence),
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
  }));

// complexity-hotspots
program
  .command('complexity-hotspots')
  .description('Find heuristic complexity hotspot candidates from LOC x fan-in x fan-out')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum LOC', parseIntSafe, 10)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 20)
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'complexity-hotspots', Boolean(opts.full));
    const results = queries.complexityHotspots(db, {
      scope: opts.scope,
      minLoc: opts.minLoc,
      limit: opts.limit,
      scanLimit: budget.scanLimit,
      semantic: budget.semantic,
    });
    if (results.length === 0) return render.empty('No complexity hotspots found.');
    renderHeuristicNotice('complexity hotspot candidates');
    // Header `LOC` is 3 chars but the body column pads to 4, so override
    // dash widths to match the data widths rather than header lengths.
    render.table(
      ['score', ' LOC', 'fan-in', 'fan-out', 'callees', 'symbol'],
      results.map((r) =>
        `  ${r.score.toFixed(1).padStart(5)}  ${String(r.loc).padStart(4)}  ${String(r.fanIn).padStart(6)}  ${String(r.fanOut).padStart(7)}  ${String(r.calleeCount).padStart(7)}  ${r.shortName}`,
      ),
      [5, 4, 6, 7, 7, 6],
    );
  }));

program
  .command(HEALTH_PHASE_COMMAND, { hidden: true })
  .argument('<phase>')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--full', 'Run unbounded candidate analyses on large indexes')
  .action((phase, opts) => withDb((db) => {
    if (!queries.HEALTH_PHASES.includes(phase)) {
      console.error(`error: Unknown health phase: ${phase}`);
      process.exit(1);
    }
    const result = queries.healthPhase(db, phase, { scope: opts.scope, full: Boolean(opts.full) });
    console.log(JSON.stringify(result));
  }));

// health — phase-isolated because composite reports can otherwise retain large
// language-service and graph caches across unrelated checks on huge indexes.
program
  .command('health')
  .description('Composite codebase health report with prioritized action list')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--full', 'Run unbounded candidate analyses on large indexes')
  .option('--json', 'Output as JSON for programmatic consumption')
  .action((opts) => {
    try {
      const report = runIsolatedHealthReport({
        scope: opts.scope,
        full: Boolean(opts.full),
        json: Boolean(opts.json),
      });
      renderHealthReport(report, Boolean(opts.json));
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// convergence — kept inline: bespoke layout (intro line + A/B side-by-side
// + shared/unique sub-sections + strategy footer).
program
  .command('convergence <symbol1> <symbol2>')
  .description('Show what a consolidated version of two similar functions would look like')
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((symbol1, symbol2, opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'convergence', Boolean(opts.full));
    const result = queries.convergence(db, symbol1, symbol2, { semantic: budget.semantic });
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
  }));

// code
program
  .command('code <symbol>')
  .description('Read the source code for a symbol (bounded to its definition range)')
  .option('-C, --context <n>', 'Extra lines of context above/below', parseIntSafe, 0)
  .action((symbol, opts) => withDb((db) => {
    const result = queries.code(db, symbol, { context: opts.context });
    if (!result) return render.empty('Symbol not found or file unreadable.');
    console.log(`${displayPathRange(result.relativePath, result.startLine, result.endLine)}  ${result.shortName}  [${result.language ?? 'unknown'}]\n`);
    const lines = result.source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      console.log(`  ${String(displayLine(result.startLine + i)).padStart(4)}  ${lines[i]}`);
    }
  }));

// complexity
program
  .command('complexity <symbol>')
  .description('Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees')
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((symbol, opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'complexity', Boolean(opts.full));
    const result = queries.complexity(db, symbol, { semantic: budget.semantic });
    if (!result) return render.empty('Symbol not found.');
    console.log(`${displayPathRange(result.relativePath, result.startLine, result.endLine)}  ${result.shortName}\n`);
    console.log(`  LOC:                  ${result.loc}`);
    console.log(`  Branches:             ${result.branches}`);
    console.log(`  Cyclomatic estimate:  ${result.cyclomaticEstimate}`);
    console.log(`  Callees:              ${result.calleeCount}`);
    console.log(`  Fan-in:               ${result.fanIn}`);
    console.log(`  Fan-out:              ${result.fanOut}`);
  }));

// dataflow — kept inline: section banners have a 2-space prefix that
// differs from the registry's bare `═══` shape, and sections are skipped
// when empty.
program
  .command('dataflow <symbol>')
  .description('Reference-level dataflow: definition sites, usage sites, producers, consumers')
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((symbol, opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'dataflow', Boolean(opts.full));
    const result = queries.dataflow(db, symbol, { semantic: budget.semantic });
    if (!result) return render.empty('Symbol not found.');
    console.log(`${result.shortName}  (${result.relativePath})\n`);

    if (result.definitionSites.length > 0) {
      console.log('  ═══ DEFINED AT ═══');
      for (const s of result.definitionSites) {
        console.log(`    ${s.file}:${displayLine(s.line)}`);
      }
    }

    if (result.usageSites.length > 0) {
      console.log('\n  ═══ USED AT ═══');
      for (const s of result.usageSites) {
        console.log(`    ${s.file}:${displayLine(s.line)}  in ${s.enclosingShort}`);
      }
    }

    if (result.producers.length > 0) {
      console.log('\n  ═══ PRODUCERS (feeds into this) ═══');
      for (const p of result.producers) {
        console.log(`    ${p.file}  ${p.shortName}`);
      }
    }

    if (result.consumers.length > 0) {
      console.log('\n  ═══ CONSUMERS (this feeds into) ═══');
      for (const c of result.consumers) {
        console.log(`    ${c.file}  ${c.shortName}`);
      }
    }
  }));

// slice
program
  .command('slice <symbol>')
  .description('Reference-level program slice: what affects this (backward) or what this affects (forward)')
  .option('--forward', 'Forward slice (what does this affect). Default is backward.')
  .option('--depth <n>', 'Max transitive depth for backward slice', parseIntSafe, 3)
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((symbol, opts) => withDb((db) => {
    const direction = opts.forward ? 'forward' : 'backward';
    const budget = commandAnalysisBudget(db, 'slice', Boolean(opts.full));
    const result = queries.slice(db, symbol, { direction, maxDepth: opts.depth, semantic: budget.semantic });
    if (!result) return render.empty('Symbol not found.');
    console.log(`${result.direction} slice of ${result.shortName}\n`);
    if (result.connectedSymbols.length === 0) {
      console.log('  No connected symbols found.');
      return;
    }
    render.list(
      result.connectedSymbols,
      (s) => `  ${s.file}  ${s.shortName}\n    ${s.relationship}`,
    );
    console.log(`\n${result.connectedSymbols.length} connected symbol(s).`);
  }));

// install-skills
program
  .command('install-skills')
  .description(`Install skills (${BUILTIN_SKILLS.join(', ')}) into Claude Code and Codex`)
  .action(() => {
    const result = installSkills();
    const total = result.installed.length + result.alreadyLinked.length;
    console.log(`\n${result.installed.length} installed, ${result.alreadyLinked.length} already linked, ${result.skipped.length} skipped.`);
    if (total > 0) {
      console.log('Skills will be available in your next Claude Code / Codex session.');
    }
  });

// check-deps
program
  .command('check-deps')
  .description('Check whether scip-query and the detected language indexers are actually runnable')
  .action(() => {
    let hasProblems = false;
    if (isScipInstalled()) {
      console.log('scip CLI: installed');
    } else {
      printScipInstallInstructions();
      hasProblems = true;
    }

    const projectRoot = resolveProjectRoot();
    const config = loadProjectConfig(projectRoot);
    const languages = config.languages ?? detectLanguages(projectRoot);

    if (languages.length === 0) {
      console.log('\nNo supported project languages detected in the current directory.');
      process.exitCode = hasProblems ? 1 : 0;
      return;
    }

    console.log(`\nDetected languages: ${languages.join(', ')}`);
    console.log('\nIndexer readiness:');

    for (const language of languages) {
      const status = getIndexerDependencyStatus(getIndexerConfig(language), projectRoot);
      const prefix = status.runnable ? '  OK' : status.installed ? '  WARN' : '  MISSING';
      const resolved = status.resolvedBinary ? ` (${status.resolvedBinary})` : '';

      console.log(`${prefix} ${language}: ${status.binaryLabel}${resolved}`);
      if (status.note) {
        console.log(`    ${status.note}`);
      }
      if (!status.installed && status.installUrl) {
        console.log(`    install: ${status.installUrl}`);
      }
      if (!status.runnable) {
        hasProblems = true;
      }
    }

    if (languages.includes('typescript')) {
      const status = getTypeScriptSemanticStatus(projectRoot, config.semantic?.typescript?.tsconfigs);
      const prefix = status.available ? '  OK' : status.dependencyAvailable ? '  WARN' : '  MISSING';
      const configPath = status.tsconfigPaths && status.tsconfigPaths.length > 1
        ? ` (${status.tsconfigPaths.length} tsconfigs)`
        : status.tsconfigPath ? ` (${status.tsconfigPath})` : '';
      console.log('\nSemantic provider readiness:');
      console.log(`${prefix} typescript: ts-morph${configPath}`);
      if (status.reason) {
        console.log(`    ${status.reason}; semantic checks will fall back to SCIP/source evidence`);
      }
    }

    process.exitCode = hasProblems ? 1 : 0;
  });

// redundant-reexports
program
  .command('redundant-reexports')
  .description('Find barrel re-exports that nobody imports through')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 30)
  .action((opts) => withDb((db) => {
    const results = queries.redundantReexports(db, { scope: opts.scope, limit: opts.limit });
    if (results.length === 0) return render.empty('No redundant re-exports found.');
    render.groupedByFile(
      results,
      (r) =>
        `  ${r.shortName}  (from ${r.originalFile})\n` +
        `    barrel: ${r.barrelConsumers} consumer(s) | direct: ${r.directConsumers} consumer(s)`,
      (r) => r.barrelFile,
    );
    console.log(`\n${results.length} redundant re-export(s).`);
  }));

// similar-signatures
program
  .command('similar-signatures')
  .description('Find functions with near-identical type signatures (same shape)')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum LOC per function', parseIntSafe, 3)
  .option('-n, --limit <n>', 'Number of groups', parseIntSafe, 20)
  .option('--full', 'Run unbounded semantic analysis on large indexes')
  .action((opts) => withDb((db) => {
    const budget = commandAnalysisBudget(db, 'similar-signatures', Boolean(opts.full));
    const groups = queries.similarSignatures(db, {
      scope: opts.scope,
      minLoc: opts.minLoc,
      limit: opts.limit,
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
  }));

// init
program
  .command('init')
  .description('Create a .scipquery.json config file for this project')
  .action(() => {
    const projectRoot = resolveProjectRoot();
    const languages = detectLanguages(projectRoot);
    const configPath = initProjectConfig(projectRoot, languages);
    console.log(`Config written to ${configPath}`);
    console.log(`Detected languages: ${languages.join(', ') || '(none)'}`);
  });

// watch
program
  .command('watch')
  .description('Watch for file changes and reindex automatically')
  .option('--debounce <ms>', 'Ms to wait after last change (default: 30000)', parseInt)
  .option('--cooldown <ms>', 'Min ms between reindexes (default: 60000)', parseInt)
  .action((opts) => {
    const projectRoot = resolveProjectRoot();
    const config = loadProjectConfig(projectRoot);

    // CLI flags override config
    if (opts.debounce) (config.watch ??= {}).debounceMs = opts.debounce;
    if (opts.cooldown) (config.watch ??= {}).cooldownMs = opts.cooldown;

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
  });

// status
program
  .command('status')
  .description('Show index status for this project')
  .action(() => {
    const projectRoot = resolveProjectRoot();
    const config = loadProjectConfig(projectRoot);
    const paths = resolveIndexPaths(projectRoot, config);
    const dbPath = resolveActiveDbPath(projectRoot);

    console.log(`Project:  ${projectRoot}`);
    console.log(`DB path:  ${dbPath}`);
    if (dbPath !== paths.dbPath) {
      console.log(`Config:   ${paths.dbPath} (fallback to project root index.db)`);
    }
    if ((config.languages ?? detectLanguages(projectRoot)).includes('typescript')) {
      const semanticStatus = getTypeScriptSemanticStatus(projectRoot, config.semantic?.typescript?.tsconfigs);
      const semanticState = semanticStatus.available ? 'available' : 'fallback';
      const suffix = semanticStatus.tsconfigPaths && semanticStatus.tsconfigPaths.length > 1
        ? ` (${semanticStatus.tsconfigPaths.length} tsconfigs)`
        : semanticStatus.tsconfigPath ? ` (${semanticStatus.tsconfigPath})` : '';
      console.log(`TS sem:   ${semanticState}${suffix}`);
      if (semanticStatus.reason) {
        console.log(`TS note:  ${semanticStatus.reason}`);
      }
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
  });

// ── Parse & Run ────────────────────────────────────────────

export { program };

if (isCliEntrypoint()) {
  program.parse();
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  const thisFile = fileURLToPath(import.meta.url);
  try {
    return realpathSync(thisFile) === realpathSync(process.argv[1]);
  } catch {
    return thisFile === process.argv[1];
  }
}
