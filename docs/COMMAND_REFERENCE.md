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
| `stats` | Show index statistics | `--json` |

### Navigation

| Command | Description | Options |
|---|---|---|
| `files <pattern>` | Find files matching a pattern | `--json` |
| `methods <className>` | List methods of a class (with line ranges) | `--json` |
| `refs <symbol>` | Find all files referencing a symbol | `--full`<br>`--json` |
| `trace <symbol>` | Trace a symbol: definition + all references | `--full`<br>`--json` |
| `deps <file>` | Files this file depends on (internal) | `--json` |
| `rdeps <file>` | Files that depend on this file/module | `--json` |
| `system <module>` | Full module map: files, symbols, deps in/out | `--json` |
| `surface <module>` | What symbols consumers actually use from this module | `--json` |
| `imports <file>` | What symbols does this file import? | `--full`<br>`--json` |
| `imported-by <symbol>` | Which files import this symbol? | `--json` |
| `outline <file>` | Tree view of symbols in a file, with line ranges | `--signatures`<br>`--json` |
| `members <symbol>` | All children of a symbol (methods, fields, nested types) | `--json` |
| `by-kind <kind>` | Find symbols by SCIP kind (class, interface, enum, function, etc.) | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json` |
| `kind-counts` | Histogram of symbol kinds in the codebase | `-s, --scope <path>`<br>`--json` |
| `hierarchy <symbol>` | Show a symbol's ancestry chain (method → class → module) | `--json` |
| `code <symbol>` | Read the source code for a symbol (bounded to its definition range) | `-C, --context <n>`<br>`--json` |
| `dataflow <symbol>` | Reference-level dataflow: definition sites, usage sites, producers, consumers | `--full`<br>`--json` |
| `slice <symbol>` | Reference-level program slice: what affects this (backward) or what this affects (forward) | `--forward`<br>`--depth <n>`<br>`--full`<br>`--json` |

### Cleanup

| Command | Description | Options |
|---|---|---|
| `dead [scope]` | Find dead code and file-internal symbols (no cross-file consumers) | `--min-loc <n>`<br>`--include-tests`<br>`--skip-barrels`<br>`--include-members`<br>`--only-dead`<br>`--only-internal`<br>`--full`<br>`--json` |
| `unused-imports <file>` | Find imports not referenced in the same file | `--full`<br>`--json` |
| `isolated` | Find completely orphaned symbols (no references at all) | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--full`<br>`--json` |
| `similar [symbol] [other]` | Find heuristic function similarity candidates from callee fingerprints | `--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-callees <n>`<br>`--cross-file-only`<br>`--plan`<br>`--full`<br>`--json` |
| `similar-files [file]` | Find heuristic similar-file candidates from dependency profiles | `--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-deps <n>`<br>`--full`<br>`--json` |
| `react-component-duplicates [file]` | Find heuristic duplicated React component structure candidates from JSX tags, props, events, and bindings | `--min-similarity <n>`<br>`--min-tokens <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json` |
| `react-hook-candidates [file]` | Find heuristic React hook extraction candidates from shared state, effects, requests, and handlers | `--min-similarity <n>`<br>`--min-shared-behaviors <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json` |
| `react-large-component-pressure [file]` | Find heuristic large React component pressure candidates from component lines, JSX structure, and hook behavior | `--min-component-lines <n>`<br>`--min-file-lines <n>`<br>`--min-jsx-tokens <n>`<br>`--min-behavior-tokens <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json` |
| `vue-component-duplicates [file]` | Find heuristic duplicated Vue component structure candidates from template tags, bindings, slots, and directives | `--min-similarity <n>`<br>`--min-tokens <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json` |
| `vue-composable-candidates [file]` | Find heuristic Vue composable extraction candidates from shared state, effects, requests, and template bindings | `--min-similarity <n>`<br>`--min-shared-behaviors <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json` |
| `vue-large-view-pressure [file]` | Find heuristic large Vue view pressure candidates from template, script, style, and external script line counts | `--min-total-lines <n>`<br>`--min-template-lines <n>`<br>`--min-script-lines <n>`<br>`--min-style-lines <n>`<br>`--review-thresholds`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json` |
| `similar-chains` | Find heuristic similar-chain candidates from dependency flows | `--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-length <n>`<br>`--max-length <n>`<br>`--full`<br>`--json` |
| `extract-candidates` | Find heuristic extraction candidates from isolated callee clusters | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--min-callees <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json` |
| `locality-candidates [symbol-or-file]` | Find directory-locality and ancestry candidates from consumer ownership | `-s, --scope <path>`<br>`--min-consumers <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json` |
| `cleanup-plan` | Ordered, batched deletion plan: graph-fact dead code plus the cascade candidates it unlocks | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--max-depth <n>`<br>`--verify`<br>`--patch`<br>`--json`<br>`--full` |
| `cleanup-apply` | Apply a compiler-verified cleanup-plan batch to the working tree | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--max-depth <n>`<br>`--verified`<br>`--batch <n>`<br>`--all`<br>`--force-dirty`<br>`--full` |
| `recent-duplicates` | Directional duplicate candidates: recent code that re-implements established callable, React, or Vue code | `--window <n>`<br>`--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json` |
| `doc-drift [doc]` | Stale-doc candidates: code the doc references or co-changed with kept changing after the doc stopped | `-n, --limit <n>`<br>`--min-coupling <n>`<br>`--full`<br>`--json` |
| `unused-params` | Speculative-generality candidates: trailing parameters no body ever uses (TS/JS) | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json` |
| `drift [module]` | Detect heuristic drift candidates: unused imports and layer violations by default; pass --patterns for pattern deviations too | `--min-deviation <n>`<br>`--patterns`<br>`-n, --limit <n>`<br>`--full`<br>`--json` |
| `wrapper-candidates` | Find heuristic wrapper candidates only called by one consumer (high false-positive rate on codebases with intentional layering/ambient types — treat as exploration, not findings) | `-s, --scope <path>`<br>`--max-loc <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json` |
| `passthrough-candidates` | Find heuristic passthrough candidates that forward to one callee | `-s, --scope <path>`<br>`--max-loc <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json` |
| `stale-abstractions` | Find heuristic stale abstraction candidates with 0-1 consumers (high false-positive rate on codebases with intentional layering/ambient types — treat as exploration, not findings) | `-s, --scope <path>`<br>`--min-loc <n>`<br>`-n, --limit <n>`<br>`--include-low-confidence`<br>`--full`<br>`--json` |
| `complexity-hotspots` | Find heuristic complexity hotspot candidates from LOC x fan-in x fan-out | `-s, --scope <path>`<br>`--min-loc <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json` |
| `convergence <symbol1> <symbol2>` | Deprecated alias for similar <symbol1> <symbol2> --plan | `--full`<br>`--json` |
| `redundant-reexports` | Find barrel re-exports that nobody imports through | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json` |
| `duplicate-bodies` | Find exact duplicate small-body candidates across files | `-s, --scope <path>`<br>`--max-loc <n>`<br>`--min-loc <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json` |
| `twin-drift` | Twin drift candidates: same-name (or near-name) functions across files with diverged bodies | `-s, --scope <path>`<br>`--min-similarity <n>`<br>`--include-homonyms`<br>`-n, --limit <n>`<br>`--full`<br>`--json` |
| `similar-signatures` | Find functions with near-identical type signatures (same shape) | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--max-shape-frequency <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json` |

### Graph

| Command | Description | Options |
|---|---|---|
| `hotspots` | Most-referenced symbols in the codebase (choke points) | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json` |
| `fan-in [symbol]` | How many files reference a symbol (or top fan-in across codebase) | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json` |
| `fan-out [file]` | How many external symbols a file uses (or top fan-out across codebase) | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json` |
| `coupling [file1] [file2]` | Coupling between two files, or top coupled pairs in codebase | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json` |
| `cycles` | Detect circular dependency chains between files | `-s, --scope <path>`<br>`--max-depth <n>`<br>`--json` |
| `bottlenecks` | Find coupling hubs: high fan-in AND high fan-out | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-fan-in <n>`<br>`--min-fan-out <n>`<br>`--full`<br>`--json` |
| `deep-chains` | Find the longest transitive dependency chains | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-depth <n>`<br>`--full`<br>`--json` |
| `call-graph <symbol>` | Show incoming callers and outgoing callees for a symbol | `--full`<br>`--json` |

### Impact

| Command | Description | Options |
|---|---|---|
| `affected <symbol>` | Transitive closure of symbols that could break if this symbol changes | `--max-depth <n>`<br>`-s, --scope <path>`<br>`--json` |
| `change-surface <file>` | Pre-change briefing: exports, consumers, and blast-radius risk | `--full`<br>`--json` |
| `co-change [file]` | Files that change together in git history without a dependency edge — hidden coupling candidates | `--min-together <n>`<br>`-n, --limit <n>`<br>`--all`<br>`--full`<br>`--json` |
| `diff-gate` | Gate the current diff: echo candidates, incomplete migrations, missing co-change partners, unedited twin partners (advisory), uncited doc updates, unused params, new dead symbols; exit 1 on blocking findings | `--base <ref>`<br>`--min-together <n>`<br>`--max-echo-checks <n>`<br>`--max-helpers <n>`<br>`--baseline`<br>`--full`<br>`--skip <check>`<br>`--hook`<br>`--json` |
| `incomplete-migration` | Partially-completed extraction candidates: new helpers in the diff wired into some sites while similar un-migrated sites remain | `--base <ref>`<br>`--min-containment <n>`<br>`--max-helpers <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json` |
| `diff-impact` | Compute changed symbols and downstream consumers from current git diff | `--base <ref>`<br>`--json` |

### Formal Models

| Command | Description | Options |
|---|---|---|
| `tla <operation> [spec]` | TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation | `--map <file>`<br>`--config <file>`<br>`--checker <mode>`<br>`--tla-tools <jar>`<br>`--apalache <binary>`<br>`--length <n>`<br>`--timeout-ms <n>`<br>`--trace <file>`<br>`--next <operator>`<br>`--allow-unknown`<br>`--out <path>`<br>`--module-name <name>`<br>`--force`<br>`--full`<br>`--json` |

### Planning

| Command | Description | Options |
|---|---|---|
| `plan-context <target>` | Pre-edit planning context for a symbol, file, or module | `--impact-depth <n>`<br>`--slice-depth <n>`<br>`-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json` |

### Health

| Command | Description | Options |
|---|---|---|
| `self-audit` | Score cheap evidence paths against the best available semantic/source oracle on sampled symbols | `--samples <n>`<br>`-s, --scope <path>`<br>`--json` |
| `health` | Composite codebase health report with prioritized action list | `-s, --scope <path>`<br>`--full`<br>`--json`<br>`--baseline`<br>`--write-baseline` |
| `complexity <symbol>` | Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees | `--full`<br>`--json` |

### Maintenance

| Command | Description | Options |
|---|---|---|
| `bench` | Benchmark indexing and command runtimes for this repository | `--json`<br>`--cold-index`<br>`--include-heavy`<br>`--command <cmd>`<br>`--timeout-ms <n>`<br>`--progress`<br>`--profile`<br>`--profile-out <path>` |
| `install-skills` | Install skills (_shared, scip-query, scip-setup, scip-cleanup-audit, scip-cleanup-improve, scip-integrity-audit, scip-twin-drift, scip-claim-audit, scip-probe-reachability, scip-hyper-optimization, scip-api-impact, concrete-plan, scip-conductor, scip-debug, scip-explore, scip-triage-issue, scip-diagram, scip-doc-reconcile, scip-directory-architecture, scip-maintainability, scip-react-maintainability, scip-vue-maintainability, scip-verify, scip-language-playbook, tla-model-system) into Claude Code, Codex, and shared agent roots | - |
| `setup-hooks` | Install or refresh project-local Codex and Claude Code lifecycle hooks | `--shared`<br>`--remove`<br>`--force`<br>`--json` |
| `check-deps` | Check whether scip-query and the detected language indexers are actually runnable | - |
| `capabilities` | Report which evidence and verification capabilities are available in this project | `--matrix`<br>`--json` |
| `capability-matrix` | Deprecated alias for capabilities --matrix | `--json` |
| `init` | Create a .scipquery.json config file for this project | - |
| `config-validate` | Validate .scipquery.json, including structured suppressions and declared coupling groups | `--json` |
| `suppress <id>` | Record an accepted finding in .scipquery.json with a required reason | `--reason <text>`<br>`--check <check>`<br>`--file <path>`<br>`--expires-at <iso>`<br>`--json` |
| `doctor` | Diagnose config, index freshness, dependency readiness, and project capabilities | `--json` |
| `setup` | Bootstrap this project: install agent skills, refresh the index, verify capabilities, and report health | `--git-hook`<br>`--no-hooks`<br>`--dossier-dir <path>`<br>`--json` |
| `setup-agent` | Seed agent guidance for this project: AGENTS.md/CLAUDE.md block pointing agents at the scip-query skills and diff gate, plus an optional git pre-commit backstop | `--git-hook` |
| `setup-ci` | Write a GitHub Actions workflow that runs scip-query reindex and diff-gate on pull requests | `--force`<br>`--dry-run` |
| `uninstall` | Remove scip-query-owned skill links, project hooks, and managed agent setup blocks | `--global`<br>`--project`<br>`--dry-run`<br>`--json` |
| `watch` | Watch for file changes in the foreground and reindex automatically | `--debounce <ms>`<br>`--cooldown <ms>`<br>`--git-poll <ms>` |
| `status` | Show index status for this project | `--json`<br>`--capabilities` |

<!-- END GENERATED COMMAND REFERENCE -->
