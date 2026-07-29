# Command Reference

<!-- BEGIN GENERATED COMMAND REFERENCE -->

This syntax summary is generated from the CLI command descriptors. Keep workflow guidance hand-authored, but keep command syntax, descriptions, and option flags descriptor-owned.

Commands with `--json` share three structured modes: plain `--json` emits the stable public envelope, `--json --result-only` emits only the command payload, and `--json --compact` minifies either form for a program. Agents should prefer ordinary human output. See [CLI output modes](CLI_JSON_OUTPUT.md).

Every command accepts `--output-page-size <characters>` and `--output-cursor <cursor>`. Run normally without choosing a page size: oversized human output stays readable text and prints one exact continuation command; oversized JSON prints the exact command that opts into versioned JSON page envelopes.

### Indexing

| Command | Description | Options |
|---|---|---|
| `reindex` | Index the codebase and convert to SQLite | `-l, --language <lang>`<br>`--pnpm-workspaces`<br>`--force`<br>`--allow-partial`<br>`--trust-project-tools`<br>`--install-missing`<br>`--indexer-concurrency <n>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `augment-sources` | Add source files skipped by upstream SCIP indexers to the SQLite documents table | - |
| `augment-vue` | Add compiler-resolved Vue SFC references to the SQLite index using Volar | `--project <tsconfig>` |

### Core

| Command | Description | Options |
|---|---|---|
| `stats` | Show index statistics | `--json`<br>`--result-only`<br>`--compact` |

### Navigation

| Command | Description | Options |
|---|---|---|
| `files <pattern>` | Find files matching a pattern | `--json`<br>`--result-only`<br>`--compact` |
| `methods <className>` | List methods of one exactly resolved class; ambiguity and missing targets fail explicitly | `--json`<br>`--result-only`<br>`--compact` |
| `refs <symbol>` | Find all files referencing a symbol | `--full`<br>`-n, --limit <n>`<br>`--cursor <cursor>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `trace <symbol>` | Trace a symbol: definition + all references | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `deps <file>` | Files this file depends on (internal) | `--json`<br>`--result-only`<br>`--compact` |
| `rdeps <file>` | Files that depend on this file/module | `--json`<br>`--result-only`<br>`--compact` |
| `system <module>` | Full module map: files, symbols, deps in/out | `--json`<br>`--result-only`<br>`--compact` |
| `surface <module>` | What symbols consumers actually use from this module | `--json`<br>`--result-only`<br>`--compact` |
| `imports <file>` | What symbols does this file import? | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `imported-by <symbol>` | Which files import this symbol? | `--json`<br>`--result-only`<br>`--compact` |
| `outline <file>` | Tree view of symbols in a file, with line ranges | `--signatures`<br>`--json`<br>`--result-only`<br>`--compact` |
| `members <symbol>` | All children of a symbol (methods, fields, nested types) | `--json`<br>`--result-only`<br>`--compact` |
| `by-kind <kind>` | Find symbols by SCIP kind (class, interface, enum, function, etc.) | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `kind-counts` | Histogram of symbol kinds in the codebase | `-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `hierarchy <symbol>` | Show a symbol's ancestry chain (method → class → module) | `--json`<br>`--result-only`<br>`--compact` |
| `code <symbol>` | Read the source code for a symbol (bounded to its definition range) | `-C, --context <n>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `dataflow <symbol>` | Reference-level dataflow: definition sites, usage sites, producers, consumers | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `slice <symbol>` | Reference-level program slice: what affects this (backward) or what this affects (forward) | `--forward`<br>`--depth <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Cleanup

| Command | Description | Options |
|---|---|---|
| `dead [scope]` | Find repository-dead code, file-internal symbols, and implicit-usage signals | `--min-loc <n>`<br>`--include-tests`<br>`--skip-barrels`<br>`--include-members`<br>`--only-dead`<br>`--only-internal`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `unused-imports <file>` | Find imports not referenced in the same file | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `isolated` | Find completely orphaned symbols (no references at all) | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `similar [symbol] [other]` | Find heuristic function similarity candidates from callee fingerprints | `--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-callees <n>`<br>`--cross-file-only`<br>`--plan`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `similar-files [file]` | Find heuristic similar-file candidates from dependency profiles | `--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-deps <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `react-component-duplicates [file]` | Find heuristic duplicated React component structure candidates from JSX tags, props, events, and bindings | `--min-similarity <n>`<br>`--min-tokens <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `react-hook-candidates [file]` | Find heuristic React hook extraction candidates from shared state, effects, requests, and handlers | `--min-similarity <n>`<br>`--min-shared-behaviors <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `react-large-component-pressure [file]` | Find heuristic large React component pressure candidates from component lines, JSX structure, and hook behavior | `--min-component-lines <n>`<br>`--min-file-lines <n>`<br>`--min-jsx-tokens <n>`<br>`--min-behavior-tokens <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `vue-component-duplicates [file]` | Find heuristic duplicated Vue component structure candidates from template tags, bindings, slots, and directives | `--min-similarity <n>`<br>`--min-tokens <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `vue-composable-candidates [file]` | Find heuristic Vue composable extraction candidates from shared state, effects, requests, and template bindings | `--min-similarity <n>`<br>`--min-shared-behaviors <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `vue-large-view-pressure [file]` | Find heuristic large Vue view pressure candidates from template, script, style, and external script line counts | `--min-total-lines <n>`<br>`--min-template-lines <n>`<br>`--min-script-lines <n>`<br>`--min-style-lines <n>`<br>`--review-thresholds`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `similar-chains` | Find heuristic similar-chain candidates from dependency flows | `--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-length <n>`<br>`--max-length <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `extract-candidates` | Find heuristic extraction candidates from isolated callee clusters | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--min-callees <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `locality-candidates [symbol-or-file]` | Find directory-locality and ancestry candidates from consumer ownership | `-s, --scope <path>`<br>`--min-consumers <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `cleanup-plan` | Ordered, batched deletion plan: graph-fact dead code plus the cascade candidates it unlocks | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--max-depth <n>`<br>`--verify`<br>`--patch`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `cleanup-apply` | Apply a compiler-verified cleanup-plan batch to the working tree | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--max-depth <n>`<br>`--verified`<br>`--batch <n>`<br>`--all`<br>`--force-dirty`<br>`--full` |
| `recent-duplicates` | Directional duplicate candidates: recent code that re-implements established callable, React, or Vue code | `--window <n>`<br>`--min-similarity <n>`<br>`-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `doc-drift [doc]` | Stale-doc candidates: code the doc references or co-changed with kept changing after the doc stopped | `-n, --limit <n>`<br>`--min-coupling <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `unused-params` | Speculative-generality candidates: trailing parameters no body ever uses (TS/JS) | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `drift [module]` | Detect drift candidates: unused imports and declared architecture violations; pass --architecture for boundary context | `--min-deviation <n>`<br>`--patterns`<br>`--architecture`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `wrapper-candidates` | Find heuristic wrapper candidates only called by one consumer (high false-positive rate on codebases with intentional layering/ambient types — treat as exploration, not findings) | `-s, --scope <path>`<br>`--max-loc <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `passthrough-candidates` | Find heuristic passthrough candidates that forward to one callee | `-s, --scope <path>`<br>`--max-loc <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `stale-abstractions` | Find heuristic stale abstraction candidates with 0-1 consumers (high false-positive rate on codebases with intentional layering/ambient types — treat as exploration, not findings) | `-s, --scope <path>`<br>`--min-loc <n>`<br>`-n, --limit <n>`<br>`--include-low-confidence`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `complexity-hotspots` | Find heuristic complexity hotspot candidates from LOC x fan-in x fan-out | `-s, --scope <path>`<br>`--min-loc <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `convergence <symbol1> <symbol2>` | Deprecated alias for similar <symbol1> <symbol2> --plan | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `redundant-reexports` | Find barrel re-exports that nobody imports through | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `duplicate-bodies` | Find exact duplicate small-body candidates across files | `-s, --scope <path>`<br>`--max-loc <n>`<br>`--min-loc <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `twin-drift` | Twin drift candidates: same-name (or near-name) functions across files with diverged bodies | `-s, --scope <path>`<br>`--min-similarity <n>`<br>`--include-homonyms`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `twin-ab <symbolA> <symbolB>` | Generate a behavioral A/B scaffold comparing two same-concept twins (scip-audit integrity scenario) — a ready-to-fill vitest file, not an auto-executor | `--out <path>`<br>`--force`<br>`--json`<br>`--result-only`<br>`--compact` |
| `not-implemented` | Reachable placeholder stub candidates (throw-stub, TODO+return-default, empty body) — production callers can actually reach these; an unreachable stub is dead's job, not this one's | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `decorative-checkers` | Decorative checker candidates: validate*/verify*/check*/assert*/is*/has* callables with no reachable failure exit anywhere in their body | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `test-quality` | Test-quality candidates: assertion-free it/test bodies, a skipped-test ledger with git-blame age, and mock-echo tests that assert the same literal they stubbed into a mock | `-s, --scope <path>`<br>`-n, --limit <n>`<br>`--rot-days <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `similar-signatures` | Find functions with near-identical type signatures (same shape) | `-s, --scope <path>`<br>`--min-loc <n>`<br>`--max-shape-frequency <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Graph

| Command | Description | Options |
|---|---|---|
| `hotspots` | Most-referenced symbols in the codebase (choke points) | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `fan-in [symbol]` | Count files referencing an exact symbol; top JSON rows include exact symbol identity | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `fan-out [file]` | How many external symbols a file uses (or top fan-out across codebase) | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `coupling [file1] [file2]` | Coupling between two files, or top coupled pairs in codebase | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `cycles` | Detect circular dependency chains between files | `-s, --scope <path>`<br>`--max-depth <n>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `architecture` | Evaluate project-owned architectural boundaries and dependency rules | `-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `bottlenecks` | Find coupling hubs: high fan-in AND high fan-out | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-fan-in <n>`<br>`--min-fan-out <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `deep-chains` | Find the longest condensed dependency-component chains | `-n, --limit <n>`<br>`-s, --scope <path>`<br>`--min-depth <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `call-graph <symbol>` | Show incoming callers and outgoing callees for a symbol | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Impact

| Command | Description | Options |
|---|---|---|
| `affected <symbol>` | Transitive closure of symbols that could break if this symbol changes | `--max-depth <n>`<br>`-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `change-surface <file>` | Pre-change briefing: consumers, published API, operational roots, and explained change risk | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `co-change [file]` | Files that change together in git history without a dependency edge — hidden coupling candidates | `--min-together <n>`<br>`-n, --limit <n>`<br>`--all`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `diff-gate` | Runtime-bounded, single-flight gate for the current diff: architecture regressions plus echo, migration, coordination, doc-drift, unused-param, and new-dead candidates; exit 1 on blocking findings | `--base <ref>`<br>`--min-together <n>`<br>`--max-echo-checks <n>`<br>`--max-helpers <n>`<br>`--baseline`<br>`--full`<br>`--skip <check>`<br>`--hook`<br>`--json`<br>`--result-only`<br>`--compact` |
| `incomplete-migration` | Partially-completed extraction candidates: new helpers in the diff wired into some sites while similar un-migrated sites remain | `--base <ref>`<br>`--min-containment <n>`<br>`--max-helpers <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `diff-impact` | Compute changed symbols and downstream consumers from current git diff | `--base <ref>`<br>`--json`<br>`--result-only`<br>`--compact` |

### Formal Models

| Command | Description | Options |
|---|---|---|
| `tla <operation> [spec]` | TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation | `--map <file>`<br>`--config <file>`<br>`--checker <mode>`<br>`--tla-tools <jar>`<br>`--apalache <binary>`<br>`--length <n>`<br>`--timeout-ms <n>`<br>`--trace <file>`<br>`--next <operator>`<br>`--coverage`<br>`--allow-unknown`<br>`--out <path>`<br>`--module-name <name>`<br>`--force`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Planning

| Command | Description | Options |
|---|---|---|
| `plan-context <target>` | Pre-edit planning context for a symbol, file, or module | `--impact-depth <n>`<br>`--slice-depth <n>`<br>`-s, --scope <path>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Health

| Command | Description | Options |
|---|---|---|
| `self-audit` | Score cheap evidence paths against the best available semantic/source oracle on sampled symbols | `--samples <n>`<br>`-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `health` | Composite codebase health report with prioritized action list | `-s, --scope <path>`<br>`--full`<br>`--baseline`<br>`--write-baseline`<br>`--json`<br>`--result-only`<br>`--compact` |
| `complexity <symbol>` | Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Maintenance

| Command | Description | Options |
|---|---|---|
| `bench` | Benchmark indexing and command runtimes for this repository | `--cold-index`<br>`--include-heavy`<br>`--command <cmd>`<br>`--timeout-ms <n>`<br>`--progress`<br>`--profile`<br>`--profile-out <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `work-audit <profile>` | Rank exact repeated computations in a profiling JSONL file by measured avoidable time | `--top <n>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `install-skills` | Install skills (_shared, scip-query, scip-setup, scip-explore, scip-plan, scip-diagnose, scip-audit, scip-improve, scip-verify) into Claude Code, Codex, and shared agent roots | - |
| `setup-hooks` | Install or refresh project-local Codex and Claude Code lifecycle hooks | `--shared`<br>`--remove`<br>`--force`<br>`--json`<br>`--result-only`<br>`--compact` |
| `check-deps` | Check whether scip-query and the detected language indexers are actually runnable | - |
| `capabilities` | Report which evidence and verification capabilities are available in this project | `--matrix`<br>`--json`<br>`--result-only`<br>`--compact` |
| `capability-matrix` | Deprecated alias for capabilities --matrix | `--json`<br>`--result-only`<br>`--compact` |
| `init` | Create a .scipquery.json config file for this project | - |
| `config-validate` | Validate .scipquery.json, including structured suppressions and declared coupling groups | `--json`<br>`--result-only`<br>`--compact` |
| `suppress <id>` | Record an accepted finding as a file under .scipquery/suppressions/ with a required reason | `--reason <text>`<br>`--reason-code <code>`<br>`--evidence <kind:referent>`<br>`--check <check>`<br>`--file <path>`<br>`--expires-at <iso>`<br>`--replace <revision>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `effectiveness` | Per-check repository telemetry from the committed outcome ledger: verified fixes, suppressions, unresolved findings, observer authority, and anomalies | `--since <window>`<br>`--check <check>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `doctor` | Diagnose config, index freshness, dependency readiness, and project capabilities | `--json`<br>`--result-only`<br>`--compact` |
| `setup` | Bootstrap this project: enable automatic indexing, install agent skills, refresh the index, verify capabilities, and report health | `--guided`<br>`--yes`<br>`--git-hook`<br>`--no-hooks`<br>`--no-skills`<br>`--no-parsers`<br>`--install-missing`<br>`--no-health`<br>`--dossier-dir <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `setup-agent` | Seed agent guidance for this project: AGENTS.md/CLAUDE.md block pointing agents at the scip-query skills and diff gate, plus an optional git pre-commit backstop | `--git-hook` |
| `setup-ci` | Write a GitHub Actions workflow that runs scip-query reindex and diff-gate on pull requests | `--force`<br>`--dry-run` |
| `uninstall` | Remove scip-query-owned skill links, project hooks, and managed agent setup blocks | `--global`<br>`--project`<br>`--dry-run`<br>`--json`<br>`--result-only`<br>`--compact` |
| `watch` | Watch in the foreground or manage the per-project background refresh service | `--daemon`<br>`--status`<br>`--stop`<br>`--debounce <ms>`<br>`--cooldown <ms>`<br>`--git-poll <ms>`<br>`--idle-timeout <ms>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `status` | Show index status for this project | `--capabilities`<br>`--json`<br>`--result-only`<br>`--compact` |

<!-- END GENERATED COMMAND REFERENCE -->

## `analysisBudget` disclosure contract

On a large index (`stats.symbols >= 25,000` or `stats.documents >= 2,500`), commands built on the
shared `budgetedDbCommand`/`budgetedListCommand`/`budgetedTableCommand`/`budgetedReportCommand`/
`budgetedGroupedByFileCommand`/`budgetedSectionedReportCommand` helpers (`src/runtime/commands/
command-execution.ts`) automatically cap their candidate scan and disable semantic (ts-morph)
enrichment, and — unless `--full` is passed — disclose the cap two ways: a stderr notice in human
mode, and an `analysisBudget: { scanLimit, semanticEnrichment, reason }` key at the top level of
the `--json` envelope (`printJsonEnvelope`, same file). This is a general-purpose seam, not
diff-gate-specific: as of this writing it already covers `dead`, `unused-imports`, `isolated`,
`extract-candidates`, `locality-candidates`, `similar`, `similar-signatures`, `drift`,
`convergence`, `duplicate-bodies`, `twin-drift`, `cleanup-plan`, `cleanup-apply`,
`recent-duplicates`, `unused-params`, `complexity-hotspots`, `complexity`, `bottlenecks`,
`imports`, `refs`, `dataflow`, `slice`, `plan-context`, `change-surface`, `incomplete-migration`,
`co-change`, `diff-gate`, and the React/Vue battery commands.

Commands stay on the plain (unbudgeted) `dbCommand`/`listCommand`/`tableCommand`/`reportCommand`
family — and so never emit `analysisBudget` — when their cost model has no candidate-count or
semantic-enrichment knob for the budget to honestly describe: single-symbol/single-file lookups
(`code`, `outline`, `fan-in`, `fan-out`, `coupling`, `twin-ab`), or whole-graph structural queries
with their own independent bound (`cycles`, `deep-chains`). Adding the `analysisBudget` key to one of those
without also making the underlying query respect `scanLimit`/`semantic` would disclose a cap that
isn't real — forbidden by the same "no silent/false disclosure" rule this contract exists to
enforce (see `docs/plans/2026-07-02-followups.md` items 6 and 9).

Followup #6 closed the one confirmed gap in an otherwise-wired battery command: `co-change`
(`src/runtime/query-commands/impact.ts`) used the plain `dbCommand` and never disclosed a budget,
even though its per-pair classification loop in `queries.coChange`
(`src/queries/cleanup/co-change.ts`) does real filesystem/graph work whose cost scales with
candidate-pair count on a large repository. It now flows through `budgetedDbCommand` and
`coChange` accepts a `scanLimit` option that truncates the (already priority-sorted) candidate
pairs before classification, so the disclosed budget is truthful rather than cosmetic.
Composite planning also passes its already-resolved invocation HEAD through `coChange`'s
internal options, keeping history reads on one Git snapshot without another `rev-parse`
subprocess; standalone command behavior is unchanged.
The setup-scope follow-up rechecked this implementation citation; extracting
shared hook outcome recording changed imports in the same runtime module but
did not change the `co-change` budget boundary described here.
