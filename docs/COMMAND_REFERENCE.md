# Command reference

This syntax catalog is generated from the CLI command descriptors. Use
`scip-query context <target>` as the normal starting point. Focused graph and
detector commands are an advanced surface for a named unresolved question.

<!-- BEGIN GENERATED COMMAND REFERENCE -->

This syntax summary is generated from the CLI command descriptors. Keep workflow guidance hand-authored, but keep command syntax, descriptions, and option flags descriptor-owned.

Commands with `--json` share three structured modes: plain `--json` emits the stable public envelope, `--json --result-only` emits only the command payload, and `--json --compact` minifies either form for a program. Agents should prefer ordinary human output. See [CLI output modes](CLI_JSON_OUTPUT.md).

Every command accepts `--output-page-size <characters>` and `--output-cursor <cursor>`. Run normally without choosing a page size: oversized human output stays readable text and prints one exact continuation command; oversized JSON prints the exact command that opts into versioned JSON page envelopes.
Exact code, definition, and source-inspection units always render whole. Cross-command source citations are off by default; an explicit `SCIP_QUERY_SESSION` may replace only wholly prior-emitted locating previews. Partially covered previews render whole. Use global `--reemit` only to recover a cited preview that is no longer in context.

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
| `files <pattern>` | Find current project files matching a path pattern | `--json`<br>`--result-only`<br>`--compact` |
| `session` | Show source ranges already delivered in this agent exploration session | `--reset` |
| `inspect` | Batch related searches, symbols, and source locations into one deduplicated source packet | `--search <text>`<br>`--symbol <symbol>`<br>`--at <file:line>`<br>`-s, --scope <path>`<br>`-C, --context <n>`<br>`-n, --limit <n>`<br>`--max-units <n>`<br>`--max-characters <n>`<br>`--view <view>`<br>`--unit-lines <n>`<br>`--total-lines <n>`<br>`--include <part>`<br>`--evidence-budget <channel=n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `search <text>` | Count current project text matches and preview a bounded, recoverable identity and source manifest | `-s, --scope <path>`<br>`-C, --context <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--regexp`<br>`-i, --ignore-case`<br>`--json`<br>`--result-only`<br>`--compact` |
| `methods <className>` | List methods of one exactly resolved class; ambiguity and missing targets fail explicitly | `--json`<br>`--result-only`<br>`--compact` |
| `refs <symbol>` | Find all files referencing a symbol | `--full`<br>`-n, --limit <n>`<br>`--cursor <cursor>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `trace <symbol>` | Trace a symbol: definition + all references | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `evidence <symbol>` | Compose related source for one exact symbol in a single evidence view | `--include <part>`<br>`-C, --context <n>`<br>`--related-source-lines <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
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
| `code <selectors...>` | Read exact definitions, ranges with local call closure, or file export surfaces | `-C, --context <n>`<br>`--members <exported|all>`<br>`--json`<br>`--result-only`<br>`--compact` |
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
| `twin-ab <symbolA> <symbolB>` | Generate a behavioral A/B scaffold comparing two same-concept twins (cleanup integrity scenario) — a ready-to-fill vitest file, not an auto-executor | `--out <path>`<br>`--force`<br>`--json`<br>`--result-only`<br>`--compact` |
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
| `entrypoints [text]` | Find callables where control may enter from outside the indexed call graph | `-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `entry-map <entry>` | Map the complete indexed call graph from one detected entry point, collapsed by file | `--expand <region-id>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `system-map` | Map structural regions, compiler relationships, and exact runtime boundaries from explicit anchors | `--search <literal>`<br>`--symbol <symbol>`<br>`--depth <n>`<br>`--relation <kind>`<br>`--evidence-floor <floor>`<br>`--topology-characters <n>`<br>`--source-scope <scope>`<br>`--expand <region-id>`<br>`--frontier <frontier-id>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `call-graph <symbol>` | Show incoming callers and outgoing callees for a symbol | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Impact

| Command | Description | Options |
|---|---|---|
| `affected <symbol>` | Transitive closure of symbols that could break if this symbol changes | `--full`<br>`--max-depth <n>`<br>`-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `change-surface <file>` | Pre-change briefing: consumers, published API, operational roots, and explained change risk | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `co-change [file]` | Files that change together in git history without a dependency edge — hidden coupling candidates | `--min-together <n>`<br>`-n, --limit <n>`<br>`--all`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `incomplete-migration` | Partially-completed extraction candidates: new helpers in the diff wired into some sites while similar un-migrated sites remain | `--base <ref>`<br>`--min-containment <n>`<br>`--max-helpers <n>`<br>`-n, --limit <n>`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `diff-impact` | Map changed symbols and downstream consumers from the current git diff | `--base <ref>`<br>`--json`<br>`--result-only`<br>`--compact` |

### Formal Models

| Command | Description | Options |
|---|---|---|
| `tla <operation> [spec]` | TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation | `--map <file>`<br>`--config <file>`<br>`--checker <mode>`<br>`--tla-tools <jar>`<br>`--apalache <binary>`<br>`--length <n>`<br>`--timeout-ms <n>`<br>`--trace <file>`<br>`--next <operator>`<br>`--coverage`<br>`--allow-unknown`<br>`--out <path>`<br>`--module-name <name>`<br>`--force`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Exploration

| Command | Description | Options |
|---|---|---|
| `context <target>` | Compiler-backed context for a symbol, file, or module | `--impact-depth <n>`<br>`--slice-depth <n>`<br>`-s, --scope <path>`<br>`-n, --limit <n>`<br>`--detail`<br>`--full`<br>`--json`<br>`--result-only`<br>`--compact` |

### Health

| Command | Description | Options |
|---|---|---|
| `self-audit` | Score cheap evidence paths against the best available semantic/source oracle on sampled symbols | `--samples <n>`<br>`-s, --scope <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `complexity <symbol>` | Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees | `--full`<br>`--json`<br>`--result-only`<br>`--compact` |
| `health` | Composite repository health report with React, Vue, and general cleanup findings | `-s, --scope <path>`<br>`--full`<br>`--baseline`<br>`--write-baseline`<br>`--json`<br>`--result-only`<br>`--compact` |

### Maintenance

| Command | Description | Options |
|---|---|---|
| `install-skills` | Install skills (scip-query, scip-explore, concrete-plan) into Claude Code, Codex, and shared agent roots | - |
| `check-deps` | Check whether scip-query and the detected language indexers are runnable | - |
| `capabilities` | Report which mapping and analysis capabilities are available in this project | `--matrix`<br>`--json`<br>`--result-only`<br>`--compact` |
| `init` | Create a .scipquery.json configuration file for this project | - |
| `config-validate` | Validate .scipquery.json, structured suppressions, architecture, and coupling groups | `--json`<br>`--result-only`<br>`--compact` |
| `suppress <id>` | Record an accepted finding under .scipquery/suppressions with a required reason | `--reason <text>`<br>`--reason-code <code>`<br>`--evidence <kind:referent>`<br>`--check <check>`<br>`--file <path>`<br>`--expires-at <iso>`<br>`--replace <revision>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `doctor` | Diagnose configuration, index freshness, dependencies, and project capabilities | `--json`<br>`--result-only`<br>`--compact` |
| `setup` | Install skills, write agent guidance, refresh the index, and report repository health | `--guided`<br>`--yes`<br>`--no-skills`<br>`--no-parsers`<br>`--install-missing`<br>`--no-health`<br>`--dossier-dir <path>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `setup-agent` | Write concise scip-query mapping and cleanup guidance to AGENTS.md and CLAUDE.md | - |
| `uninstall` | Remove selected scip-query-owned skills or project guidance | `--global`<br>`--project`<br>`--dry-run`<br>`--verbose`<br>`--json`<br>`--result-only`<br>`--compact` |
| `watch` | Watch in the foreground or manage the project refresh service | `--daemon`<br>`--status`<br>`--stop`<br>`--debounce <ms>`<br>`--cooldown <ms>`<br>`--git-poll <ms>`<br>`--idle-timeout <ms>`<br>`--json`<br>`--result-only`<br>`--compact` |
| `status` | Show index status for this project | `--capabilities`<br>`--json`<br>`--result-only`<br>`--compact` |

<!-- END GENERATED COMMAND REFERENCE -->
