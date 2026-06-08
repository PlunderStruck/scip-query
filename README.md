# scip-query

Language-agnostic code intelligence CLI powered by [SCIP](https://github.com/sourcegraph/scip) indexes. Index a codebase once, then ask direct questions about symbols, references, dependencies, dead code, similarity, coupling, impact, and health without keeping an IDE or language server running.

Works with every language that has a SCIP indexer: TypeScript, JavaScript, Vue, Java, Scala, Kotlin, Rust, Python, Ruby, Go, C/C++, C#, Visual Basic, Dart, PHP.

## Purpose

`scip-query` exists to make codebase understanding operational. A large codebase is a collection of source files, symbols, and dependency paths that people need to change without accidentally breaking users. This project turns compiler-produced code intelligence into terminal commands that answer the questions engineers and agents ask before they edit:

- What is defined here?
- Who uses this symbol?
- What depends on this file?
- What changes if I modify this API?
- Which cleanup findings are backed by real reference evidence?
- Where is the architecture drifting, duplicating work, or hiding complexity?

The vision is a reliable code-intelligence layer for both humans and coding agents: fast enough to use during ordinary development, accurate enough to trust for planning, and explicit about confidence when an analysis moves beyond compiler-backed facts.

## Problems It Solves

- **Navigation without IDE state.** Query definitions, references, outlines, members, call graphs, and source snippets from a terminal or automation loop.
- **Change planning.** Use `affected`, `change-surface`, and `diff-impact` to identify downstream consumers before and after a change.
- **Architecture visibility.** Use `deps`, `rdeps`, `system`, `surface`, `coupling`, `cycles`, and `deep-chains` to see how modules actually relate.
- **Codebase cleanup.** Use `dead`, `stale-abstractions`, `wrapper-candidates`, `passthrough-candidates`, `similar`, `similar-signatures`, `extract-candidates`, and `drift` to find removal or consolidation opportunities.
- **Health reporting.** Use `health` to aggregate cleanup signals into one prioritized report instead of running dozens of commands by hand.
- **Agent workflows.** Install the bundled Codex/Claude skills so agents can explore, plan, de-bloat, and verify changes with a consistent command vocabulary.

## Accuracy Model

A SCIP index is a database-shaped record of code facts produced by language-aware indexers: the source files they read, the symbols they define, and the references they resolve. Because these facts come from compilers, type checkers, or language servers, direct definition and reference queries are much stronger evidence than text search.

`scip-query` separates three kinds of evidence:

- **Compiler-backed facts** come from the SCIP database. Commands like `symbols`, `refs`, `trace`, `deps`, `rdeps`, `surface`, and most symbol-level counts start here.
- **Semantic augmentation** adds language-specific checks when available. TypeScript projects use `ts-morph` to verify references, import usage, callers, callees, and signatures when SCIP alone is incomplete.
- **Source-backed heuristics** use parsed source text or ASTs to keep higher-level cleanup commands useful when an indexer omits call-site details. These findings are designed as investigation leads, not blind deletion instructions.

The goal is not to replace compiler facts with regexes. The goal is to use the strongest available evidence first, fall back only when needed, and keep cleanup commands conservative enough that speed does not trade away accuracy.

## Workflows

For goal-oriented usage guides (not just command reference), see **[Agent Guide](docs/AGENT_GUIDE.md)**:

- **[Understand a system](docs/AGENT_GUIDE.md#workflow-1-understand-a-system-before-making-changes)** — map a module, trace symbols, check blast radius
- **[Write an implementation plan](docs/AGENT_GUIDE.md#workflow-2-write-a-concrete-implementation-plan)** — identify contracts, map dependencies, find reusable code
- **[De-bloat a codebase](docs/AGENT_GUIDE.md#workflow-3-clean-up-and-de-bloat-a-codebase)** — prioritized cleanup from dead code to pattern drift
- **[Assess code quality](docs/AGENT_GUIDE.md#workflow-4-assess-code-quality-and-risk)** — health score, complexity hotspots, coupling risks
- **[Verify change impact](docs/AGENT_GUIDE.md#workflow-5-understand-impact-after-making-changes)** — diff impact, transitive blast radius, consumer blast radius

Historical implementation plans and completed cleanup notes live in [`docs/plans/`](docs/plans/).

## Install From npm

Install the published CLI globally from npm:

```bash
npm install -g scip-query@latest
scip-query --version
```

You can also run it without a global install:

```bash
npx scip-query@latest --version
npx scip-query@latest reindex
```

The npm package is published at [`scip-query`](https://www.npmjs.com/package/scip-query). `@latest` should resolve to the newest published version.

## Quick Start

```bash
# Install
npm install -g scip-query@latest
scip-query --version
scip-query check-deps                # verify optional indexers and parser support
scip-query install-skills            # install built-in Codex/Claude skills

# Index your project (auto-detects language)
scip-query reindex

# Start querying
scip-query stats
scip-query health                        # full codebase health report
scip-query symbols src/auth.service.ts
scip-query refs login
scip-query affected login                # transitive blast radius
scip-query dead --min-loc 10
scip-query similar --min-similarity 0.5
scip-query diff-impact                   # what did my changes affect?
```

## Prerequisites

- **Node.js** >= 18
- **scip** CLI - [Install from releases](https://github.com/sourcegraph/scip/releases) (converts index data to SQLite)
- A language-specific SCIP indexer for your project:

| Language | Indexer | Install |
|---|---|---|
| TypeScript / JavaScript / Vue | scip-typescript | `npm install -g @sourcegraph/scip-typescript` |
| Java / Scala / Kotlin | scip-java | [releases](https://github.com/sourcegraph/scip-java/releases) |
| Rust | rust-analyzer | Ships with rust-analyzer (`rust-analyzer scip`) |
| Python | scip-python-plus | `npm install -g scip-python-plus` |
| Go | scip-go | `go install github.com/sourcegraph/scip-go@latest` |
| Ruby | scip-ruby | [releases](https://github.com/sourcegraph/scip-ruby/releases) |
| C / C++ | scip-clang | [releases](https://github.com/sourcegraph/scip-clang/releases) |
| C# / VB | scip-dotnet | [releases](https://github.com/sourcegraph/scip-dotnet/releases) |
| Dart | scip-dart | [releases](https://github.com/nicovince/scip-dart/releases) |
| PHP | scip-php | [releases](https://github.com/nicovince/scip-php/releases) |

For Python, the npm package is `scip-python-plus`. Depending on which version you installed, the executable on your `PATH` may be `scip-python`, `scip-python-plus`, or both. `scip-query` accepts either name.

Vue single-file components (`.vue`) are handled by the JavaScript/TypeScript indexer. `scip-query` extracts the `<script>` block (or `<script setup>`, picking the language from the `lang=` attribute) and parses it as TS/JS so symbol, reference, and import queries cover Vue components alongside regular `.ts`/`.js` files.

## How It Works

1. A SCIP indexer analyzes your source code using the actual compiler/type checker and produces a `index.scip` protobuf file containing symbols, definitions, and references.
2. The `scip` CLI converts the protobuf to a SQLite database (`index.db`).
3. `scip-query` runs SQL queries and language-aware source augmentation against that database to answer questions about your codebase.

Because the index comes from real language tooling, direct symbol, definition, and reference queries are precise, not grep-based approximations. When a language index is missing enough call-site detail for higher-level analyses, `scip-query` can fall back to AST parsing, semantic providers, and identifier recovery so those commands stay useful while still reporting conservative results.

## Configuration

### Per-project config

Run `scip-query init` to generate a `.scipquery.json` in your project root:

```json
{
  "languages": ["typescript"],
  "watch": {
    "enabled": false,
    "debounceMs": 30000,
    "cooldownMs": 60000
  },
  "indexer": {
    "typescript": {
      "pnpmWorkspaces": true
    }
  }
}
```

### Environment variables

| Variable | Purpose |
|---|---|
| `SCIP_QUERY_PROJECT_ROOT` | Override the project root directory |
| `SCIP_QUERY_INDEX_DB` | Override the SQLite database path |
| `SCIP_QUERY_INDEX_SCIP` | Override the SCIP protobuf path |
| `SCIP_QUERY_CACHE_DIR` | Override the cache directory |

### Index storage

By default, indexes are stored in `~/.cache/scip-query/projects/<hash>/` (following XDG conventions). This keeps your project directory clean. Override with the `dbPath` field in `.scipquery.json` or the `SCIP_QUERY_CACHE_DIR` environment variable.

### Gitignore integration

All query results are filtered through your project's `.gitignore`. Build artifacts (`dist/`, `target/`, `__pycache__/`), dependency directories (`node_modules/`, `vendor/`), and virtual environments (`.venv/`) are automatically excluded. If no `.gitignore` exists, sensible defaults are applied.

---

## Command Reference

<!-- BEGIN GENERATED COMMAND REFERENCE -->

This syntax summary is generated from the CLI command descriptors. Keep workflow guidance hand-authored, but keep command syntax, descriptions, and option flags descriptor-owned.

### Indexing

| Command | Description | Options |
|---|---|---|
| `reindex` | Index the codebase and convert to SQLite | `-l, --language <lang>`<br>`--pnpm-workspaces`<br>`--force`<br>`--allow-partial`<br>`--indexer-concurrency <n>` |
| `augment-sources` | Add source files skipped by upstream SCIP indexers to the SQLite documents table | - |
| `augment-vue` | Add compiler-resolved Vue SFC references to the SQLite index using Volar | `--project <tsconfig>` |

### Core

| Command | Description | Options |
|---|---|---|
| `stats` | Show index statistics | - |

### Navigation

| Command | Description | Options |
|---|---|---|
| `files <pattern>` | Find files matching a pattern | - |
| `symbols <file>` | List symbols defined in a file (with line ranges + signatures) | - |
| `methods <className>` | List methods of a class (with line ranges) | - |
| `refs <symbol>` | Find all files referencing a symbol | `--full` |
| `trace <symbol>` | Trace a symbol: definition + all references | `--full` |
| `deps <file>` | Files this file depends on (internal) | - |
| `rdeps <file>` | Files that depend on this file/module | - |
| `system <module>` | Full module map: files, symbols, deps in/out | - |
| `surface <module>` | What symbols consumers actually use from this module | - |
| `imports <file>` | What symbols does this file import? | `--full` |
| `imported-by <symbol>` | Which files import this symbol? | - |
| `outline <file>` | Tree view of symbols in a file (using nesting hierarchy) | - |
| `members <symbol>` | All children of a symbol (methods, fields, nested types) | - |
| `by-kind <kind>` | Find symbols by SCIP kind (class, interface, enum, function, etc.) | `-s, --scope <path>`<br>`-n, --limit <n>` |
| `kind-counts` | Histogram of symbol kinds in the codebase | `-s, --scope <path>` |
| `hierarchy <symbol>` | Show a symbol's ancestry chain (method → class → module) | - |
| `code <symbol>` | Read the source code for a symbol (bounded to its definition range) | `-C, --context <n>` |
| `dataflow <symbol>` | Reference-level dataflow: definition sites, usage sites, producers, consumers | `--full` |
| `slice <symbol>` | Reference-level program slice: what affects this (backward) or what this affects (forward) | `--forward`<br>`--depth <n>`<br>`--full` |

### Cleanup

| Command | Description | Options |
|---|---|---|
| `dead [scope]` | Find dead code and file-internal symbols (no cross-file consumers) | `--min-loc <n>`<br>`--include-tests`<br>`--skip-barrels`<br>`--include-members`<br>`--only-dead`<br>`--only-internal`<br>`--full` |
| `unused-imports <file>` | Find imports not referenced in the same file | `--full` |
| `isolated` | Find completely orphaned symbols (no references at all) | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--full` |
| `similar [symbol]` | Find heuristic function similarity candidates from callee fingerprints | `--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-callees <n>`<br>`--cross-file-only`<br>`--full` |
| `similar-files [file]` | Find heuristic similar-file candidates from dependency profiles | `--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-deps <n>` |
| `similar-chains` | Find heuristic similar-chain candidates from dependency flows | `--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-length <n>`<br>`--max-length <n>` |
| `extract-candidates` | Find heuristic extraction candidates from isolated callee clusters | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--min-callees <n>`<br>`-n, --limit <n>`<br>`--full` |
| `drift [module]` | Detect heuristic drift candidates: unused imports, layer violations, and pattern deviations | `--min-deviation <n>`<br>`--full` |
| `wrapper-candidates` | Find heuristic wrapper candidates only called by one consumer | `-s, --scope <path>`<br>`--max-loc <n>`<br>`-n, --limit <n>`<br>`--full` |
| `passthrough-candidates` | Find heuristic passthrough candidates that forward to one callee | `-s, --scope <path>`<br>`--max-loc <n>`<br>`-n, --limit <n>`<br>`--full` |
| `stale-abstractions` | Find heuristic stale abstraction candidates with 0-1 consumers | `-s, --scope <path>`<br>`--min-loc <n>`<br>`-n, --limit <n>`<br>`--include-low-confidence`<br>`--full` |
| `complexity-hotspots` | Find heuristic complexity hotspot candidates from LOC x fan-in x fan-out | `-s, --scope <path>`<br>`--min-loc <n>`<br>`-n, --limit <n>`<br>`--full` |
| `convergence <symbol1> <symbol2>` | Show what a consolidated version of two similar functions would look like | `--full` |
| `redundant-reexports` | Find barrel re-exports that nobody imports through | `-s, --scope <path>`<br>`-n, --limit <n>` |
| `similar-signatures` | Find functions with near-identical type signatures (same shape) | `-s, --scope <path>`<br>`--min-loc <n>`<br>`-n, --limit <n>`<br>`--full` |

### Graph

| Command | Description | Options |
|---|---|---|
| `hotspots` | Most-referenced symbols in the codebase (choke points) | `-n, --limit <n>`<br>`-s, --scope <path>` |
| `fan-in [symbol]` | How many files reference a symbol (or top fan-in across codebase) | `-n, --limit <n>`<br>`-s, --scope <path>` |
| `fan-out [file]` | How many external symbols a file uses (or top fan-out across codebase) | `-n, --limit <n>`<br>`-s, --scope <path>` |
| `coupling [file1] [file2]` | Coupling between two files, or top coupled pairs in codebase | `-n, --limit <n>`<br>`-s, --scope <path>` |
| `cycles` | Detect circular dependency chains between files | `-s, --scope <path>`<br>`--max-depth <n>` |
| `bottlenecks` | Find coupling hubs: high fan-in AND high fan-out | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-fan-in <n>`<br>`--min-fan-out <n>`<br>`--full` |
| `deep-chains` | Find the longest transitive dependency chains | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-depth <n>` |
| `call-graph <symbol>` | Show incoming callers and outgoing callees for a symbol | `--full` |

### Impact

| Command | Description | Options |
|---|---|---|
| `affected <symbol>` | Transitive closure of symbols that could break if this symbol changes | `--max-depth <n>`<br>`-s, --scope <path>` |
| `change-surface <file>` | Pre-change briefing: exports, consumers, and blast-radius risk | `--full` |
| `diff-impact` | Compute changed symbols and downstream consumers from current git diff | `--base <ref>` |

### Health

| Command | Description | Options |
|---|---|---|
| `health` | Composite codebase health report with prioritized action list | `-s, --scope <path>`<br>`--full`<br>`--json` |
| `complexity <symbol>` | Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees | `--full` |

### Maintenance

| Command | Description | Options |
|---|---|---|
| `install-skills` | Install skills (concrete-plan, scip-explore, scip-debloat, scip-verify, scip-language-playbook) into Claude Code and Codex | - |
| `check-deps` | Check whether scip-query and the detected language indexers are actually runnable | - |
| `init` | Create a .scipquery.json config file for this project | - |
| `watch` | Watch for file changes and reindex automatically | `--debounce <ms>`<br>`--cooldown <ms>` |
| `status` | Show index status for this project | - |

<!-- END GENERATED COMMAND REFERENCE -->


## Programmatic API

Every CLI command is also a TypeScript function. The `queries` namespace exports cover all of them — including the `top*` variants of `fan-in`, `fan-out`, and `coupling`, plus `similarAll` for the cross-codebase mode of `similar`:

```typescript
import {
  ScipDatabase, createGitignoreFilter,
} from 'scip-query';
import {
  health, affected, changeSurface, diffImpact,
  hotspots, similar, dead, convergence,
} from 'scip-query/queries';

const filter = createGitignoreFilter('/path/to/project');
const db = new ScipDatabase({
  dbPath: '/path/to/index.db',
  indexPath: '/path/to/index.scip',
  projectRoot: '/path/to/project',
}, filter);

// Full health report
const report = health(db);
console.log(`Score: ${report.score}/100`);
console.log(`Actions: ${report.actions.length}`);

// Impact analysis
const blast = affected(db, 'login', { maxDepth: 3 });
const brief = changeSurface(db, 'auth.service.ts');
const impact = diffImpact(db, { base: 'main' });

// Consolidation
const pairs = similar(db, 'myFunction', { minSimilarity: 0.5 });
const recipe = convergence(db, 'funcA', 'funcB');

db.close();
```

## License

Apache-2.0
