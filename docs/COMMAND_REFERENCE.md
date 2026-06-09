# Command Reference

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
| `methods <className>` | List methods of a class (with line ranges) | - |
| `refs <symbol>` | Find all files referencing a symbol | `--full` |
| `trace <symbol>` | Trace a symbol: definition + all references | `--full` |
| `deps <file>` | Files this file depends on (internal) | - |
| `rdeps <file>` | Files that depend on this file/module | - |
| `system <module>` | Full module map: files, symbols, deps in/out | - |
| `surface <module>` | What symbols consumers actually use from this module | - |
| `imports <file>` | What symbols does this file import? | `--full` |
| `imported-by <symbol>` | Which files import this symbol? | - |
| `outline <file>` | Tree view of symbols in a file, with line ranges | `--signatures` |
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
| `cleanup-plan` | Ordered, batched deletion plan: graph-fact dead code plus the cascade candidates it unlocks | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--max-depth <n>`<br>`--full` |
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
| `co-change [file]` | Files that change together in git history without a dependency edge — hidden coupling candidates | `--min-together <n>`<br>`-n, --limit <n>`<br>`--all` |
| `diff-impact` | Compute changed symbols and downstream consumers from current git diff | `--base <ref>` |

### Planning

| Command | Description | Options |
|---|---|---|
| `plan-context <target>` | Pre-edit planning context for a symbol, file, or module | `--impact-depth <n>`<br>`--slice-depth <n>`<br>`-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full` |

### Health

| Command | Description | Options |
|---|---|---|
| `self-audit` | Score the cheap evidence paths against the TypeScript compiler oracle on sampled symbols | `--samples <n>`<br>`-s, --scope <path>` |
| `health` | Composite codebase health report with prioritized action list | `-s, --scope <path>`<br>`--full`<br>`--json`<br>`--baseline`<br>`--write-baseline` |
| `complexity <symbol>` | Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees | `--full` |

### Maintenance

| Command | Description | Options |
|---|---|---|
| `install-skills` | Install skills (concrete-plan, scip-explore, scip-debloat, scip-maintainability, scip-verify, scip-language-playbook) into Claude Code, Codex, and shared agent roots | - |
| `check-deps` | Check whether scip-query and the detected language indexers are actually runnable | - |
| `init` | Create a .scipquery.json config file for this project | - |
| `watch` | Watch for file changes and reindex automatically | `--debounce <ms>`<br>`--cooldown <ms>` |
| `status` | Show index status for this project | - |

<!-- END GENERATED COMMAND REFERENCE -->
