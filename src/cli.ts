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
import { installSkills, isScipInstalled, printScipInstallInstructions } from './setup.js';

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

function withDb(run: (db: ScipDatabase) => void): void {
  const db = openDb();
  try {
    run(db);
  } finally {
    db.close();
  }
}

function runQuery<T>(
  query: (db: ScipDatabase) => T,
  render: (result: T) => void,
): void {
  withDb((db) => {
    render(query(db));
  });
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
    runQuery(
      (db) => queries.stats(db),
      (s) => {
        console.log(`Documents:   ${s.documents}`);
        console.log(`Symbols:     ${s.symbols}`);
        console.log(`Definitions: ${s.definitions}`);
        console.log(`References:  ${s.references}`);
        console.log(`Index size:  ${formatBytes(s.indexSizeBytes)}`);
        if (s.lastBuilt) {
          console.log(`Last built:  ${s.lastBuilt.toISOString().replace('T', ' ').slice(0, 19)}`);
        }
      },
    );
  });

// files
program
  .command('files <pattern>')
  .description('Find files matching a pattern')
  .action((pattern) => {
    runQuery(
      (db) => queries.files(db, pattern),
      (results) => {
        for (const r of results) console.log(r.relativePath);
      },
    );
  });

// symbols
program
  .command('symbols <file>')
  .description('List symbols defined in a file (with line ranges + signatures)')
  .action((file) => {
    runQuery(
      (db) => queries.symbols(db, file),
      (results) => {
        for (const r of results) {
          const sig = r.signature ? `  — ${r.signature}` : '';
          console.log(`  ${r.startLine}-${r.endLine}  ${r.shortName}${sig}`);
        }
      },
    );
  });

// methods
program
  .command('methods <className>')
  .description('List methods of a class (with line ranges)')
  .action((className) => {
    runQuery(
      (db) => queries.methods(db, className),
      (results) => {
        for (const r of results) {
          console.log(`  ${r.startLine}-${r.endLine}  ${r.name}`);
        }
      },
    );
  });

// refs
program
  .command('refs <symbol>')
  .description('Find all files referencing a symbol')
  .action((symbol) => {
    runQuery(
      (db) => queries.refs(db, symbol),
      (results) => {
        let prevFile = '';
        for (const r of results) {
          if (r.relativePath !== prevFile) {
            if (prevFile) console.log('');
            console.log(r.relativePath);
            prevFile = r.relativePath;
          }
          console.log(`  line ${r.line}`);
        }
      },
    );
  });

// trace
program
  .command('trace <symbol>')
  .description('Trace a symbol: definition + all references')
  .action((symbol) => {
    runQuery(
      (db) => queries.trace(db, symbol),
      (result) => {
        console.log('═══ DEFINITION ═══');
        for (const d of result.definitions) {
          const sig = d.signature ? `  — ${d.signature}` : '';
          console.log(`  ${d.relativePath}:${d.startLine}-${d.endLine}${sig}`);
        }

        console.log('\n═══ REFERENCED BY ═══');
        for (const ref of result.referencedBy) {
          console.log(`  ${ref}`);
        }
      },
    );
  });

// deps
program
  .command('deps <file>')
  .description('Files this file depends on (internal)')
  .action((file) => {
    runQuery(
      (db) => queries.deps(db, file),
      (results) => {
        for (const r of results) console.log(r.relativePath);
      },
    );
  });

// rdeps
program
  .command('rdeps <file>')
  .description('Files that depend on this file/module')
  .action((file) => {
    runQuery(
      (db) => queries.rdeps(db, file),
      (results) => {
        for (const r of results) console.log(r.relativePath);
      },
    );
  });

// system
program
  .command('system <module>')
  .description('Full module map: files, symbols, deps in/out')
  .action((module) => {
    runQuery(
      (db) => queries.system(db, module),
      (result) => {
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
      },
    );
  });

// surface
program
  .command('surface <module>')
  .description('What symbols consumers actually use from this module')
  .action((module) => {
    runQuery(
      (db) => queries.surface(db, module),
      (results) => {
        for (const r of results) {
          console.log(`  ${r.consumer} → ${r.shortName}`);
        }
      },
    );
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
    withDb((db) => {
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
    });
  });

// hotspots
program
  .command('hotspots')
  .description('Most-referenced symbols in the codebase (choke points)')
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 30)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((opts) => {
    runQuery(
      (db) => queries.hotspots(db, { limit: opts.limit, scope: opts.scope }),
      (results) => {
        console.log('  refs  files  symbol');
        console.log('  ────  ─────  ──────');
        for (const r of results) {
          console.log(`  ${String(r.refCount).padStart(4)}  ${String(r.fileCount).padStart(5)}  ${r.shortName}`);
        }
      },
    );
  });

// imports
program
  .command('imports <file>')
  .description('What symbols does this file import?')
  .action((file) => {
    runQuery(
      (db) => queries.imports(db, file),
      (results) => {
        if (results.length === 0) {
          console.log('No imports found (indexer may not emit role=2 for this language).');
        }
        for (const r of results) {
          console.log(`  ${r.shortName}  ← ${r.fromFile}`);
        }
      },
    );
  });

// imported-by
program
  .command('imported-by <symbol>')
  .description('Which files import this symbol?')
  .action((symbol) => {
    runQuery(
      (db) => queries.importedBy(db, symbol),
      (results) => {
        for (const r of results) {
          console.log(`  ${r.fromFile}`);
        }
      },
    );
  });

// unused-imports
program
  .command('unused-imports <file>')
  .description('Find imports not referenced in the same file')
  .action((file) => {
    runQuery(
      (db) => queries.unusedImports(db, file),
      (results) => {
        if (results.length === 0) {
          console.log('No unused imports found.');
        } else {
          for (const r of results) {
            console.log(`  ${r.shortName}  in ${r.importedIn}`);
          }
          console.log(`\n${results.length} unused import(s)`);
        }
      },
    );
  });

// outline
program
  .command('outline <file>')
  .description('Tree view of symbols in a file (using nesting hierarchy)')
  .action((file) => {
    runQuery(
      (db) => queries.outline(db, file),
      (roots) => {
        function printTree(nodes: typeof roots, indent: number): void {
          for (const n of nodes) {
            const prefix = '  '.repeat(indent);
            console.log(`${prefix}${n.startLine}-${n.endLine}  ${n.shortName}`);
            printTree(n.children, indent + 1);
          }
        }
        printTree(roots, 0);
      },
    );
  });

// members
program
  .command('members <symbol>')
  .description('All children of a symbol (methods, fields, nested types)')
  .action((symbol) => {
    runQuery(
      (db) => queries.members(db, symbol),
      (results) => {
        for (const r of results) {
          console.log(`  ${r.startLine}-${r.endLine}  [${r.kind}]  ${r.shortName}`);
        }
      },
    );
  });

// fan-in
program
  .command('fan-in [symbol]')
  .description('How many files reference a symbol (or top fan-in across codebase)')
  .option('-n, --limit <n>', 'Number of results for top mode', parseIntSafe, 30)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((symbol, opts) => {
    withDb((db) => {
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
    });
  });

// fan-out
program
  .command('fan-out [file]')
  .description('How many external symbols a file uses (or top fan-out across codebase)')
  .option('-n, --limit <n>', 'Number of results for top mode', parseIntSafe, 30)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((file, opts) => {
    withDb((db) => {
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
    });
  });

// coupling
program
  .command('coupling [file1] [file2]')
  .description('Coupling between two files, or top coupled pairs in codebase')
  .option('-n, --limit <n>', 'Number of results for top mode', parseIntSafe, 20)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((file1, file2, opts) => {
    withDb((db) => {
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
    });
  });

// cycles
program
  .command('cycles')
  .description('Detect circular dependency chains between files')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--max-depth <n>', 'Maximum cycle depth', parseIntSafe, 10)
  .action((opts) => {
    runQuery(
      (db) => queries.cycles(db, { scope: opts.scope, maxDepth: opts.maxDepth }),
      (results) => {
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
      },
    );
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
    runQuery(
      (db) => queries.bottlenecks(db, {
        limit: opts.limit,
        scope: opts.scope,
        minFanIn: opts.minFanIn,
        minFanOut: opts.minFanOut,
      }),
      (results) => {
        if (results.length === 0) {
          console.log('No bottlenecks found.');
        } else {
          console.log('  score  fan-in  fan-out  symbol');
          console.log('  ─────  ──────  ───────  ──────');
          for (const r of results) {
            console.log(`  ${String(r.score).padStart(5)}  ${String(r.fanIn).padStart(6)}  ${String(r.fanOut).padStart(7)}  ${r.shortName}`);
          }
        }
      },
    );
  });

// isolated
program
  .command('isolated')
  .description('Find completely orphaned symbols (no references at all)')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum lines of code', parseIntSafe, 3)
  .action((opts) => {
    runQuery(
      (db) => queries.isolated(db, { scope: opts.scope, minLoc: opts.minLoc }),
      (results) => {
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
      },
    );
  });

// by-kind
program
  .command('by-kind <kind>')
  .description('Find symbols by SCIP kind (class, interface, enum, function, etc.)')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 100)
  .action((kind, opts) => {
    runQuery(
      (db) => queries.byKind(db, kind, { scope: opts.scope, limit: opts.limit }),
      (results) => {
        if (results.length === 0) {
          console.log(`No symbols found for kind "${kind}". Use "kind-counts" to see available kinds.`);
        } else {
          for (const r of results) {
            console.log(`  ${r.relativePath}:${r.startLine}-${r.endLine}  [${r.kindName}]  ${r.shortName}`);
          }
          console.log(`\n${results.length} symbol(s)`);
        }
      },
    );
  });

// kind-counts
program
  .command('kind-counts')
  .description('Histogram of symbol kinds in the codebase')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((opts) => {
    runQuery(
      (db) => queries.kindCounts(db, { scope: opts.scope }),
      (results) => {
        console.log('  count  kind');
        console.log('  ─────  ────');
        for (const r of results) {
          console.log(`  ${String(r.count).padStart(5)}  ${r.kindName} (${r.kind})`);
        }
      },
    );
  });

// test-coverage
program
  .command('test-coverage [symbol]')
  .description('Check if symbols are referenced by test files')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum LOC for summary mode', parseIntSafe, 3)
  .action((symbol, opts) => {
    withDb((db) => {
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
    });
  });

// doc-coverage
program
  .command('doc-coverage')
  .description('Check documentation coverage across symbols')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum LOC to consider', parseIntSafe, 3)
  .option('-n, --limit <n>', 'Max undocumented symbols to show', parseIntSafe, 50)
  .action((opts) => {
    runQuery(
      (db) => queries.docCoverage(db, {
        scope: opts.scope,
        minLoc: opts.minLoc,
        limit: opts.limit,
      }),
      (result) => {
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
      },
    );
  });

// deep-chains
program
  .command('deep-chains')
  .description('Find the longest transitive dependency chains')
  .option('-n, --limit <n>', 'Number of chains to show', parseIntSafe, 10)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-depth <n>', 'Minimum chain depth', parseIntSafe, 3)
  .action((opts) => {
    runQuery(
      (db) => queries.deepChains(db, {
        limit: opts.limit,
        scope: opts.scope,
        minDepth: opts.minDepth,
      }),
      (results) => {
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
      },
    );
  });

// hierarchy
program
  .command('hierarchy <symbol>')
  .description('Show a symbol\'s ancestry chain (method → class → module)')
  .action((symbol) => {
    runQuery(
      (db) => queries.hierarchy(db, symbol),
      (chain) => {
        if (chain.length === 0) {
          console.log('Symbol not found.');
        } else {
          for (const node of chain) {
            const indent = '  '.repeat(node.depth);
            console.log(`${indent}${node.shortName}`);
          }
        }
      },
    );
  });

// call-graph
program
  .command('call-graph <symbol>')
  .description('Show incoming callers and outgoing callees for a symbol')
  .action((symbol) => {
    runQuery(
      (db) => queries.callGraph(db, symbol),
      (result) => {
        if (!result) {
          console.log('Symbol not found.');
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
      },
    );
  });

// similar
program
  .command('similar [symbol]')
  .description('Find functions with similar callee fingerprints (consolidation candidates)')
  .option('--min-similarity <n>', 'Minimum Jaccard similarity (0-1)', parseFloat, 0.4)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 20)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-callees <n>', 'Minimum callees to consider', parseIntSafe, 4)
  .action((symbol, opts) => {
    withDb((db) => {
      if (symbol) {
        const results = queries.similar(db, symbol, {
          minSimilarity: opts.minSimilarity,
          limit: opts.limit,
        });
        if (results.length === 0) {
          console.log('No similar symbols found.');
        } else {
          for (const r of results) {
            console.log(`\n${Math.round(r.similarity * 100)}% similar:`);
            console.log(`  A: ${r.shortNameA}  (${r.fileA})`);
            console.log(`  B: ${r.shortNameB}  (${r.fileB})`);
            console.log(`  Shared callees: ${r.sharedCallees.join(', ')}`);
            if (r.uniqueToA.length) console.log(`  Only in A: ${r.uniqueToA.join(', ')}`);
            if (r.uniqueToB.length) console.log(`  Only in B: ${r.uniqueToB.join(', ')}`);
          }
        }
      } else {
        const results = queries.similarAll(db, {
          minSimilarity: opts.minSimilarity,
          limit: opts.limit,
          scope: opts.scope,
          minCallees: opts.minCallees,
        });
        if (results.length === 0) {
          console.log('No similar symbol pairs found.');
        } else {
          for (const r of results) {
            console.log(`\n${Math.round(r.similarity * 100)}% similar:`);
            console.log(`  A: ${r.shortNameA}  (${r.fileA})`);
            console.log(`  B: ${r.shortNameB}  (${r.fileB})`);
            console.log(`  Shared: ${r.sharedCallees.join(', ')}`);
          }
          console.log(`\n${results.length} similar pair(s) found.`);
        }
      }
    });
  });

// similar-files
program
  .command('similar-files [file]')
  .description('Find files with similar dependency profiles')
  .option('--min-similarity <n>', 'Minimum Jaccard similarity (0-1)', parseFloat, 0.5)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 20)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-deps <n>', 'Minimum dependencies to consider', parseIntSafe, 3)
  .action((file, opts) => {
    runQuery(
      (db) => queries.similarFiles(db, {
        minSimilarity: opts.minSimilarity,
        limit: opts.limit,
        scope: opts.scope,
        minDeps: opts.minDeps,
        filePattern: file,
      }),
      (results) => {
        if (results.length === 0) {
          console.log('No similar file pairs found.');
        } else {
          for (const r of results) {
            console.log(`\n${Math.round(r.similarity * 100)}% similar:`);
            console.log(`  ${r.fileA}`);
            console.log(`  ${r.fileB}`);
            console.log(`  Shared deps (${r.sharedDeps.length}): ${r.sharedDeps.join(', ')}`);
            if (r.uniqueToA.length) console.log(`  Only in first:  ${r.uniqueToA.join(', ')}`);
            if (r.uniqueToB.length) console.log(`  Only in second: ${r.uniqueToB.join(', ')}`);
          }
          console.log(`\n${results.length} similar pair(s) found.`);
        }
      },
    );
  });

// similar-chains
program
  .command('similar-chains')
  .description('Find end-to-end dependency flows that diverge at few points')
  .option('--min-similarity <n>', 'Minimum chain similarity (0-1)', parseFloat, 0.5)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 15)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-length <n>', 'Minimum chain length', parseIntSafe, 3)
  .option('--max-length <n>', 'Maximum chain length', parseIntSafe, 8)
  .action((opts) => {
    runQuery(
      (db) => queries.similarChains(db, {
        minSimilarity: opts.minSimilarity,
        limit: opts.limit,
        scope: opts.scope,
        minChainLength: opts.minLength,
        maxChainLength: opts.maxLength,
      }),
      (results) => {
        if (results.length === 0) {
          console.log('No similar chains found.');
        } else {
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
        }
      },
    );
  });

// extract-candidates
program
  .command('extract-candidates')
  .description('Find functions with natural extraction seams (isolated callee clusters)')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum function LOC', parseIntSafe, 10)
  .option('--min-callees <n>', 'Minimum callees to analyze', parseIntSafe, 6)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 20)
  .action((opts) => {
    runQuery(
      (db) => queries.extractCandidates(db, {
        scope: opts.scope,
        minLoc: opts.minLoc,
        minCallees: opts.minCallees,
        limit: opts.limit,
      }),
      (results) => {
        if (results.length === 0) {
          console.log('No extraction candidates found.');
        } else {
          for (const r of results) {
            console.log(`\n${r.relativePath}:${r.startLine}-${r.endLine}  ${r.shortName}  (${r.loc} LOC, ${r.totalCallees} callees)`);
            for (let i = 0; i < r.clusters.length; i++) {
              const c = r.clusters[i]!;
              console.log(`  Cluster ${i + 1} (${Math.round(c.isolation * 100)}% isolated, ${c.callees.length} callees):`);
              for (const callee of c.callees) {
                console.log(`    ${callee}`);
              }
            }
          }
          console.log(`\n${results.length} extraction candidate(s) found.`);
        }
      },
    );
  });

// affected
program
  .command('affected <symbol>')
  .description('Transitive closure of symbols that could break if this symbol changes')
  .option('--max-depth <n>', 'Maximum traversal depth', parseIntSafe, 5)
  .option('-s, --scope <path>', 'Limit to files matching path')
  .action((symbol, opts) => {
    const db = openDb();
    const results = queries.affected(db, symbol, { maxDepth: opts.maxDepth, scope: opts.scope });
    if (results.length === 0) {
      console.log('No affected symbols found.');
    } else {
      let prevDepth = -1;
      for (const r of results) {
        if (r.depth !== prevDepth) {
          console.log(`\n  ── Depth ${r.depth} ──`);
          prevDepth = r.depth;
        }
        console.log(`  ${r.file}  ${r.shortName}`);
      }
      console.log(`\n${results.length} affected symbol(s) across ${new Set(results.map((r) => r.file)).size} files.`);
    }
    db.close();
  });

// change-surface
program
  .command('change-surface <file>')
  .description('Pre-change briefing: exports, consumers, test coverage, risk')
  .action((file) => {
    const db = openDb();
    const result = queries.changeSurface(db, file);
    if (!result) {
      console.log('File not found in index.');
      db.close();
      return;
    }
    console.log(`File: ${result.file}`);
    console.log(`Test coverage: ${result.testCoveragePercent}% | External consumers: ${result.totalExternalConsumers}\n`);
    for (const s of result.symbols) {
      const risk = s.riskLevel === 'high' ? ' *** HIGH RISK ***' : s.riskLevel === 'medium' ? ' * medium risk *' : '';
      const tests = s.testFiles.length > 0 ? ` (${s.testFiles.length} test file(s))` : ' (no tests)';
      console.log(`  ${s.startLine}-${s.endLine}  ${s.shortName}  [${s.externalConsumers} consumers]${tests}${risk}`);
    }
    db.close();
  });

// diff-impact
program
  .command('diff-impact')
  .description('Compute affected symbols from current git diff')
  .option('--base <ref>', 'Git ref to diff against (default: HEAD)')
  .action((opts) => {
    const db = openDb();
    const result = queries.diffImpact(db, { base: opts.base });
    console.log(`Changed files: ${result.summary.totalChangedFiles}`);
    console.log(`Changed symbols: ${result.summary.totalChangedSymbols}`);
    console.log(`Affected consumer files: ${result.summary.totalAffectedFiles}`);
    console.log(`Test coverage: ${result.summary.testCoveragePercent}%\n`);
    if (result.changedSymbols.length > 0) {
      console.log('Changed symbols:');
      for (const s of result.changedSymbols) {
        console.log(`  ${s.file}  ${s.shortName}  (fan-in: ${s.fanIn})`);
      }
    }
    if (result.uncoveredSymbols.length > 0) {
      console.log('\nUncovered (no test references):');
      for (const s of result.uncoveredSymbols) {
        console.log(`  ${s.file}  ${s.shortName}`);
      }
    }
    if (result.affectedConsumers.length > 0) {
      console.log('\nAffected consumer files:');
      for (const c of result.affectedConsumers) {
        console.log(`  ${c.file}  (${c.consumedSymbols} symbol(s))`);
      }
    }
    db.close();
  });

// drift
program
  .command('drift [module]')
  .description('Detect files that deviate from their directory\'s typical dependency pattern')
  .option('--min-deviation <n>', 'Minimum deviation % to report', parseIntSafe, 30)
  .action((module, opts) => {
    const db = openDb();
    const results = queries.drift(db, { scope: module, minDeviation: opts.minDeviation });
    if (results.length === 0) {
      console.log('No pattern drift detected.');
    } else {
      for (const r of results) {
        console.log(`\n${r.file}  (${r.deviationPercent}% deviation from ${r.directory})`);
        if (r.missingExpectedDeps.length) console.log(`  Missing expected: ${r.missingExpectedDeps.join(', ')}`);
        if (r.unexpectedDeps.length) console.log(`  Unexpected:       ${r.unexpectedDeps.join(', ')}`);
      }
      console.log(`\n${results.length} drifted file(s) found.`);
    }
    db.close();
  });

// wrapper-candidates
program
  .command('wrapper-candidates')
  .description('Find symbols only called by one consumer (premature abstractions)')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--max-loc <n>', 'Maximum LOC for candidates', parseIntSafe, 15)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 30)
  .action((opts) => {
    const db = openDb();
    const results = queries.wrapperCandidates(db, { scope: opts.scope, maxLoc: opts.maxLoc, limit: opts.limit });
    if (results.length === 0) {
      console.log('No wrapper candidates found.');
    } else {
      for (const r of results) {
        console.log(`  ${r.file}:${r.startLine}-${r.endLine}  ${r.shortName}  (${r.loc} LOC)`);
        console.log(`    Only called by: ${r.singleCallerShort}  (fan-in: ${r.callerFanIn})`);
      }
      console.log(`\n${results.length} wrapper candidate(s).`);
    }
    db.close();
  });

// passthrough-candidates
program
  .command('passthrough-candidates')
  .description('Find functions that just forward to one other function')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--max-loc <n>', 'Maximum LOC for candidates', parseIntSafe, 15)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 30)
  .action((opts) => {
    const db = openDb();
    const results = queries.passthroughCandidates(db, { scope: opts.scope, maxLoc: opts.maxLoc, limit: opts.limit });
    if (results.length === 0) {
      console.log('No passthrough candidates found.');
    } else {
      for (const r of results) {
        console.log(`  ${r.file}:${r.startLine}-${r.endLine}  ${r.shortName}  (${r.loc} LOC)`);
        console.log(`    Forwards to: ${r.forwardsToShort}  (${r.forwardsToFile})`);
      }
      console.log(`\n${results.length} passthrough candidate(s).`);
    }
    db.close();
  });

// stale-abstractions
program
  .command('stale-abstractions')
  .description('Find types/interfaces with 0-1 consumers (premature abstractions)')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum LOC', parseIntSafe, 3)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 30)
  .action((opts) => {
    const db = openDb();
    const results = queries.staleAbstractions(db, { scope: opts.scope, minLoc: opts.minLoc, limit: opts.limit });
    if (results.length === 0) {
      console.log('No stale abstractions found.');
    } else {
      for (const r of results) {
        const label = r.consumers === 0 ? 'unused' : '1 consumer';
        console.log(`  ${r.file}:${r.startLine}-${r.endLine}  ${r.shortName}  (${r.loc} LOC, ${label})`);
      }
      console.log(`\n${results.length} stale abstraction(s).`);
    }
    db.close();
  });

// complexity-hotspots
program
  .command('complexity-hotspots')
  .description('Composite complexity score: LOC x fan-in x fan-out')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--min-loc <n>', 'Minimum LOC', parseIntSafe, 10)
  .option('-n, --limit <n>', 'Number of results', parseIntSafe, 20)
  .action((opts) => {
    const db = openDb();
    const results = queries.complexityHotspots(db, { scope: opts.scope, minLoc: opts.minLoc, limit: opts.limit });
    if (results.length === 0) {
      console.log('No complexity hotspots found.');
    } else {
      console.log('  score   LOC  fan-in  fan-out  callees  symbol');
      console.log('  ─────  ────  ──────  ───────  ───────  ──────');
      for (const r of results) {
        console.log(`  ${r.score.toFixed(1).padStart(5)}  ${String(r.loc).padStart(4)}  ${String(r.fanIn).padStart(6)}  ${String(r.fanOut).padStart(7)}  ${String(r.calleeCount).padStart(7)}  ${r.shortName}`);
      }
    }
    db.close();
  });

// health
program
  .command('health')
  .description('Composite codebase health report with prioritized action list')
  .option('-s, --scope <path>', 'Limit to files matching path')
  .option('--json', 'Output as JSON for programmatic consumption')
  .action((opts) => {
    const db = openDb();
    const report = queries.health(db, { scope: opts.scope });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
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
    }
    db.close();
  });

// convergence
program
  .command('convergence <symbol1> <symbol2>')
  .description('Show what a consolidated version of two similar functions would look like')
  .action((symbol1, symbol2) => {
    const db = openDb();
    const result = queries.convergence(db, symbol1, symbol2);
    if (!result) {
      console.log('One or both symbols not found.');
      db.close();
      return;
    }
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
    db.close();
  });

// code
program
  .command('code <symbol>')
  .description('Read the source code for a symbol (bounded to its definition range)')
  .option('-C, --context <n>', 'Extra lines of context above/below', parseIntSafe, 0)
  .action((symbol, opts) => {
    const db = openDb();
    const result = queries.code(db, symbol, { context: opts.context });
    if (!result) {
      console.log('Symbol not found or file unreadable.');
      db.close();
      return;
    }
    console.log(`${result.relativePath}:${result.startLine}-${result.endLine}  ${result.shortName}  [${result.language ?? 'unknown'}]\n`);
    const lines = result.source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      console.log(`  ${String(result.startLine + i).padStart(4)}  ${lines[i]}`);
    }
    db.close();
  });

// complexity
program
  .command('complexity <symbol>')
  .description('Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees')
  .action((symbol) => {
    const db = openDb();
    const result = queries.complexity(db, symbol);
    if (!result) {
      console.log('Symbol not found.');
      db.close();
      return;
    }
    console.log(`${result.relativePath}:${result.startLine}-${result.endLine}  ${result.shortName}\n`);
    console.log(`  LOC:                  ${result.loc}`);
    console.log(`  Branches:             ${result.branches}`);
    console.log(`  Cyclomatic estimate:  ${result.cyclomaticEstimate}`);
    console.log(`  Callees:              ${result.calleeCount}`);
    console.log(`  Fan-in:               ${result.fanIn}`);
    console.log(`  Fan-out:              ${result.fanOut}`);
    db.close();
  });

// dataflow
program
  .command('dataflow <symbol>')
  .description('Reference-level dataflow: definition sites, usage sites, producers, consumers')
  .action((symbol) => {
    const db = openDb();
    const result = queries.dataflow(db, symbol);
    if (!result) {
      console.log('Symbol not found.');
      db.close();
      return;
    }
    console.log(`${result.shortName}  (${result.relativePath})\n`);

    if (result.definitionSites.length > 0) {
      console.log('  ═══ DEFINED AT ═══');
      for (const s of result.definitionSites) {
        console.log(`    ${s.file}:${s.line}`);
      }
    }

    if (result.usageSites.length > 0) {
      console.log('\n  ═══ USED AT ═══');
      for (const s of result.usageSites) {
        console.log(`    ${s.file}:${s.line}  in ${s.enclosingShort}`);
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
    db.close();
  });

// slice
program
  .command('slice <symbol>')
  .description('Reference-level program slice: what affects this (backward) or what this affects (forward)')
  .option('--forward', 'Forward slice (what does this affect). Default is backward.')
  .action((symbol, opts) => {
    const db = openDb();
    const direction = opts.forward ? 'forward' : 'backward';
    const result = queries.slice(db, symbol, { direction });
    if (!result) {
      console.log('Symbol not found.');
      db.close();
      return;
    }
    console.log(`${result.direction} slice of ${result.shortName}\n`);
    if (result.connectedSymbols.length === 0) {
      console.log('  No connected symbols found.');
    } else {
      for (const s of result.connectedSymbols) {
        console.log(`  ${s.file}  ${s.shortName}`);
        console.log(`    ${s.relationship}`);
      }
      console.log(`\n${result.connectedSymbols.length} connected symbol(s).`);
    }
    db.close();
  });

// install-skills
program
  .command('install-skills')
  .description('Install skills into Claude Code (~/.claude/skills/) and Codex (~/.codex/skills/)')
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
  .description('Check if required dependencies (scip CLI) are installed')
  .action(() => {
    if (isScipInstalled()) {
      console.log('scip CLI: installed');
    } else {
      printScipInstallInstructions();
    }
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
