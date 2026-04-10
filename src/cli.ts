import { program } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ScipDatabase } from './db.js';
import { createGitignoreFilter } from './gitignore-filter.js';
import { loadProjectConfig, resolveIndexPaths, initProjectConfig } from './config.js';
import { reindex, detectLanguages } from './reindex/index.js';
import { Watcher } from './watch.js';
import * as queries from './queries/index.js';
import type { ScipQueryConfig, DeadOptions, WatcherStatus } from './types.js';

// ── Helpers ────────────────────────────────────────────────

function resolveProjectRoot(): string {
  return process.env['SCIP_QUERY_PROJECT_ROOT'] ?? process.cwd();
}

function openDb(): ScipDatabase {
  const projectRoot = resolveProjectRoot();
  const config = loadProjectConfig(projectRoot);
  const paths = resolveIndexPaths(projectRoot, config);

  // Also check legacy location (project root) for backwards compat
  const dbPath = process.env['SCIP_QUERY_INDEX_DB']
    ?? (existsSync(paths.dbPath) ? paths.dbPath : join(projectRoot, 'index.db'));

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

// ── CLI Definition ─────────────────────────────────────────

program
  .name('scip-query')
  .description('Language-agnostic code intelligence CLI powered by SCIP indexes')
  .version('0.1.0');

// reindex
program
  .command('reindex')
  .description('Index the codebase and convert to SQLite')
  .option('-l, --language <lang>', 'Index only this language (can be repeated)', collect, [])
  .option('--pnpm-workspaces', 'Enable pnpm workspace support (TypeScript)')
  .action(async (opts) => {
    const projectRoot = resolveProjectRoot();
    try {
      const result = await reindex({
        projectRoot,
        languages: opts.language.length > 0 ? opts.language : undefined,
        pnpmWorkspaces: opts.pnpmWorkspaces,
      });
      console.log(`Indexed ${result.languages.join(', ')} in ${(result.durationMs / 1000).toFixed(1)}s`);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// stats
program
  .command('stats')
  .description('Show index statistics')
  .action(() => {
    const db = openDb();
    const s = queries.stats(db);
    console.log(`Documents:   ${s.documents}`);
    console.log(`Symbols:     ${s.symbols}`);
    console.log(`Definitions: ${s.definitions}`);
    console.log(`References:  ${s.references}`);
    console.log(`Index size:  ${formatBytes(s.indexSizeBytes)}`);
    if (s.lastBuilt) {
      console.log(`Last built:  ${s.lastBuilt.toISOString().replace('T', ' ').slice(0, 19)}`);
    }
    db.close();
  });

// files
program
  .command('files <pattern>')
  .description('Find files matching a pattern')
  .action((pattern) => {
    const db = openDb();
    const results = queries.files(db, pattern);
    for (const r of results) console.log(r.relativePath);
    db.close();
  });

// symbols
program
  .command('symbols <file>')
  .description('List symbols defined in a file (with line ranges + signatures)')
  .action((file) => {
    const db = openDb();
    const results = queries.symbols(db, file);
    for (const r of results) {
      const sig = r.signature ? `  — ${r.signature}` : '';
      console.log(`  ${r.startLine}-${r.endLine}  ${r.shortName}${sig}`);
    }
    db.close();
  });

// methods
program
  .command('methods <className>')
  .description('List methods of a class (with line ranges)')
  .action((className) => {
    const db = openDb();
    const results = queries.methods(db, className);
    for (const r of results) {
      console.log(`  ${r.startLine}-${r.endLine}  ${r.name}`);
    }
    db.close();
  });

// refs
program
  .command('refs <symbol>')
  .description('Find all files referencing a symbol')
  .action((symbol) => {
    const db = openDb();
    const results = queries.refs(db, symbol);

    let prevFile = '';
    for (const r of results) {
      if (r.relativePath !== prevFile) {
        if (prevFile) console.log('');
        console.log(r.relativePath);
        prevFile = r.relativePath;
      }
      console.log(`  line ${r.line}`);
    }
    db.close();
  });

// trace
program
  .command('trace <symbol>')
  .description('Trace a symbol: definition + all references')
  .action((symbol) => {
    const db = openDb();
    const result = queries.trace(db, symbol);

    console.log('═══ DEFINITION ═══');
    for (const d of result.definitions) {
      const sig = d.signature ? `  — ${d.signature}` : '';
      console.log(`  ${d.relativePath}:${d.startLine}-${d.endLine}${sig}`);
    }

    console.log('\n═══ REFERENCED BY ═══');
    for (const ref of result.referencedBy) {
      console.log(`  ${ref}`);
    }
    db.close();
  });

// deps
program
  .command('deps <file>')
  .description('Files this file depends on (internal)')
  .action((file) => {
    const db = openDb();
    const results = queries.deps(db, file);
    for (const r of results) console.log(r.relativePath);
    db.close();
  });

// rdeps
program
  .command('rdeps <file>')
  .description('Files that depend on this file/module')
  .action((file) => {
    const db = openDb();
    const results = queries.rdeps(db, file);
    for (const r of results) console.log(r.relativePath);
    db.close();
  });

// system
program
  .command('system <module>')
  .description('Full module map: files, symbols, deps in/out')
  .action((module) => {
    const db = openDb();
    const result = queries.system(db, module);

    console.log('═══ FILES ═══');
    for (const f of result.files) console.log(f);

    console.log('\n═══ EXPORTED SYMBOLS ═══');
    for (const s of result.symbols) {
      console.log(`  ${s.startLine}-${s.endLine}  ${s.shortName}`);
    }

    console.log('\n═══ DEPENDS ON (internal) ═══');
    for (const d of result.dependsOn) console.log(`  ${d}`);

    console.log('\n═══ DEPENDED ON BY ═══');
    for (const d of result.dependedOnBy) console.log(`  ${d}`);

    db.close();
  });

// surface
program
  .command('surface <module>')
  .description('What symbols consumers actually use from this module')
  .action((module) => {
    const db = openDb();
    const results = queries.surface(db, module);
    for (const r of results) {
      console.log(`  ${r.consumer} → ${r.shortName}`);
    }
    db.close();
  });

// dead
program
  .command('dead [scope]')
  .description('Find dead exports (no cross-file consumers)')
  .option('--min-loc <n>', 'Only show symbols >= N lines', parseIntSafe, 1)
  .option('--include-tests', 'Include test files')
  .option('--skip-barrels', 'Ignore refs from barrel re-export files')
  .option('--include-members', 'Include class members')
  .action((scope, opts) => {
    const db = openDb();
    const deadOpts: DeadOptions = {
      scope: scope || undefined,
      minLoc: opts.minLoc,
      includeTests: opts.includeTests,
      skipBarrels: opts.skipBarrels,
      includeMembers: opts.includeMembers,
    };

    const result = queries.dead(db, deadOpts);

    if (result.symbols.length === 0) {
      console.log('No dead exports found.');
      db.close();
      return;
    }

    let prevFile = '';
    for (const s of result.symbols) {
      if (s.relativePath !== prevFile) {
        if (prevFile) console.log('');
        console.log(s.relativePath);
        prevFile = s.relativePath;
      }
      const tag = s.kind === 'dead-code' ? '[dead code]' : '[dead export]';
      console.log(`  ${s.startLine}-${s.endLine}  (${s.loc} LOC)  ${s.shortName}  ${tag}`);
    }

    console.log('\n───────────────────────────');
    console.log(
      `Total: ${result.totalCount} symbols (${result.deadCodeCount} dead code, ` +
      `${result.deadExportCount} dead exports), ${result.totalLoc} LOC`,
    );
    db.close();
  });

// hotspots
program
  .command('hotspots')
  .description('Most-referenced symbols in the codebase (choke points)')
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 30)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((opts) => {
    const db = openDb();
    const results = queries.hotspots(db, { limit: opts.limit, scope: opts.scope });
    console.log('  refs  files  symbol');
    console.log('  ────  ─────  ──────');
    for (const r of results) {
      console.log(`  ${String(r.refCount).padStart(4)}  ${String(r.fileCount).padStart(5)}  ${r.shortName}`);
    }
    db.close();
  });

// imports
program
  .command('imports <file>')
  .description('What symbols does this file import?')
  .action((file) => {
    const db = openDb();
    const results = queries.imports(db, file);
    if (results.length === 0) {
      console.log('No imports found (indexer may not emit role=2 for this language).');
    }
    for (const r of results) {
      console.log(`  ${r.shortName}  ← ${r.fromFile}`);
    }
    db.close();
  });

// imported-by
program
  .command('imported-by <symbol>')
  .description('Which files import this symbol?')
  .action((symbol) => {
    const db = openDb();
    const results = queries.importedBy(db, symbol);
    for (const r of results) {
      console.log(`  ${r.fromFile}`);
    }
    db.close();
  });

// unused-imports
program
  .command('unused-imports <file>')
  .description('Find imports not referenced in the same file')
  .action((file) => {
    const db = openDb();
    const results = queries.unusedImports(db, file);
    if (results.length === 0) {
      console.log('No unused imports found.');
    } else {
      for (const r of results) {
        console.log(`  ${r.shortName}  in ${r.importedIn}`);
      }
      console.log(`\n${results.length} unused import(s)`);
    }
    db.close();
  });

// outline
program
  .command('outline <file>')
  .description('Tree view of symbols in a file (using nesting hierarchy)')
  .action((file) => {
    const db = openDb();
    const roots = queries.outline(db, file);
    function printTree(nodes: typeof roots, indent: number): void {
      for (const n of nodes) {
        const prefix = '  '.repeat(indent);
        console.log(`${prefix}${n.startLine}-${n.endLine}  ${n.shortName}`);
        printTree(n.children, indent + 1);
      }
    }
    printTree(roots, 0);
    db.close();
  });

// members
program
  .command('members <symbol>')
  .description('All children of a symbol (methods, fields, nested types)')
  .action((symbol) => {
    const db = openDb();
    const results = queries.members(db, symbol);
    for (const r of results) {
      console.log(`  ${r.startLine}-${r.endLine}  [${r.kind}]  ${r.shortName}`);
    }
    db.close();
  });

// fan-in
program
  .command('fan-in [symbol]')
  .description('How many files reference a symbol (or top fan-in across codebase)')
  .option('-n, --limit <n>', 'Number of results for top mode', parseIntSafe, 30)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((symbol, opts) => {
    const db = openDb();
    if (symbol) {
      const results = queries.fanIn(db, symbol);
      for (const r of results) {
        console.log(`  ${String(r.count).padStart(4)} files  ${r.name}`);
      }
    } else {
      const results = queries.topFanIn(db, { limit: opts.limit, scope: opts.scope });
      console.log('  files  symbol');
      console.log('  ─────  ──────');
      for (const r of results) {
        console.log(`  ${String(r.count).padStart(5)}  ${r.name}`);
      }
    }
    db.close();
  });

// fan-out
program
  .command('fan-out [file]')
  .description('How many external symbols a file uses (or top fan-out across codebase)')
  .option('-n, --limit <n>', 'Number of results for top mode', parseIntSafe, 30)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((file, opts) => {
    const db = openDb();
    if (file) {
      const results = queries.fanOut(db, file);
      for (const r of results) {
        console.log(`  ${String(r.count).padStart(4)} symbols  ${r.name}`);
      }
    } else {
      const results = queries.topFanOut(db, { limit: opts.limit, scope: opts.scope });
      console.log('  symbols  file');
      console.log('  ───────  ────');
      for (const r of results) {
        console.log(`  ${String(r.count).padStart(7)}  ${r.name}`);
      }
    }
    db.close();
  });

// coupling
program
  .command('coupling [file1] [file2]')
  .description('Coupling between two files, or top coupled pairs in codebase')
  .option('-n, --limit <n>', 'Number of results for top mode', parseIntSafe, 20)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((file1, file2, opts) => {
    const db = openDb();
    if (file1 && file2) {
      const result = queries.coupling(db, file1, file2);
      console.log(`${result.file1} ↔ ${result.file2}: ${result.sharedSymbols} shared symbols`);
    } else {
      const results = queries.topCoupling(db, { limit: opts.limit, scope: opts.scope });
      console.log('  shared  file1 → file2');
      console.log('  ──────  ─────────────');
      for (const r of results) {
        console.log(`  ${String(r.sharedSymbols).padStart(6)}  ${r.file1} → ${r.file2}`);
      }
    }
    db.close();
  });

// cycles
program
  .command('cycles')
  .description('Detect circular dependency chains between files')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--max-depth <n>', 'Maximum cycle depth', parseIntSafe, 10)
  .action((opts) => {
    const db = openDb();
    const results = queries.cycles(db, { scope: opts.scope, maxDepth: opts.maxDepth });
    if (results.length === 0) {
      console.log('No circular dependencies found.');
    } else {
      for (let i = 0; i < results.length; i++) {
        console.log(`\nCycle ${i + 1} (${results[i]!.path.length - 1} files):`);
        for (let j = 0; j < results[i]!.path.length; j++) {
          const arrow = j < results[i]!.path.length - 1 ? ' →' : ' (cycle)';
          console.log(`  ${results[i]!.path[j]}${arrow}`);
        }
      }
      console.log(`\n${results.length} cycle(s) found.`);
    }
    db.close();
  });

// bottlenecks
program
  .command('bottlenecks')
  .description('Find coupling hubs: high fan-in AND high fan-out')
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 20)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-fan-in <n>', 'Minimum fan-in', parseIntSafe, 2)
  .option('--min-fan-out <n>', 'Minimum fan-out', parseIntSafe, 2)
  .action((opts) => {
    const db = openDb();
    const results = queries.bottlenecks(db, {
      limit: opts.limit,
      scope: opts.scope,
      minFanIn: opts.minFanIn,
      minFanOut: opts.minFanOut,
    });
    if (results.length === 0) {
      console.log('No bottlenecks found.');
    } else {
      console.log('  score  fan-in  fan-out  symbol');
      console.log('  ─────  ──────  ───────  ──────');
      for (const r of results) {
        console.log(`  ${String(r.score).padStart(5)}  ${String(r.fanIn).padStart(6)}  ${String(r.fanOut).padStart(7)}  ${r.shortName}`);
      }
    }
    db.close();
  });

// isolated
program
  .command('isolated')
  .description('Find completely orphaned symbols (no references at all)')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum lines of code', parseIntSafe, 3)
  .action((opts) => {
    const db = openDb();
    const results = queries.isolated(db, { scope: opts.scope, minLoc: opts.minLoc });
    if (results.length === 0) {
      console.log('No isolated symbols found.');
    } else {
      let prevFile = '';
      for (const r of results) {
        if (r.relativePath !== prevFile) {
          if (prevFile) console.log('');
          console.log(r.relativePath);
          prevFile = r.relativePath;
        }
        console.log(`  ${r.startLine}-${r.endLine}  (${r.loc} LOC)  ${r.shortName}`);
      }
      console.log(`\n${results.length} isolated symbol(s)`);
    }
    db.close();
  });

// by-kind
program
  .command('by-kind <kind>')
  .description('Find symbols by SCIP kind (class, interface, enum, function, etc.)')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 100)
  .action((kind, opts) => {
    const db = openDb();
    const results = queries.byKind(db, kind, { scope: opts.scope, limit: opts.limit });
    if (results.length === 0) {
      console.log(`No symbols found for kind "${kind}". Use "kind-counts" to see available kinds.`);
    } else {
      for (const r of results) {
        console.log(`  ${r.relativePath}:${r.startLine}-${r.endLine}  [${r.kindName}]  ${r.shortName}`);
      }
      console.log(`\n${results.length} symbol(s)`);
    }
    db.close();
  });

// kind-counts
program
  .command('kind-counts')
  .description('Histogram of symbol kinds in the codebase')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((opts) => {
    const db = openDb();
    const results = queries.kindCounts(db, { scope: opts.scope });
    console.log('  count  kind');
    console.log('  ─────  ────');
    for (const r of results) {
      console.log(`  ${String(r.count).padStart(5)}  ${r.kindName} (${r.kind})`);
    }
    db.close();
  });

// test-coverage
program
  .command('test-coverage [symbol]')
  .description('Check if symbols are referenced by test files')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum LOC for summary mode', parseIntSafe, 3)
  .action((symbol, opts) => {
    const db = openDb();
    if (symbol) {
      const results = queries.testCoverage(db, symbol);
      for (const r of results) {
        const status = r.covered ? 'covered' : 'NOT COVERED';
        console.log(`  [${status}]  ${r.shortName}  (${r.definedIn})`);
        for (const tf of r.testFiles) {
          console.log(`    ← ${tf}`);
        }
      }
    } else {
      const summary = queries.testCoverageSummary(db, { scope: opts.scope, minLoc: opts.minLoc });
      console.log(`Test coverage: ${summary.percent}%`);
      console.log(`  Total symbols:  ${summary.total}`);
      console.log(`  Covered:        ${summary.covered}`);
      console.log(`  Not covered:    ${summary.uncovered}`);
    }
    db.close();
  });

// doc-coverage
program
  .command('doc-coverage')
  .description('Check documentation coverage across symbols')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum LOC to consider', parseIntSafe, 3)
  .option('-n, --limit <n>', 'Max undocumented symbols to show', parseIntSafe, 50)
  .action((opts) => {
    const db = openDb();
    const result = queries.docCoverage(db, {
      scope: opts.scope,
      minLoc: opts.minLoc,
      limit: opts.limit,
    });
    console.log(`Documentation coverage: ${result.coveragePercent}%`);
    console.log(`  Total symbols:   ${result.totalSymbols}`);
    console.log(`  Documented:      ${result.documented}`);
    console.log(`  Undocumented:    ${result.undocumented}`);
    if (result.undocumentedSymbols.length > 0) {
      console.log('\nUndocumented:');
      for (const s of result.undocumentedSymbols) {
        console.log(`  ${s.relativePath}:${s.startLine}  ${s.shortName}`);
      }
    }
    db.close();
  });

// deep-chains
program
  .command('deep-chains')
  .description('Find the longest transitive dependency chains')
  .option('-n, --limit <n>', 'Number of chains to show', parseIntSafe, 10)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-depth <n>', 'Minimum chain depth', parseIntSafe, 3)
  .action((opts) => {
    const db = openDb();
    const results = queries.deepChains(db, {
      limit: opts.limit,
      scope: opts.scope,
      minDepth: opts.minDepth,
    });
    if (results.length === 0) {
      console.log('No deep chains found.');
    } else {
      for (let i = 0; i < results.length; i++) {
        console.log(`\nChain ${i + 1} (depth ${results[i]!.depth}):`);
        for (const file of results[i]!.chain) {
          console.log(`  → ${file}`);
        }
      }
    }
    db.close();
  });

// hierarchy
program
  .command('hierarchy <symbol>')
  .description('Show a symbol\'s ancestry chain (method → class → module)')
  .action((symbol) => {
    const db = openDb();
    const chain = queries.hierarchy(db, symbol);
    if (chain.length === 0) {
      console.log('Symbol not found.');
    } else {
      for (const node of chain) {
        const indent = '  '.repeat(node.depth);
        console.log(`${indent}${node.shortName}`);
      }
    }
    db.close();
  });

// call-graph
program
  .command('call-graph <symbol>')
  .description('Show incoming callers and outgoing callees for a symbol')
  .action((symbol) => {
    const db = openDb();
    const result = queries.callGraph(db, symbol);
    if (!result) {
      console.log('Symbol not found.');
      db.close();
      return;
    }
    console.log(`Symbol: ${result.shortName}\n`);
    console.log(`═══ CALLERS (${result.callers.length}) ═══`);
    for (const c of result.callers) {
      console.log(`  ${c.file}  ${c.shortName}`);
    }
    console.log(`\n═══ CALLEES (${result.callees.length}) ═══`);
    for (const c of result.callees) {
      console.log(`  ${c.file}  ${c.shortName}`);
    }
    db.close();
  });

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

    console.log(`Project:  ${projectRoot}`);
    console.log(`DB path:  ${paths.dbPath}`);
    console.log(`Exists:   ${existsSync(paths.dbPath) ? 'yes' : 'no'}`);

    if (existsSync(paths.dbPath)) {
      const db = openDb();
      const s = queries.stats(db);
      console.log(`Symbols:  ${s.symbols}`);
      console.log(`Files:    ${s.documents}`);
      console.log(`Size:     ${formatBytes(s.indexSizeBytes)}`);
      if (s.lastBuilt) {
        const ago = Math.round((Date.now() - s.lastBuilt.getTime()) / 1000);
        console.log(`Built:    ${ago}s ago`);
      }
      db.close();
    }
  });

// ── Parse & Run ────────────────────────────────────────────

program.parse();

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
