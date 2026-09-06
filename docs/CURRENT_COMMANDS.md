# Current command inventory

The current registry contains **86 commands: 81 public controls and 5 internal transport/worker controls**. Eleven commands were retired from the 97-control inventory used at the start of this sweep. TLA and older removals predate that inventory.

A command is a named CLI operation that accepts selectors or options and returns repository observations or performs a defined maintenance action. An observed relationship records evidence connecting concrete files or symbols. A candidate is a possible cleanup or design issue inferred from a stated pattern; its existence does not prove that refactoring will preserve behavior or improve the design.

For first-use architecture assessment, use `system --source`; for current-source issue scanning, use `health`. Use `search`/`outline`/`code`/`inspect`/`evidence` for the facts a task needs, and `review`, `diff-impact` and applicable architecture checks after changes. The [command decision guide](../skills/scip-query/references/command-guide.md) maps every public control to a question, index requirement and limit. Full flags and examples are in [COMMAND_REFERENCE.md](COMMAND_REFERENCE.md); per-command decisions and test scope are in the [audit ledger](../benchmarks/command-contracts/2026-09-05/ledger.json).

The audit reviews contracts and tests known counterexamples. It does not establish universal accuracy across every language, framework or runtime convention. In particular, directory proximity and shared names do not prove conceptual ownership, candidate duplication does not prove interchangeability, and static relationships do not prove runtime reachability. CRAP requires source-matched test coverage; absent coverage is reported as unavailable.

## Public controls

| Command | Purpose |
| --- | --- |
| `review` | Review current TS/JS changes against a Git commit, including new and untracked functions |
| `reindex` | Index the codebase and convert to SQLite |
| `augment-sources` | Add source files skipped by upstream SCIP indexers to the SQLite documents table |
| `augment-vue` | Add compiler-resolved Vue SFC references to the SQLite index using Volar |
| `stats` | Show index statistics |
| `files` | Find current project files matching a path pattern |
| `session` | Show evidence already delivered in this agent exploration session |
| `inspect` | Batch related searches, symbols, and source locations into one deduplicated source packet |
| `search` | Count current project text matches and preview a bounded, recoverable identity and source manifest |
| `methods` | List methods of one exactly resolved class; ambiguity and missing targets fail explicitly |
| `refs` | Find all files referencing a symbol |
| `evidence` | Traverse selected typed relationships around exact referents; recover source separately when needed |
| `deps` | Files this file depends on (internal) |
| `rdeps` | Files that depend on this file/module |
| `system` | Indexed module summary; `--source` adds a current TS/JS module inventory, export declarations, imports, consumers, policy and findings without an index |
| `surface` | What symbols consumers actually use from this module |
| `dead` | Find repository-dead code, file-internal symbols, and implicit-usage signals |
| `hotspots` | Rank symbols by referencing chunks, or incoming evidence rows when SCIP mentions are unavailable |
| `imports` | What symbols does this file import? |
| `imported-by` | Which files import this symbol? |
| `unused-imports` | Find imports not referenced in the same file |
| `outline` | Tree view of symbols in a file, with line ranges |
| `members` | All children of a symbol (methods, fields, nested types) |
| `fan-in` | Count files referencing an exact symbol; top JSON rows include exact symbol identity |
| `fan-out` | How many external symbols a file uses (or top fan-out across codebase) |
| `coupling` | Count shared-symbol coupling between two files, or rank file pairs by that metric |
| `cycles` | Find every cyclic file-dependency component and show one deterministic witness for each |
| `architecture` | Evaluate project-owned architectural boundaries and dependency rules |
| `bottlenecks` | Rank coordination hubs by incoming evidence files × outgoing cross-file callable targets |
| `by-kind` | Find symbols by SCIP kind (class, interface, enum, function, etc.) |
| `kind-counts` | Histogram of symbol kinds in the codebase |
| `dependency-depth` | Find longest paths through the SCC-condensed file dependency graph |
| `hierarchy` | Show indexed lexical owners of a symbol (method → class → module) |
| `entrypoints` | Find callables where control may enter from outside the indexed call graph |
| `entry-map` | Map the complete indexed call graph from one detected entry point, collapsed by file |
| `call-graph` | Show static may-call edges with exact/candidate evidence and explicit blind spots |
| `similar` | Find heuristic function similarity candidates from callee fingerprints |
| `similar-files` | Find heuristic similar-file candidates from dependency profiles |
| `react-component-duplicates` | Find heuristic duplicated React component structure candidates from JSX tags, props, events, and bindings |
| `react-hook-candidates` | Find heuristic React hook extraction candidates from shared state, effects, requests, and handlers |
| `react-large-component-pressure` | Find heuristic large React component pressure candidates from component lines, JSX structure, and hook behavior |
| `vue-component-duplicates` | Find heuristic duplicated Vue component structure candidates from template tags, bindings, slots, and directives |
| `vue-composable-candidates` | Find heuristic Vue composable extraction candidates from shared state, effects, requests, and template bindings |
| `vue-large-view-pressure` | Find heuristic large Vue view pressure candidates from template, script, style, and external script line counts |
| `locality-candidates` | Find directory-locality and ancestry candidates from consumer ownership |
| `affected` | Conservative reverse caller/reference closure of symbols that may be impacted by a change |
| `change-surface` | Pre-change briefing: consumers, published API, operational roots, and explained change risk |
| `cleanup-plan` | Ordered, batched deletion plan: graph-fact dead code plus the cascade candidates it unlocks |
| `co-change` | Files that change together in git history without a dependency edge — hidden coupling candidates |
| `recent-duplicates` | Similarity candidates in recently added files, oriented by file age; function creation time is not known |
| `doc-drift` | Stale-doc candidates: code the doc references or co-changed with kept changing after the doc stopped |
| `unused-params` | Speculative-generality candidates: trailing parameters no body ever uses (TS/JS) |
| `incomplete-migration` | Partially-completed extraction candidates: new helpers in the diff wired into some sites while similar un-migrated sites remain |
| `context` | Compiler-backed context for a symbol, file, or module |
| `drift` | Detect drift candidates: unused imports and declared architecture violations; pass --architecture for boundary context |
| `passthrough-candidates` | Find heuristic passthrough candidates that forward to one callee |
| `slice-cohesion` | Find low-cohesion candidates from backward slices: outputs whose statements never meet are separate local computations |
| `code` | Read exact definitions, line ranges, or file export surfaces |
| `complexity` | Per-symbol complexity: branches, cyclomatic estimate, fan-in/out, callees |
| `dependence-slice` | Slice one variable occurrence through function-local value and control dependencies |
| `redundant-reexports` | Find re-export candidates with no resolved local source imports or re-exports; external use is unknown |
| `duplicate-bodies` | Find exact duplicate small-body candidates across files |
| `twin-drift` | Twin drift candidates: same-name (or near-name) functions across files with diverged bodies |
| `not-implemented` | Placeholder candidates with observed consumer or entry-surface evidence: throw-stub, TODO plus default return, or empty body |
| `decorative-checkers` | Checker candidates lacking detected explicit failure syntax; implicit exceptions and property effects are not proved absent |
| `test-quality` | Test-quality candidates: assertion-free it/test bodies, a skipped-test ledger with git-blame age, and mock-echo tests that assert the same literal they stubbed into a mock |
| `similar-signatures` | Group functions by normalized signature text; shared type identity or responsibility is not established |
| `diff-impact` | Map changed symbols and downstream consumers from the current git diff |
| `health` | Find concrete TS/JS complexity, duplication, and dependency issues without an index |
| `install-skills` | Install the six agent workflows into Claude Code, Codex, and shared agent roots |
| `check-deps` | Check whether scip-query and the detected language indexers are runnable |
| `capabilities` | Report which mapping and analysis capabilities are available in this project |
| `init` | Create a .scipquery.json configuration file for this project |
| `config-validate` | Validate .scipquery.json, structured suppressions, architecture, and coupling groups |
| `suppress` | Record an accepted finding under .scipquery/suppressions with a required reason |
| `doctor` | Diagnose configuration, index freshness, dependencies, and project capabilities |
| `setup` | Install skills, write agent guidance, refresh the index, and report readiness |
| `setup-agent` | Write concise scip-query mapping and cleanup guidance to AGENTS.md and CLAUDE.md |
| `uninstall` | Remove selected scip-query-owned skills or project guidance |
| `watch` | Watch in the foreground or manage the project refresh service |
| `status` | Show index status for this project |

## Internal controls

These serve continuation or worker protocols, rather than additional exploration questions.

| Command | Purpose |
| --- | --- |
| `continue` | Continue an immutable output snapshot |
| `hook-architecture-stop` | Internal architecture-only Stop hook |
| `__diff-impact-batch` | Internal diff-impact batch worker |
| `__health-phase` | Internal health phase worker |
| `__health-semantic-prewarm` | Internal health semantic prewarm worker |

## Retired in this sweep

- `trace`: Retire overlapping definition/reference CLI and service fast path; refs/code/inspect/evidence cover its work without the unsupported all-call predicate guarantee. Internal source assembly remains for context/inspect, ineligible for absence and universal callsite claims.
- `reference-neighborhood`: remove
- `value-flow`: Remove redundant dataflow projection wrapper. Its only-proved description contradicts candidate edges passed through from graphEvidence. Retain evidence --edge dataflow with explicit direction/depth and dependence-slice.
- `reference-reachability`: remove
- `isolated`: Remove: unused-code subset with no distinct action; overlapping health counts, and missing same-file strict callers. Use dead and explicit evidence projections.
- `similar-chains`: Scores filtered dependency paths but renders original paths/divergence offsets; undisclosed 500-chain and limit*10 pair enumeration. Explicit dependency evidence and dependency-depth provide actual structural facts.
- `extract-candidates`: Occurrence-range regionLocalFlow cannot prove extraction inputs/outputs across branches, scopes and aliases; recommendations assert exact parameter counts. Use dependence-slice and slice-cohesion within their disclosed local model.
- `wrapper-candidates`: remove
- `stale-abstractions`: remove
- `complexity-hotspots`: remove
- `self-audit`: Measures file-set agreement between overlapping evidence providers, not symbol correctness; two wrong targets in the same file can agree. Independent known-answer tests replace the accuracy claim.

Use ordinary invocation to check that a command exists. Commander may display root help for an unknown name followed by `--help`; that exit is not command validation. Every retirement is checked with an ordinary invocation.
