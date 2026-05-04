import { program } from 'commander';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScipDatabase } from './db.js';
import { createGitignoreFilter } from './gitignore-filter.js';
import { loadProjectConfig, resolveIndexPaths, initProjectConfig } from './config.js';
import { reindex, detectLanguages } from './reindex/index.js';
import { getIndexerConfig } from './reindex/indexers.js';
import { getIndexerDependencyStatus } from './reindex/install.js';
import { Watcher } from './watch.js';
import { stats } from './queries/stats.js';
import { files } from './queries/files.js';
import { symbols } from './queries/symbols.js';
import { methods } from './queries/methods.js';
import { refs } from './queries/refs.js';
import { trace } from './queries/trace.js';
import { deps, rdeps } from './queries/deps.js';
import { system } from './queries/system.js';
import { surface } from './queries/surface.js';
import { dead } from './queries/dead.js';
import { hotspots } from './queries/hotspots.js';
import { imports, importedBy, unusedImports } from './queries/imports.js';
import { outline } from './queries/outline.js';
import { members } from './queries/members.js';
import { fanIn, fanOut, topFanIn, topFanOut } from './queries/fan.js';
import { coupling, topCoupling } from './queries/coupling.js';
import { cycles } from './queries/cycles.js';
import { bottlenecks } from './queries/bottlenecks.js';
import { isolated } from './queries/isolated.js';
import { byKind, kindCounts } from './queries/by-kind.js';
import { deepChains } from './queries/deep-chains.js';
import { hierarchy } from './queries/hierarchy.js';
import { callGraph } from './queries/call-graph.js';
import { similar, similarAll } from './queries/similar.js';
import { similarFiles } from './queries/similar-files.js';
import { similarChains } from './queries/similar-chains.js';
import { extractCandidates } from './queries/extract-candidates.js';
import { affected } from './queries/affected.js';
import { changeSurface } from './queries/change-surface.js';
import { diffImpact } from './queries/diff-impact.js';
import { drift } from './queries/drift.js';
import { wrapperCandidates } from './queries/wrapper-candidates.js';
import { passthroughCandidates } from './queries/passthrough-candidates.js';
import { staleAbstractions } from './queries/stale-abstractions.js';
import { complexityHotspots } from './queries/complexity-hotspots.js';
import { health } from './queries/health.js';
import { convergence } from './queries/convergence.js';
import { code } from './queries/code.js';
import { complexity } from './queries/complexity.js';
import { dataflow } from './queries/dataflow.js';
import { slice } from './queries/slice.js';
import { redundantReexports } from './queries/redundant-reexports.js';
import { similarSignatures } from './queries/similar-signatures.js';
import type { ScipQueryConfig, DeadOptions, WatcherStatus } from './types.js';
import { BUILTIN_SKILLS, installSkills, isScipInstalled, printScipInstallInstructions } from './setup.js';
import { displayLine, displayPathRange, displayRange, render } from './render.js';

const require = createRequire(import.meta.url);
const { version: cliVersion } = require('../package.json') as { version: string };

// ── Helpers ────────────────────────────────────────────────

function resolveProjectRoot(): string {
  return process.env['SCIP_QUERY_PROJECT_ROOT'] ?? process.cwd();
}

function resolveActiveDbPath(projectRoot: string): string {
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexPaths(projectRoot, config);
  return process.env['SCIP_QUERY_INDEX_DB']
    ?? (existsSync(paths.dbPath) ? paths.dbPath : join(projectRoot, 'index.db'));
}

function openDb(): ScipDatabase {
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexPaths(projectRoot, config);

  const dbPath = resolveActiveDbPath(projectRoot);

  if (!existsSync(dbPath)) {
    console.error(`error: No index.db found. Run: scip-query reindex`);
    process.exit(1);
  }

  const dbConfig: ScipQueryConfig = {
    dbPath,
    indexPath: process.env['SCIP_QUERY_INDEX_SCIP'] ?? paths.indexPath,
    projectRoot,
  };

  const filter = createGitignoreFilter(projectRoot);
  return new ScipDatabase(dbConfig, filter);
}

function withDb(run: (db: ScipDatabase) => void): void {
  const db = openDb();
  try {
    run(db);
  } finally {
    db.close();
  }
}

const queries = {
  stats,
  files,
  symbols,
  methods,
  refs,
  trace,
  deps,
  rdeps,
  system,
  surface,
  dead,
  hotspots,
  imports,
  importedBy,
  unusedImports,
  outline,
  members,
  fanIn,
  fanOut,
  topFanIn,
  topFanOut,
  coupling,
  topCoupling,
  cycles,
  bottlenecks,
  isolated,
  byKind,
  kindCounts,
  deepChains,
  hierarchy,
  callGraph,
  similar,
  similarAll,
  similarFiles,
  similarChains,
  extractCandidates,
  affected,
  changeSurface,
  diffImpact,
  drift,
  wrapperCandidates,
  passthroughCandidates,
  staleAbstractions,
  complexityHotspots,
  health,
  convergence,
  code,
  complexity,
  dataflow,
  slice,
  redundantReexports,
  similarSignatures,
} as const;

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
      });
      console.log(`Indexed ${result.languages.join(', ')} in ${(result.durationMs / 1000).toFixed(1)}s`);
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
  .action((symbol) => withDb((db) => {
    render.groupedByFile(queries.refs(db, symbol), (r) => `  line ${displayLine(r.line)}`);
  }));

// trace
program
  .command('trace <symbol>')
  .description('Trace a symbol: definition + all references')
  .action((symbol) => withDb((db) => {
    const result = queries.trace(db, symbol);

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
  // dead — kept inline: section title carries derived counts (`(N, M LOC)`),
  // bodies sort files by per-file total LOC, and a hand-formatted footer
  // sums across both groups. None of those fit a registry shape cleanly.
  .action((scope, opts) => withDb((db) => {
    const deadOpts: DeadOptions = {
      scope: scope || undefined,
      minLoc: opts.minLoc,
      includeTests: opts.includeTests,
      skipBarrels: opts.skipBarrels,
      includeMembers: opts.includeMembers,
    };

    const result = queries.dead(db, deadOpts);

    if (result.symbols.length === 0) return render.empty('No dead code found.');

    const deadCode = result.symbols.filter((s) => s.kind === 'dead-code');
    const fileInternal = result.symbols.filter((s) => s.kind !== 'dead-code');
    const showDead = !opts.onlyInternal;
    const showInternal = !opts.onlyDead;

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

    const deadLoc = deadCode.reduce((sum, s) => sum + s.loc, 0);
    const fiLoc = fileInternal.reduce((sum, s) => sum + s.loc, 0);

    if (showDead && deadCode.length > 0) {
      renderGroup(
        deadCode,
        'DEAD CODE',
        '  Zero references anywhere — no cross-file callers AND no same-file uses.\n  Safe to delete.',
        deadLoc,
      );
    }

    if (showInternal && fileInternal.length > 0) {
      if (showDead && deadCode.length > 0) console.log('');
      renderGroup(
        fileInternal,
        'FILE-INTERNAL ONLY',
        '  Used only within the same file (no cross-file callers). Could be a\n  single-use helper, an abstraction-in-progress, or a callback registered\n  through a framework path that static analysis cannot trace (signal\n  handlers, event listeners, dependency injection). NOT necessarily dead —\n  review case by case.',
        fiLoc,
      );
    }

    console.log('\n───────────────────────────');
    console.log(
      `Total: ${result.totalCount} symbols — ` +
      `${result.deadCodeCount} dead code (${deadLoc} LOC) + ` +
      `${result.fileInternalCount} file-internal (${fiLoc} LOC)`,
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
  .action((file) => withDb((db) => {
    const results = queries.imports(db, file);
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
  .action((file) => withDb((db) => {
    const results = queries.unusedImports(db, file);
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
      render.list(
        queries.fanIn(db, symbol),
        (r) => `  ${String(r.count).padStart(4)} files  ${r.name}`,
      );
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
      render.list(
        queries.fanOut(db, file),
        (r) => `  ${String(r.count).padStart(4)} symbols  ${r.name}`,
      );
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
  .action((opts) => withDb((db) => {
    const results = queries.bottlenecks(db, {
      limit: opts.limit,
      scope: opts.scope,
      minFanIn: opts.minFanIn,
      minFanOut: opts.minFanOut,
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
  .action((opts) => withDb((db) => {
    const results = queries.isolated(db, { scope: opts.scope, minLoc: opts.minLoc });
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
  .action((symbol) => withDb((db) => {
    const result = queries.callGraph(db, symbol);
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
  .description('Find functions with similar callee fingerprints (consolidation candidates)')
  .option('--min-similarity <n>', 'Minimum Jaccard similarity (0-1)', parseFloat, 0.4)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 20)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-callees <n>', 'Minimum callees to consider', parseIntSafe, 4)
  .option('--cross-file-only', 'Only show cross-file pairs (skip same-file matches)')
  .action((symbol, opts) => withDb((db) => {
    if (symbol) {
      const results = queries.similar(db, symbol, {
        minSimilarity: opts.minSimilarity,
        limit: opts.limit,
      });
      if (results.length === 0) return render.empty('No similar symbols found.');
      render.list(results, (r) => {
        const lines = [
          `\n${Math.round(r.similarity * 100)}% similar:`,
          `  A: ${r.shortNameA}  (${r.fileA})`,
          `  B: ${r.shortNameB}  (${r.fileB})`,
          `  Shared callees: ${r.sharedCallees.join(', ')}`,
        ];
        if (r.uniqueToA.length) lines.push(`  Only in A: ${r.uniqueToA.join(', ')}`);
        if (r.uniqueToB.length) lines.push(`  Only in B: ${r.uniqueToB.join(', ')}`);
        return lines.join('\n');
      });
    } else {
      const results = queries.similarAll(db, {
        minSimilarity: opts.minSimilarity,
        limit: opts.limit,
        scope: opts.scope,
        minCallees: opts.minCallees,
        crossFileOnly: opts.crossFileOnly,
      });
      if (results.length === 0) return render.empty('No similar symbol pairs found.');
      render.list(results, (r) =>
        `\n${Math.round(r.similarity * 100)}% similar:\n` +
        `  A: ${r.shortNameA}  (${r.fileA})\n` +
        `  B: ${r.shortNameB}  (${r.fileB})\n` +
        `  Shared: ${r.sharedCallees.join(', ')}`,
      );
      console.log(`\n${results.length} similar pair(s) found.`);
    }
  }));

// similar-files
program
  .command('similar-files [file]')
  .description('Find files with similar dependency profiles')
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
  .description('Find end-to-end dependency flows that diverge at few points')
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
  .description('Find functions with natural extraction seams (isolated callee clusters)')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum function LOC', parseIntSafe, 10)
  .option('--min-callees <n>', 'Minimum callees to analyze', parseIntSafe, 6)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 20)
  .action((opts) => withDb((db) => {
    const results = queries.extractCandidates(db, {
      scope: opts.scope,
      minLoc: opts.minLoc,
      minCallees: opts.minCallees,
      limit: opts.limit,
    });
    if (results.length === 0) return render.empty('No extraction candidates found.');
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
  .action((file) => withDb((db) => {
    const result = queries.changeSurface(db, file);
    if (!result) return render.empty('File not found in index.');
    console.log(`File: ${result.file}`);
    console.log(`External consumers: ${result.totalExternalConsumers}\n`);
    render.list(result.symbols, (s) => {
      const risk = s.riskLevel === 'high' ? ' *** HIGH RISK ***' : s.riskLevel === 'medium' ? ' * medium risk *' : '';
      return `  ${displayRange(s.startLine, s.endLine)}  ${s.shortName}  [${s.externalConsumers} consumers]${risk}`;
    });
  }));

// diff-impact
program
  .command('diff-impact')
  .description('Compute changed symbols and downstream consumers from current git diff')
  .option('--base <ref>', 'Git ref to diff against (default: HEAD)')
  .action((opts) => withDb((db) => {
    const result = queries.diffImpact(db, { base: opts.base });
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
  }));

// drift
program
  .command('drift [module]')
  .description('Detect unused imports, layer violations, and pattern deviations')
  .action((module) => withDb((db) => {
    const summary = queries.drift(db, { scope: module });
    if (summary.results.length === 0) return render.empty('No drift detected.');
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
  .description('Find symbols only called by one consumer (premature abstractions)')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--max-loc <n>', 'Maximum LOC for candidates', parseIntSafe, 15)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 30)
  .action((opts) => withDb((db) => {
    const results = queries.wrapperCandidates(db, { scope: opts.scope, maxLoc: opts.maxLoc, limit: opts.limit });
    if (results.length === 0) return render.empty('No wrapper candidates found.');
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
  .description('Find functions that just forward to one other function')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--max-loc <n>', 'Maximum LOC for candidates', parseIntSafe, 15)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 30)
  .action((opts) => withDb((db) => {
    const results = queries.passthroughCandidates(db, { scope: opts.scope, maxLoc: opts.maxLoc, limit: opts.limit });
    if (results.length === 0) return render.empty('No passthrough candidates found.');
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
  .description('Find types/interfaces with 0-1 consumers (premature abstractions)')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum LOC', parseIntSafe, 3)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 30)
  .option('--include-low-confidence', 'Include 1-consumer classes (usually encapsulation, not stale)', false)
  .action((opts) => withDb((db) => {
    const results = queries.staleAbstractions(db, {
      scope: opts.scope,
      minLoc: opts.minLoc,
      limit: opts.limit,
      includeLowConfidence: Boolean(opts.includeLowConfidence),
    });
    if (results.length === 0) return render.empty('No stale abstractions found.');
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
  .description('Composite complexity score: LOC x fan-in x fan-out')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum LOC', parseIntSafe, 10)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 20)
  .action((opts) => withDb((db) => {
    const results = queries.complexityHotspots(db, { scope: opts.scope, minLoc: opts.minLoc, limit: opts.limit });
    if (results.length === 0) return render.empty('No complexity hotspots found.');
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

// health — kept inline: bespoke layout (banners with leading-space indent,
// conditional findings, prioritized actions list). Doesn't fit any registry shape.
program
  .command('health')
  .description('Composite codebase health report with prioritized action list')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--json', 'Output as JSON for programmatic consumption')
  .action((opts) => withDb((db) => {
    const report = queries.health(db, { scope: opts.scope });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`\n  Codebase Health Score: ${report.score}/100\n`);
    console.log(`  ${report.overview.documents} files | ${report.overview.symbols} symbols | ${formatBytes(report.overview.indexSizeBytes)}\n`);

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
  }));

// convergence — kept inline: bespoke layout (intro line + A/B side-by-side
// + shared/unique sub-sections + strategy footer).
program
  .command('convergence <symbol1> <symbol2>')
  .description('Show what a consolidated version of two similar functions would look like')
  .action((symbol1, symbol2) => withDb((db) => {
    const result = queries.convergence(db, symbol1, symbol2);
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
  .action((symbol) => withDb((db) => {
    const result = queries.complexity(db, symbol);
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
  .action((symbol) => withDb((db) => {
    const result = queries.dataflow(db, symbol);
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
  .action((symbol, opts) => withDb((db) => {
    const direction = opts.forward ? 'forward' : 'backward';
    const result = queries.slice(db, symbol, { direction, maxDepth: opts.depth });
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
  .action((opts) => withDb((db) => {
    const groups = queries.similarSignatures(db, { scope: opts.scope, minLoc: opts.minLoc, limit: opts.limit });
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

// ── Utility ────────────────────────────────────────────────

function collect(value: string, prev: string[]): string[] {
  return prev.concat([value]);
}

/** parseInt wrapper safe for commander (which passes default as 2nd arg = radix) */
function parseIntSafe(value: string): number {
  return parseInt(value, 10);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatStatus(status: WatcherStatus): string {
  switch (status.state) {
    case 'idle':
      return 'Watching (idle)';
    case 'waiting': {
      const secs = Math.round((status.reindexAt - Date.now()) / 1000);
      return `${status.changedFiles} file(s) changed, reindexing in ${secs}s...`;
    }
    case 'indexing':
      return `Reindexing... (${Math.round((Date.now() - status.startedAt) / 1000)}s)`;
    case 'cooldown': {
      const secs = Math.round((status.until - Date.now()) / 1000);
      return `Cooldown (${secs}s)${status.dirty ? ' — changes pending' : ''}`;
    }
  }
}
